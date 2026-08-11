import {
  SpawnProcessRunner,
  ProcessFailure,
  assertProcessSucceeded,
  type ProcessRequest,
  type ProcessRunner,
} from "./process.js";

export interface GitHubRepositoryRef {
  owner: string;
  repo: string;
}

export interface GitHubUser {
  login: string;
}

export interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  htmlUrl: string;
  user: GitHubUser | null;
  labels: string[];
}

export interface NewGitHubIssue {
  title: string;
  body: string;
  labels: readonly string[];
}

export interface GitHubPullRequest extends GitHubIssue {
  headSha: string;
  headRef: string;
  baseSha: string;
  baseRef: string;
  draft: boolean;
  merged: boolean;
  mergeSha: string | null;
}

export type GitHubCheckStatus = "queued" | "in_progress" | "completed" | "waiting" | "requested" | "pending";
export type GitHubCheckConclusion =
  | "action_required"
  | "cancelled"
  | "failure"
  | "neutral"
  | "skipped"
  | "stale"
  | "startup_failure"
  | "success"
  | "timed_out"
  | null;

export interface GitHubCheck {
  id: number;
  name: string;
  headSha: string;
  status: GitHubCheckStatus;
  conclusion: GitHubCheckConclusion;
  detailsUrl: string | null;
}

export interface GitHubComment {
  id: number;
  body: string;
  htmlUrl: string;
}

export type GitHubMergeMethod = "merge" | "squash" | "rebase";

export interface GitHubMergeResult {
  merged: boolean;
  sha: string | null;
  message: string;
}

export interface GitHubRepositorySafety {
  defaultBranch: string;
  canPush: boolean;
  branchProtected: boolean;
  requiredCheckNames: readonly string[];
}

export interface GitHubRef {
  ref: string;
  sha: string;
}

export interface GitHubIssueMarkerLookup {
  issue: GitHubIssue | undefined;
  /** True only when a complete bounded listing proves the marker is absent. */
  absenceProven: boolean;
}

export interface GitHubCommentMarkerLookup {
  comment: GitHubComment | undefined;
  absenceProven: boolean;
}

export class GitHubHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GitHubHttpError";
  }
}

export class GitHubRefConflictError extends Error {
  constructor(readonly ref: string) {
    super(`GitHub ref already exists: ${ref}`);
    this.name = "GitHubRefConflictError";
  }
}

