import type { ProcessRunner } from "./runner.js";
import { requireSuccess } from "./runner.js";
import { canonicalExecutable } from "./executable.js";

const SHA = /^[0-9a-f]{40,64}$/u;

export interface Repository {
  owner: string;
  repo: string;
}

export interface HostIssue {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: string[];
  htmlUrl: string;
}

export interface PullEvidence {
  number: number;
  merged: boolean;
  mergeSha: string | null;
  headSha: string;
  htmlUrl: string;
}

export interface GitHubPort {
  authStatus(signal?: AbortSignal): Promise<void>;
  findIssuesByMarker(marker: string, signal?: AbortSignal): Promise<readonly HostIssue[]>;
  findIssueByMarker(marker: string, signal?: AbortSignal): Promise<HostIssue | undefined>;
  listRoadmapIssues(signal?: AbortSignal): Promise<readonly HostIssue[]>;
  listSeedMarkerIssues(signal?: AbortSignal): Promise<readonly HostIssue[]>;
  listOpenEnvironmentBlockers(signal?: AbortSignal): Promise<readonly HostIssue[]>;
  assertDefaultBranchContains(
    sha: string,
    branch: string,
    signal?: AbortSignal,
  ): Promise<void>;
  assertCommitDescendsFrom(
    ancestorSha: string,
    descendantSha: string,
    signal?: AbortSignal,
  ): Promise<void>;
  createIssue(
    input: { title: string; body: string; labels: readonly string[] },
    signal?: AbortSignal,
  ): Promise<HostIssue>;
  updateIssue(
    number: number,
    input: {
      title?: string;
      state?: "open" | "closed";
      labels?: readonly string[];
      body?: string;
    },
    signal?: AbortSignal,
  ): Promise<HostIssue>;
  createComment(number: number, body: string, signal?: AbortSignal): Promise<void>;
  findMergedPullForIssue(number: number, signal?: AbortSignal): Promise<PullEvidence | undefined>;
}

export class GhClient implements GitHubPort {
  private readonly executable: string;

  constructor(
    private readonly runner: ProcessRunner,
    private readonly repository: Repository,
    executable: string,
    private readonly environment: Readonly<Record<string, string>> = {},
  ) {
    this.executable = canonicalExecutable(executable, "gh executable");
  }

  async authStatus(signal?: AbortSignal): Promise<void> {
    requireSuccess("gh auth status", await this.runner.run({
      executable: this.executable,
      args: ["auth", "status"],
      env: ghEnvironment(this.environment),
      timeoutMs: 15_000,
      maxOutputBytes: 256 * 1024,
      ...(signal ? { signal } : {}),
    }));
  }

  async findIssueByMarker(
    marker: string,
    signal?: AbortSignal,
  ): Promise<HostIssue | undefined> {
    const matches = await this.findIssuesByMarker(marker, signal);
    if (matches.length > 1) throw new Error(`Duplicate GitHub marker: ${marker}`);
    return matches[0];
  }

  async findIssuesByMarker(
    marker: string,
    signal?: AbortSignal,
  ): Promise<readonly HostIssue[]> {
    singleLine(marker, "marker");
    const query = `repo:${this.repository.owner}/${this.repository.repo} in:body "${marker}"`;
    const result = await this.api(
      "GET",
      `/search/issues?q=${encodeURIComponent(query)}&per_page=100`,
      undefined,
      signal,
    );
    const items = record(result, "search result").items;
    if (!Array.isArray(items)) throw new Error("GitHub search items are invalid");
    return items
      .filter((item) => !record(item, "search item").pull_request)
      .map(parseIssue)
      .filter((issue) => issue.body.includes(marker));
  }

  async listRoadmapIssues(signal?: AbortSignal): Promise<readonly HostIssue[]> {
    const value = await this.api(
      "GET",
      `/repos/${this.repository.owner}/${this.repository.repo}/issues?state=all&labels=cold-start-roadmap&per_page=100`,
      undefined,
      signal,
    );
    if (!Array.isArray(value)) throw new Error("GitHub roadmap issue list is invalid");
    if (value.length >= 100) {
      throw new Error("GitHub roadmap issue inventory exceeds the strict single-page bound");
    }
    return value
      .filter((item) => !record(item, "issue").pull_request)
      .map(parseIssue);
  }