export interface GitHubPort {
  listCandidateIssues(
    repository: GitHubRepositoryRef,
    labels: readonly string[],
    signal?: AbortSignal,
  ): Promise<readonly GitHubIssue[]>;
  getIssue(repository: GitHubRepositoryRef, issueNumber: number, signal?: AbortSignal): Promise<GitHubIssue>;
  createIssue(
    repository: GitHubRepositoryRef,
    issue: NewGitHubIssue,
    signal?: AbortSignal,
  ): Promise<GitHubIssue>;
  createNormalizedIssue(
    repository: GitHubRepositoryRef,
    input: {
      title: string;
      fields: Readonly<Record<string, string>>;
      requiredFields: readonly string[];
      labels: readonly string[];
    },
    signal?: AbortSignal,
  ): Promise<GitHubIssue>;
  findIssueByMarker(
    repository: GitHubRepositoryRef,
    marker: string,
    signal?: AbortSignal,
  ): Promise<GitHubIssueMarkerLookup>;
  findPullRequestByHead(
    repository: GitHubRepositoryRef,
    headRef: string,
    signal?: AbortSignal,
  ): Promise<GitHubPullRequest | undefined>;
  createPullRequest(
    repository: GitHubRepositoryRef,
    input: { title: string; body: string; head: string; base: string; draft: boolean },
    signal?: AbortSignal,
  ): Promise<GitHubPullRequest>;
  getPullRequest(
    repository: GitHubRepositoryRef,
    pullNumber: number,
    signal?: AbortSignal,
  ): Promise<GitHubPullRequest>;
  getChecksForCommit(
    repository: GitHubRepositoryRef,
    exactHeadSha: string,
    signal?: AbortSignal,
  ): Promise<readonly GitHubCheck[]>;
  createComment(
    repository: GitHubRepositoryRef,
    issueOrPullNumber: number,
    body: string,
    signal?: AbortSignal,
  ): Promise<GitHubComment>;
  findIssueComment(
    repository: GitHubRepositoryRef,
    issueOrPullNumber: number,
    marker: string,
    signal?: AbortSignal,
  ): Promise<GitHubComment | undefined>;
  findIssueCommentByMarker(
    repository: GitHubRepositoryRef,
    issueOrPullNumber: number,
    marker: string,
    signal?: AbortSignal,
  ): Promise<GitHubCommentMarkerLookup>;
  updateIssue(
    repository: GitHubRepositoryRef,
    issueNumber: number,
    update: { state?: "open" | "closed"; labels?: readonly string[] },
    signal?: AbortSignal,
  ): Promise<GitHubIssue>;
  mergePullRequest(
    repository: GitHubRepositoryRef,
    pullNumber: number,
    expectedHeadSha: string,
    method: GitHubMergeMethod,
    signal?: AbortSignal,
  ): Promise<GitHubMergeResult>;
  deleteBranch(
    repository: GitHubRepositoryRef,
    branch: string,
    signal?: AbortSignal,
  ): Promise<void>;
  createRef(
    repository: GitHubRepositoryRef,
    ref: string,
    exactSha: string,
    signal?: AbortSignal,
  ): Promise<GitHubRef>;
  getRef(
    repository: GitHubRepositoryRef,
    ref: string,
    signal?: AbortSignal,
  ): Promise<GitHubRef | undefined>;
  deleteRef(
    repository: GitHubRepositoryRef,
    ref: string,
    signal?: AbortSignal,
  ): Promise<void>;
  getRepositorySafety(
    repository: GitHubRepositoryRef,
    branch: string,
    signal?: AbortSignal,
  ): Promise<GitHubRepositorySafety>;
}

export type GitHubHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export enum GitHubRestProjection {
  ReleaseListMetadata = "release-list-metadata",
}

export interface GitHubTransportRequest {
  method: GitHubHttpMethod;
  path: string;
  body?: Readonly<Record<string, unknown>>;
  projection?: GitHubRestProjection;
  signal?: AbortSignal;
}

export interface GitHubTransport {
  request(request: GitHubTransportRequest): Promise<unknown>;
}

export interface GhRestTransportOptions {
  runner?: ProcessRunner;
  ghExecutable?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

const RELEASE_LIST_METADATA_JQ =
  "map({id,node_id,tag_name,name,body,html_url,published_at,created_at})";

/**
 * REST transport backed by the authenticated `gh` configuration. Authentication
 * token environment variables are deliberately not inherited by the child.
 */
export class GhRestTransport implements GitHubTransport {
  private readonly runner: ProcessRunner;
  private readonly ghExecutable: string;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;

  constructor(options: GhRestTransportOptions = {}) {
    this.runner = options.runner ?? new SpawnProcessRunner();
    this.ghExecutable = checkedExecutable(options.ghExecutable ?? "gh");
    this.timeoutMs = positiveInteger(options.timeoutMs ?? 60_000, "GitHub timeout");
    this.maxOutputBytes = positiveInteger(
      options.maxOutputBytes ?? 4 * 1024 * 1024,
      "GitHub output limit",
    );
  }