  async listSeedMarkerIssues(signal?: AbortSignal): Promise<readonly HostIssue[]> {
    const query =
      `repo:${this.repository.owner}/${this.repository.repo} in:body ` +
      `"<!-- one-cli:cold-start-seed:"`;
    const result = await this.api(
      "GET",
      `/search/issues?q=${encodeURIComponent(query)}&per_page=100`,
      undefined,
      signal,
    );
    const items = record(result, "seed marker search").items;
    if (!Array.isArray(items)) throw new Error("GitHub seed marker search is invalid");
    const total = record(result, "seed marker search").total_count;
    if (typeof total !== "number" || !Number.isSafeInteger(total) || total !== items.length) {
      throw new Error("GitHub seed marker inventory is truncated or invalid");
    }
    return items
      .filter((item) => !record(item, "search item").pull_request)
      .map(parseIssue)
      .filter((issue) => issue.body.includes("<!-- one-cli:cold-start-seed:"));
  }

  async listOpenEnvironmentBlockers(signal?: AbortSignal): Promise<readonly HostIssue[]> {
    const query =
      `repo:${this.repository.owner}/${this.repository.repo} is:issue is:open ` +
      `label:agent-ready in:body "<!-- one-cli:environment-blocker:"`;
    const result = await this.api(
      "GET",
      `/search/issues?q=${encodeURIComponent(query)}&per_page=100`,
      undefined,
      signal,
    );
    const items = record(result, "environment blocker search").items;
    if (!Array.isArray(items)) throw new Error("GitHub environment blocker search is invalid");
    if (items.length >= 100) {
      throw new Error("GitHub environment blocker inventory exceeds the strict single-page bound");
    }
    return items
      .filter((item) => !record(item, "search item").pull_request)
      .map(parseIssue)
      .filter((issue) =>
        issue.state === "open" &&
        issue.labels.includes("agent-ready") &&
        issue.body.includes("<!-- one-cli:environment-blocker:"));
  }