  async request(request: GitHubTransportRequest): Promise<unknown> {
    if (!request.path.startsWith("/") || /[\0\r\n]/u.test(request.path)) {
      throw new Error("GitHub API path must be an absolute, single-line API path");
    }
    const args = [
      "api",
      request.path,
      "--method",
      request.method,
      "--header",
      "Accept: application/vnd.github+json",
      "--header",
      "X-GitHub-Api-Version: 2022-11-28",
      ...projectionArgs(request.projection),
      ...(request.body === undefined ? [] : ["--input", "-"]),
    ];
    const processRequest: ProcessRequest = {
      executable: this.ghExecutable,
      args,
      env: ghEnvironment(),
      timeoutMs: this.timeoutMs,
      maxOutputBytes: this.maxOutputBytes,
      ...(request.body === undefined ? {} : { stdin: JSON.stringify(request.body) }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    };
    const result = await this.runner.run(processRequest);
    try {
      assertProcessSucceeded(`gh api ${request.method}`, result);
    } catch (error) {
      if (error instanceof ProcessFailure) {
        const status = githubStatus(error.result.stderr);
        if (status !== undefined) throw new GitHubHttpError(status, error.message);
      }
      throw error;
    }
    const output = result.stdout.trim();
    if (!output) return null;
    try {
      return JSON.parse(output) as unknown;
    } catch {
      throw new Error("gh api returned invalid JSON");
    }
  }
}

function projectionArgs(projection: GitHubRestProjection | undefined): string[] {
  switch (projection) {
    case undefined:
      return [];
    case GitHubRestProjection.ReleaseListMetadata:
      return ["--jq", RELEASE_LIST_METADATA_JQ];
    default:
      throw new Error("Unsupported GitHub REST projection");
  }
}

export class GitHubClient implements GitHubPort {
  constructor(private readonly transport: GitHubTransport) {}

  async listCandidateIssues(
    repository: GitHubRepositoryRef,
    labels: readonly string[],
    signal?: AbortSignal,
  ): Promise<readonly GitHubIssue[]> {
    const encodedLabels = labels.map(checkedLabel).join(",");
    const query = new URLSearchParams({
      state: "open",
      per_page: "100",
      ...(encodedLabels ? { labels: encodedLabels } : {}),
    });
    const value = await this.transport.request({
      method: "GET",
      path: `${repositoryPath(repository)}/issues?${query.toString()}`,
      ...(signal === undefined ? {} : { signal }),
    });
    if (!Array.isArray(value)) throw new Error("GitHub issues response is not an array");
    return value
      .filter((candidate) => !("pull_request" in record(candidate, "issue")))
      .map(parseIssue);
  }

  async getIssue(
    repository: GitHubRepositoryRef,
    issueNumber: number,
    signal?: AbortSignal,
  ): Promise<GitHubIssue> {
    const value = await this.transport.request({
      method: "GET",
      path: `${repositoryPath(repository)}/issues/${checkedNumber(issueNumber)}`,
      ...(signal === undefined ? {} : { signal }),
    });
    return parseIssue(value);
  }

  async createIssue(
    repository: GitHubRepositoryRef,
    issue: NewGitHubIssue,
    signal?: AbortSignal,
  ): Promise<GitHubIssue> {
    checkedText(issue.title, "issue title");
    checkedText(issue.body, "issue body");
    const value = await this.transport.request({
      method: "POST",
      path: `${repositoryPath(repository)}/issues`,
      body: { title: issue.title, body: issue.body, labels: issue.labels.map(checkedLabel) },
      ...(signal === undefined ? {} : { signal }),
    });
    return parseIssue(value);
  }

  async createNormalizedIssue(
    repository: GitHubRepositoryRef,
    input: {
      title: string;
      fields: Readonly<Record<string, string>>;
      requiredFields: readonly string[];
      labels: readonly string[];
    },
    signal?: AbortSignal,
  ): Promise<GitHubIssue> {
    const missing = input.requiredFields.filter((field) => !input.fields[field]?.trim());
    if (missing.length > 0) {
      throw new Error(`Normalized issue is missing required fields: ${missing.join(", ")}`);
    }
    const body = input.requiredFields
      .map((field) => `## ${fieldHeading(field)}\n\n${checkedText(input.fields[field]!, field)}`)
      .join("\n\n");
    return await this.createIssue(
      repository,
      { title: input.title, body, labels: input.labels },
      signal,
    );
  }

  async findIssueByMarker(
    repository: GitHubRepositoryRef,
    marker: string,
    signal?: AbortSignal,
  ): Promise<GitHubIssueMarkerLookup> {
    if (!marker.trim() || marker.includes("\0") || marker.length > 4_096) {
      throw new Error("GitHub issue marker is invalid");
    }
    const query = new URLSearchParams({ state: "all", per_page: "100" });
    const value = await this.transport.request({
      method: "GET",
      path: `${repositoryPath(repository)}/issues?${query.toString()}`,
      ...(signal === undefined ? {} : { signal }),
    });
    if (!Array.isArray(value)) throw new Error("GitHub issues response is not an array");
    const issues = value
      .filter((candidate) => !("pull_request" in record(candidate, "issue")))
      .map(parseIssue);
    return {
      issue: issues.find((issue) => issue.body?.includes(marker)),
      absenceProven: value.length < 100,
    };
  }

  async findPullRequestByHead(
    repository: GitHubRepositoryRef,
    headRef: string,
    signal?: AbortSignal,
  ): Promise<GitHubPullRequest | undefined> {
    const head = `${checkedSlug(repository.owner, "owner")}:${checkedRef(headRef)}`;
    const query = new URLSearchParams({ state: "all", head, per_page: "100" });
    const value = await this.transport.request({
      method: "GET",
      path: `${repositoryPath(repository)}/pulls?${query.toString()}`,
      ...(signal === undefined ? {} : { signal }),
    });
    if (!Array.isArray(value)) throw new Error("GitHub pulls response is not an array");
    const parsed = value.map(parsePullRequest);
    const open = parsed.filter((pull) => pull.state === "open");
    if (open.length > 1) {
      throw new Error("GitHub returned multiple open pull requests for one head");
    }
    if (open.length === 1) return open[0];
    if (parsed.length === 0) return undefined;
    // Prefer the newest closed/merged PR when no open PR exists.
    return parsed.sort((left, right) => right.number - left.number)[0];
  }

  async createPullRequest(
    repository: GitHubRepositoryRef,
    input: { title: string; body: string; head: string; base: string; draft: boolean },
    signal?: AbortSignal,
  ): Promise<GitHubPullRequest> {
    checkedText(input.title, "pull request title");
    checkedText(input.body, "pull request body");
    const value = await this.transport.request({
      method: "POST",
      path: `${repositoryPath(repository)}/pulls`,
      body: {
        title: input.title,
        body: input.body,
        head: checkedRef(input.head),
        base: checkedRef(input.base),
        draft: input.draft,
      },
      ...(signal === undefined ? {} : { signal }),
    });
    return parsePullRequest(value);
  }

  async getPullRequest(
    repository: GitHubRepositoryRef,
    pullNumber: number,
    signal?: AbortSignal,
  ): Promise<GitHubPullRequest> {
    const value = await this.transport.request({
      method: "GET",
      path: `${repositoryPath(repository)}/pulls/${checkedNumber(pullNumber)}`,
      ...(signal === undefined ? {} : { signal }),
    });
    return parsePullRequest(value);
  }

  async getChecksForCommit(
    repository: GitHubRepositoryRef,
    exactHeadSha: string,
    signal?: AbortSignal,
  ): Promise<readonly GitHubCheck[]> {
    const sha = checkedSha(exactHeadSha);
    const value = await this.transport.request({
      method: "GET",
      path: `${repositoryPath(repository)}/commits/${sha}/check-runs?per_page=100`,
      ...(signal === undefined ? {} : { signal }),
    });
    const response = record(value, "check-runs response");
    if (!Array.isArray(response.check_runs)) {
      throw new Error("GitHub check-runs response is missing check_runs");
    }
    return response.check_runs.map((value) => {
      const check = parseCheck(value);
      if (checkedSha(check.headSha) !== sha) {
        throw new Error("GitHub returned a check run for a different head SHA");
      }
      return { ...check, headSha: sha };
    });
  }