  async assertDefaultBranchContains(
    sha: string,
    branch: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!/^[0-9a-f]{40,64}$/u.test(sha) || !branch || /[\0\r\n/]/u.test(branch)) {
      throw new Error("Bootstrap merge SHA or default branch is invalid");
    }
    const comparison = record(
      await this.api(
        "GET",
        `/repos/${this.repository.owner}/${this.repository.repo}/compare/${sha}...${branch}`,
        undefined,
        signal,
      ),
      "bootstrap comparison",
    );
    if (comparison.status !== "ahead" && comparison.status !== "identical") {
      throw new Error(`Default branch ${branch} does not contain bootstrap merge ${sha}`);
    }
  }

  async assertCommitDescendsFrom(
    ancestorSha: string,
    descendantSha: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!SHA.test(ancestorSha) || !SHA.test(descendantSha)) {
      throw new Error("Release lineage SHA is invalid");
    }
    const comparison = record(
      await this.api(
        "GET",
        `/repos/${this.repository.owner}/${this.repository.repo}/compare/${ancestorSha}...${descendantSha}`,
        undefined,
        signal,
      ),
      "release lineage comparison",
    );
    if (comparison.status !== "ahead" && comparison.status !== "identical") {
      throw new Error(
        `Active release ${descendantSha} does not descend from roadmap handoff ${ancestorSha}`,
      );
    }
  }

  async createIssue(
    input: { title: string; body: string; labels: readonly string[] },
    signal?: AbortSignal,
  ): Promise<HostIssue> {
    return parseIssue(await this.api(
      "POST",
      `/repos/${this.repository.owner}/${this.repository.repo}/issues`,
      input,
      signal,
    ));
  }

  async updateIssue(
    number: number,
    input: {
      title?: string;
      state?: "open" | "closed";
      labels?: readonly string[];
      body?: string;
    },
    signal?: AbortSignal,
  ): Promise<HostIssue> {
    positiveInteger(number, "issue number");
    return parseIssue(await this.api(
      "PATCH",
      `/repos/${this.repository.owner}/${this.repository.repo}/issues/${number}`,
      input,
      signal,
    ));
  }

  async createComment(number: number, body: string, signal?: AbortSignal): Promise<void> {
    positiveInteger(number, "issue number");
    await this.api(
      "POST",
      `/repos/${this.repository.owner}/${this.repository.repo}/issues/${number}/comments`,
      { body },
      signal,
    );
  }

  async findMergedPullForIssue(
    number: number,
    signal?: AbortSignal,
  ): Promise<PullEvidence | undefined> {
    positiveInteger(number, "issue number");
    const query =
      `repo:${this.repository.owner}/${this.repository.repo} is:pr ` +
      `in:body "Implements #${number}"`;
    const result = record(
      await this.api(
        "GET",
        `/search/issues?q=${encodeURIComponent(query)}&per_page=20`,
        undefined,
        signal,
      ),
      "pull search",
    );
    if (!Array.isArray(result.items)) throw new Error("GitHub pull search is invalid");
    for (const item of result.items) {
      const pullNumber = positiveInteger(record(item, "pull item").number, "pull number");
      const pull = record(
        await this.api(
          "GET",
          `/repos/${this.repository.owner}/${this.repository.repo}/pulls/${pullNumber}`,
          undefined,
          signal,
        ),
        "pull",
      );
      if (pull.merged === true && typeof pull.merge_commit_sha === "string") {
        return {
          number: pullNumber,
          merged: true,
          mergeSha: pull.merge_commit_sha,
          headSha: string(record(pull.head, "pull head").sha, "pull head sha"),
          htmlUrl: string(pull.html_url, "pull URL"),
        };
      }
    }
    return undefined;
  }

  private async api(
    method: "GET" | "POST" | "PATCH",
    apiPath: string,
    input?: object,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!apiPath.startsWith("/") || /[\0\r\n]/u.test(apiPath)) {
      throw new Error("GitHub API path is invalid");
    }
    const result = requireSuccess(`gh api ${method}`, await this.runner.run({
      executable: this.executable,
      args: [
        "api",
        apiPath,
        "--method",
        method,
        "--header",
        "Accept: application/vnd.github+json",
        ...(input ? ["--input", "-"] : []),
      ],
      env: ghEnvironment(this.environment),
      timeoutMs: 60_000,
      maxOutputBytes: 4 * 1024 * 1024,
      ...(input ? { stdin: JSON.stringify(input) } : {}),
      ...(signal ? { signal } : {}),
    }));
    try {
      return result.stdout.trim() ? JSON.parse(result.stdout) as unknown : null;
    } catch {
      throw new Error("gh returned malformed JSON");
    }
  }
}

function parseIssue(value: unknown): HostIssue {
  const object = record(value, "issue");
  const labels = object.labels;
  const state = string(object.state, "issue state");
  if (!Array.isArray(labels) || (state !== "open" && state !== "closed")) {
    throw new Error("GitHub issue shape is invalid");
  }
  return {
    number: positiveInteger(object.number, "issue number"),
    title: string(object.title, "issue title"),
    body: object.body === null ? "" : string(object.body, "issue body"),
    state,
    htmlUrl: string(object.html_url, "issue URL"),
    labels: labels.map((label) =>
      typeof label === "string"
        ? label
        : string(record(label, "issue label").name, "issue label")),
  };
}

function ghEnvironment(source: Readonly<Record<string, string>>): Record<string, string> {
  const env: Record<string, string> = { NO_COLOR: "1", GH_PROMPT_DISABLED: "1" };
  for (const name of [
    "HOME",
    "PATH",
    "XDG_CONFIG_HOME",
    "GH_CONFIG_DIR",
    "GH_HOST",
  ]) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function singleLine(value: string, label: string): void {
  if (!value || /[\0\r\n]/u.test(value)) throw new Error(`${label} must be one safe line`);
}