  async createComment(
    repository: GitHubRepositoryRef,
    issueOrPullNumber: number,
    body: string,
    signal?: AbortSignal,
  ): Promise<GitHubComment> {
    if (!body.trim() || body.includes("\0")) {
      throw new Error("GitHub comment must be non-empty and NUL-free");
    }
    const value = await this.transport.request({
      method: "POST",
      path: `${repositoryPath(repository)}/issues/${checkedNumber(issueOrPullNumber)}/comments`,
      body: { body },
      ...(signal === undefined ? {} : { signal }),
    });
    const object = record(value, "comment");
    return {
      id: number(object.id, "comment id"),
      body: string(object.body, "comment body"),
      htmlUrl: string(object.html_url, "comment URL"),
    };
  }

  async findIssueComment(
    repository: GitHubRepositoryRef,
    issueOrPullNumber: number,
    marker: string,
    signal?: AbortSignal,
  ): Promise<GitHubComment | undefined> {
    return (await this.findIssueCommentByMarker(
      repository,
      issueOrPullNumber,
      marker,
      signal,
    )).comment;
  }

  async findIssueCommentByMarker(
    repository: GitHubRepositoryRef,
    issueOrPullNumber: number,
    marker: string,
    signal?: AbortSignal,
  ): Promise<GitHubCommentMarkerLookup> {
    if (!marker.trim() || marker.includes("\0")) throw new Error("GitHub comment marker is invalid");
    const value = await this.transport.request({
      method: "GET",
      path: `${repositoryPath(repository)}/issues/${checkedNumber(issueOrPullNumber)}/comments?per_page=100`,
      ...(signal === undefined ? {} : { signal }),
    });
    if (!Array.isArray(value)) throw new Error("GitHub comments response is not an array");
    const matches = value.map(parseComment).filter((comment) => comment.body.includes(marker));
    return { comment: matches[0], absenceProven: value.length < 100 };
  }

  async updateIssue(
    repository: GitHubRepositoryRef,
    issueNumber: number,
    update: { state?: "open" | "closed"; labels?: readonly string[] },
    signal?: AbortSignal,
  ): Promise<GitHubIssue> {
    if (update.state === undefined && update.labels === undefined) {
      throw new Error("GitHub issue update must change state or labels");
    }
    const body = {
      ...(update.state === undefined ? {} : { state: update.state }),
      ...(update.labels === undefined ? {} : { labels: update.labels.map(checkedLabel) }),
    };
    const value = await this.transport.request({
      method: "PATCH",
      path: `${repositoryPath(repository)}/issues/${checkedNumber(issueNumber)}`,
      body,
      ...(signal === undefined ? {} : { signal }),
    });
    return parseIssue(value);
  }

  async mergePullRequest(
    repository: GitHubRepositoryRef,
    pullNumber: number,
    expectedHeadSha: string,
    method: GitHubMergeMethod,
    signal?: AbortSignal,
  ): Promise<GitHubMergeResult> {
    if (!["merge", "squash", "rebase"].includes(method)) {
      throw new Error("Unsupported GitHub merge method");
    }
    const value = await this.transport.request({
      method: "PUT",
      path: `${repositoryPath(repository)}/pulls/${checkedNumber(pullNumber)}/merge`,
      body: {
        sha: checkedSha(expectedHeadSha),
        merge_method: method,
      },
      ...(signal === undefined ? {} : { signal }),
    });
    const object = record(value, "merge response");
    return {
      merged: boolean(object.merged, "merge result"),
      sha: nullableString(object.sha, "merge SHA"),
      message: string(object.message, "merge message"),
    };
  }

  async deleteBranch(
    repository: GitHubRepositoryRef,
    branch: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const encoded = checkedRef(branch)
      .split("/")
      .map((part) => encodeURIComponent(part))
      .join("/");
    const value = await this.transport.request({
      method: "DELETE",
      path: `${repositoryPath(repository)}/git/refs/heads/${encoded}`,
      ...(signal === undefined ? {} : { signal }),
    });
    if (value !== null && value !== undefined) {
      throw new Error("GitHub delete-ref response must be empty");
    }
  }

  async createRef(
    repository: GitHubRepositoryRef,
    ref: string,
    exactSha: string,
    signal?: AbortSignal,
  ): Promise<GitHubRef> {
    const fullRef = checkedFullHeadRef(ref);
    const sha = checkedSha(exactSha);
    let value: unknown;
    try {
      value = await this.transport.request({
        method: "POST",
        path: `${repositoryPath(repository)}/git/refs`,
        body: { ref: fullRef, sha },
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      if (
        error instanceof GitHubHttpError &&
        error.status === 422 &&
        /\breference\b.*\balready exists\b|\balready exists\b.*\breference\b/iu.test(error.message)
      ) {
        throw new GitHubRefConflictError(fullRef);
      }
      throw error;
    }
    const created = parseGitRef(value);
    if (created.ref !== fullRef || created.sha !== sha) {
      throw new Error("GitHub created a ref with unexpected identity or head");
    }
    return created;
  }

  async getRef(
    repository: GitHubRepositoryRef,
    ref: string,
    signal?: AbortSignal,
  ): Promise<GitHubRef | undefined> {
    const fullRef = checkedFullHeadRef(ref);
    try {
      const observed = parseGitRef(
        await this.transport.request({
          method: "GET",
          path: `${repositoryPath(repository)}/git/ref/${encodedHeadRef(fullRef)}`,
          ...(signal === undefined ? {} : { signal }),
        }),
      );
      if (observed.ref !== fullRef) throw new Error("GitHub returned a different ref");
      return observed;
    } catch (error) {
      if (error instanceof GitHubHttpError && error.status === 404) return undefined;
      throw error;
    }
  }

  async deleteRef(
    repository: GitHubRepositoryRef,
    ref: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const fullRef = checkedFullHeadRef(ref);
    try {
      const value = await this.transport.request({
        method: "DELETE",
        path: `${repositoryPath(repository)}/git/refs/${encodedHeadRef(fullRef)}`,
        ...(signal === undefined ? {} : { signal }),
      });
      if (value !== null && value !== undefined) {
        throw new Error("GitHub delete-ref response must be empty");
      }
    } catch (error) {
      // Deletion is idempotent. A proven 404 is success; transport uncertainty is not.
      if (error instanceof GitHubHttpError && error.status === 404) return;
      throw error;
    }
  }

  async getRepositorySafety(
    repository: GitHubRepositoryRef,
    branch: string,
    signal?: AbortSignal,
  ): Promise<GitHubRepositorySafety> {
    const repositoryValue = record(
      await this.transport.request({
        method: "GET",
        path: repositoryPath(repository),
        ...(signal === undefined ? {} : { signal }),
      }),
      "repository",
    );
    const permissions = record(repositoryValue.permissions, "repository permissions");
    const encodedBranch = checkedRef(branch)
      .split("/")
      .map((part) => encodeURIComponent(part))
      .join("/");
    const protection = record(
      await this.transport.request({
        method: "GET",
        path: `${repositoryPath(repository)}/branches/${encodedBranch}/protection`,
        ...(signal === undefined ? {} : { signal }),
      }),
      "branch protection",
    );
    const statusChecks =
      protection.required_status_checks === null
        ? undefined
        : record(protection.required_status_checks, "required status checks");
    const contexts = statusChecks?.contexts;
    if (contexts !== undefined && !Array.isArray(contexts)) {
      throw new Error("GitHub branch protection contexts are invalid");
    }
    return {
      defaultBranch: string(repositoryValue.default_branch, "default branch"),
      canPush: boolean(permissions.push, "push permission"),
      branchProtected: true,
      requiredCheckNames:
        contexts?.map((context) => string(context, "required status check")) ?? [],
    };
  }
}

export function normalizedIssueFields(
  issue: GitHubIssue,
  requiredFields: readonly string[],
): Readonly<Record<string, string>> | undefined {
  if (issue.body === null) return undefined;
  const fields: Record<string, string> = {};
  const headings = [...issue.body.matchAll(/^##\s+([A-Za-z][A-Za-z0-9 ]*)\s*$/gmu)];
  for (let index = 0; index < headings.length; index++) {
    const heading = headings[index]!;
    const start = (heading.index ?? 0) + heading[0].length;
    const end = headings[index + 1]?.index ?? issue.body.length;
    const field = toFieldName(heading[1]!);
    if (Object.hasOwn(fields, field)) return undefined;
    fields[field] = issue.body.slice(start, end).trim();
  }
  if (requiredFields.some((field) => !fields[field]?.trim())) return undefined;
  return fields;
}

export function isExecutionEligible(input: {
  issue: GitHubIssue;
  exactAuthor: string;
  requiredFields: readonly string[];
  agentReadyLabel?: string;
  quarantineLabels?: readonly string[];
  branchExists: boolean;
  pullRequestExists: boolean;
}): boolean {
  const ready = input.agentReadyLabel ?? "agent-ready";
  const quarantine = new Set(input.quarantineLabels ?? ["agent-failed", "quarantined"]);
  return (
    input.issue.state === "open" &&
    input.issue.user?.login === input.exactAuthor &&
    input.issue.labels.includes(ready) &&
    !input.issue.labels.some((label) => quarantine.has(label)) &&
    !input.branchExists &&
    !input.pullRequestExists &&
    normalizedIssueFields(input.issue, input.requiredFields) !== undefined
  );
}

function parseIssue(value: unknown): GitHubIssue {
  const object = record(value, "issue");
  const state = string(object.state, "issue state");
  if (state !== "open" && state !== "closed") throw new Error("GitHub issue state is invalid");
  const labels = object.labels;
  if (!Array.isArray(labels)) throw new Error("GitHub issue labels are invalid");
  return {
    number: number(object.number, "issue number"),
    title: string(object.title, "issue title"),
    body: nullableString(object.body, "issue body"),
    state,
    htmlUrl: string(object.html_url, "issue URL"),
    user: object.user === null ? null : { login: string(record(object.user, "issue user").login, "user login") },
    labels: labels.map((label) =>
      typeof label === "string"
        ? label
        : string(record(label, "issue label").name, "issue label name"),
    ),
  };
}

function parsePullRequest(value: unknown): GitHubPullRequest {
  const object = record(value, "pull request");
  const issue = parseIssue(object);
  const head = record(object.head, "pull request head");
  const base = record(object.base, "pull request base");
  return {
    ...issue,
    headSha: checkedSha(string(head.sha, "pull request head SHA")),
    headRef: checkedRef(string(head.ref, "pull request head ref")),
    baseSha: checkedSha(string(base.sha, "pull request base SHA")),
    baseRef: checkedRef(string(base.ref, "pull request base ref")),
    draft: boolean(object.draft ?? false, "pull request draft"),
    merged: boolean(object.merged ?? false, "pull request merged"),
    mergeSha:
      object.merge_commit_sha === null
        ? null
        : checkedSha(string(object.merge_commit_sha, "pull request merge SHA")),
  };
}

function parseCheck(value: unknown): GitHubCheck {
  const object = record(value, "check run");
  const status = string(object.status, "check status");
  if (!isCheckStatus(status)) throw new Error(`Unsupported GitHub check status: ${status}`);
  const rawConclusion = nullableString(object.conclusion, "check conclusion");
  if (!isCheckConclusion(rawConclusion)) {
    throw new Error(`Unsupported GitHub check conclusion: ${rawConclusion}`);
  }
  return {
    id: number(object.id, "check id"),
    name: string(object.name, "check name"),
    headSha: checkedSha(string(object.head_sha, "check head SHA")),
    status,
    conclusion: rawConclusion,
    detailsUrl: nullableString(object.details_url, "check details URL"),
  };
}

function parseComment(value: unknown): GitHubComment {
  const object = record(value, "comment");
  return {
    id: number(object.id, "comment id"),
    body: string(object.body, "comment body"),
    htmlUrl: string(object.html_url, "comment URL"),
  };
}

function parseGitRef(value: unknown): GitHubRef {
  const object = record(value, "git ref");
  const target = record(object.object, "git ref object");
  return {
    ref: checkedFullHeadRef(string(object.ref, "git ref name")),
    sha: checkedSha(string(target.sha, "git ref SHA")),
  };
}

function repositoryPath(repository: GitHubRepositoryRef): string {
  return `/repos/${encodeURIComponent(checkedSlug(repository.owner, "owner"))}/${encodeURIComponent(
    checkedSlug(repository.repo, "repository"),
  )}`;
}

function checkedSlug(value: string, label: string): string {
  if (!/^[A-Za-z0-9_.-]+$/u.test(value) || value === "." || value === "..") {
    throw new Error(`GitHub ${label} is invalid`);
  }
  return value;
}

function checkedRef(value: string): string {
  if (
    !value ||
    value.startsWith("-") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.includes("..") ||
    value.includes("@{") ||
    value.includes("//") ||
    value.split("/").some((component) => component.startsWith(".") || component.endsWith(".lock")) ||
    /[\0-\x20~^:?*[\]\\]/u.test(value)
  ) {
    throw new Error("GitHub branch ref is invalid");
  }
  return value;
}

function checkedFullHeadRef(value: string): string {
  const prefix = "refs/heads/";
  if (!value.startsWith(prefix)) throw new Error("GitHub ref must be a full heads ref");
  checkedRef(value.slice(prefix.length));
  return value;
}

function encodedHeadRef(fullRef: string): string {
  return checkedFullHeadRef(fullRef)
    .slice("refs/".length)
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function checkedLabel(value: string): string {
  if (!value.trim() || value.length > 100 || /[\0\r\n]/u.test(value)) {
    throw new Error("GitHub label is invalid");
  }
  return value;
}

function checkedText(value: string, label: string): string {
  if (!value.trim() || value.includes("\0")) throw new Error(`GitHub ${label} is invalid`);
  return value;
}

function checkedNumber(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("GitHub number must be positive");
  return value;
}

function checkedSha(value: string): string {
  if (!/^[0-9a-fA-F]{40}$/u.test(value)) {
    throw new Error("GitHub head SHA must be an exact 40-character object id");
  }
  return value.toLowerCase();
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`GitHub ${label} is not an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`GitHub ${label} is not a string`);
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  return string(value, label);
}

function number(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`GitHub ${label} is not an integer`);
  }
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`GitHub ${label} is not a boolean`);
  return value;
}

function isCheckStatus(value: string): value is GitHubCheckStatus {
  return ["queued", "in_progress", "completed", "waiting", "requested", "pending"].includes(value);
}

function isCheckConclusion(value: string | null): value is GitHubCheckConclusion {
  return (
    value === null ||
    [
      "action_required",
      "cancelled",
      "failure",
      "neutral",
      "skipped",
      "stale",
      "startup_failure",
      "success",
      "timed_out",
    ].includes(value)
  );
}

function checkedExecutable(value: string): string {
  if (!value || value.includes("\0")) throw new Error("gh executable is invalid");
  return value;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be positive`);
  return value;
}

function ghEnvironment(): Readonly<Record<string, string>> {
  const environment: Record<string, string> = { NO_COLOR: "1" };
  for (const name of ["HOME", "PATH", "XDG_CONFIG_HOME", "GH_CONFIG_DIR", "GH_HOST"] as const) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

function githubStatus(stderr: string): number | undefined {
  const matches = [
    ...stderr.matchAll(/\bHTTP\s+([1-5][0-9]{2})\b/giu),
    ...stderr.matchAll(/\bstatus(?:\s+code)?[:=\s]+([1-5][0-9]{2})\b/giu),
  ];
  const value = matches.at(-1)?.[1];
  return value === undefined ? undefined : Number(value);
}

function toFieldName(heading: string): string {
  const words = heading.trim().split(/\s+/u);
  return words
    .map((word, index) =>
      index === 0
        ? word.charAt(0).toLowerCase() + word.slice(1)
        : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join("");
}

function fieldHeading(field: string): string {
  if (!/^[A-Za-z][A-Za-z0-9]*$/u.test(field)) throw new Error("Normalized field name is invalid");
  return field
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/^./u, (character) => character.toUpperCase());
}
