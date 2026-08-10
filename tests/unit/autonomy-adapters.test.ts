import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitManager } from "../../src/autonomy/git.js";
import {
  GhRestTransport,
  GitHubClient,
  GitHubHttpError,
  GitHubRefConflictError,
  GitHubRestProjection,
  type GitHubTransport,
  type GitHubTransportRequest,
} from "../../src/autonomy/github.js";
import type {
  ProcessRequest,
  ProcessResult,
  ProcessRunner,
} from "../../src/autonomy/process.js";
import {
  DarwinSandbox,
  buildDarwinSandboxProfile,
} from "../../src/autonomy/sandbox.js";
import { makeTempDir, removeTempDir } from "../helpers.js";

class FakeProcessRunner implements ProcessRunner {
  readonly requests: ProcessRequest[] = [];

  constructor(
    private readonly respond: (
      request: ProcessRequest,
    ) => ProcessResult | Promise<ProcessResult> = () => processResult(),
  ) {}

  async run(request: ProcessRequest): Promise<ProcessResult> {
    this.requests.push(request);
    return await this.respond(request);
  }
}

class FakeGitHubTransport implements GitHubTransport {
  readonly requests: GitHubTransportRequest[] = [];

  constructor(private readonly responses: unknown[]) {}

  async request(request: GitHubTransportRequest): Promise<unknown> {
    this.requests.push(request);
    if (this.responses.length === 0) throw new Error("No fake GitHub response");
    const response = this.responses.shift();
    if (response instanceof Error) throw response;
    return response;
  }
}

function processResult(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    durationMs: 1,
    timedOut: false,
    cancelled: false,
    outputLimitExceeded: false,
    ...overrides,
  };
}

describe("portable autonomy adapters", () => {
  let root: string;

  beforeEach(() => {
    root = makeTempDir("autonomy-adapters");
  });

  afterEach(() => {
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
    removeTempDir(root);
  });

  it("passes gh API data as structured argv/stdin without token inheritance", async () => {
    process.env.GH_TOKEN = "must-not-leak";
    process.env.GITHUB_TOKEN = "also-must-not-leak";
    const runner = new FakeProcessRunner(() =>
      processResult({ stdout: '{"id":1,"body":"ok","html_url":"https://example.test/comment"}' }),
    );
    const transport = new GhRestTransport({ runner, ghExecutable: "gh" });

    await transport.request({
      method: "POST",
      path: "/repos/acme/widget/issues/1/comments;not-a-shell",
      body: { body: 'quoted; $(touch /tmp/nope) " text' },
    });

    const request = runner.requests[0];
    expect(request).toBeDefined();
    expect(request?.executable).toBe("gh");
    expect(request?.args).toEqual([
      "api",
      "/repos/acme/widget/issues/1/comments;not-a-shell",
      "--method",
      "POST",
      "--header",
      "Accept: application/vnd.github+json",
      "--header",
      "X-GitHub-Api-Version: 2022-11-28",
      "--input",
      "-",
    ]);
    expect(request?.stdin).toBe('{"body":"quoted; $(touch /tmp/nope) \\" text"}');
    expect(request?.env).not.toHaveProperty("GH_TOKEN");
    expect(request?.env).not.toHaveProperty("GITHUB_TOKEN");
  });

  it("passes the fixed bounded release projection to gh argv", async () => {
    const runner = new FakeProcessRunner(() =>
      processResult({
        stdout:
          '[{"id":1,"node_id":"R_1","tag_name":"v1","name":"Release","body":"Notes","html_url":"https://github.com/acme/widget/releases/tag/v1","published_at":"2026-08-08T08:00:00Z","created_at":"2026-08-08T07:00:00Z"}]',
      }),
    );
    const transport = new GhRestTransport({ runner, ghExecutable: "gh" });

    const output = await transport.request({
      method: "GET",
      path: "/repos/acme/widget/releases?per_page=10&page=1",
      projection: GitHubRestProjection.ReleaseListMetadata,
    });

    expect(output).toEqual([
      expect.objectContaining({
        id: 1,
        tag_name: "v1",
        body: "Notes",
      }),
    ]);
    expect(output).not.toEqual([
      expect.objectContaining({
        assets: expect.anything(),
      }),
    ]);
    expect(runner.requests[0]?.args).toEqual([
      "api",
      "/repos/acme/widget/releases?per_page=10&page=1",
      "--method",
      "GET",
      "--header",
      "Accept: application/vnd.github+json",
      "--header",
      "X-GitHub-Api-Version: 2022-11-28",
      "--jq",
      "map({id,node_id,tag_name,name,body,html_url,published_at,created_at})",
    ]);
    expect(runner.requests[0]?.maxOutputBytes).toBe(4 * 1024 * 1024);
  });

  it("constructs git argv internally and rejects unsafe refs", async () => {
    const storageRoot = path.join(root, "git-storage");
    const runner = new FakeProcessRunner((request) => {
      if (request.args[0] === "clone") {
        const destination = request.args.at(-1);
        if (destination === undefined) throw new Error("missing clone destination");
        fs.mkdirSync(destination, { recursive: true });
      }
      return processResult();
    });
    const git = new GitManager({ storageRoot, runner });
    const remote = "https://example.test/repo.git;touch-not-run";

    const repository = await git.cloneBare("repo", remote);

    expect(repository.barePath).toBe(path.join(fs.realpathSync(storageRoot), "repositories", "repo.git"));
    expect(runner.requests[0]?.args).toEqual([
      "clone",
      "--bare",
      "--no-tags",
      "--",
      remote,
      repository.barePath,
    ]);

    const worktreePath = path.join(storageRoot, "worktrees", "repo", "task");
    fs.mkdirSync(worktreePath, { recursive: true });
    const worktree = { id: "task", repositoryId: "repo", path: worktreePath };
    await expect(
      git.push(worktree, { remote: "origin", branch: "--upload-pack=evil" }),
    ).rejects.toThrow("safe Git ref");
    expect(runner.requests).toHaveLength(1);
  });

  it("requires an exact expected head SHA when merging a pull request", async () => {
    const transport = new FakeGitHubTransport([
      { merged: true, sha: "b".repeat(40), message: "Pull Request successfully merged" },
    ]);
    const github = new GitHubClient(transport);
    const headSha = "a".repeat(40);

    await github.mergePullRequest({ owner: "acme", repo: "widget" }, 17, headSha, "squash");

    expect(transport.requests).toEqual([
      {
        method: "PUT",
        path: "/repos/acme/widget/pulls/17/merge",
        body: { sha: headSha, merge_method: "squash" },
      },
    ]);
    await expect(
      github.mergePullRequest({ owner: "acme", repo: "widget" }, 17, "main", "merge"),
    ).rejects.toThrow("exact 40-character");
  });

  it("creates exact GitHub refs and distinguishes atomic claim conflicts", async () => {
    const sha = "a".repeat(40);
    const ref = `refs/heads/one-cli-lease/issue-7-${"b".repeat(64)}`;
    const transport = new FakeGitHubTransport([
      { ref, object: { sha } },
      new GitHubHttpError(422, "Reference already exists"),
    ]);
    const github = new GitHubClient(transport);

    await expect(github.createRef({ owner: "acme", repo: "widget" }, ref, sha)).resolves.toEqual({
      ref,
      sha,
    });
    expect(transport.requests[0]).toEqual({
      method: "POST",
      path: "/repos/acme/widget/git/refs",
      body: { ref, sha },
    });
    await expect(
      github.createRef({ owner: "acme", repo: "widget" }, ref, sha),
    ).rejects.toBeInstanceOf(GitHubRefConflictError);
    await expect(
      github.createRef(
        { owner: "acme", repo: "widget" },
        "refs/heads/one-cli-lease/../unsafe",
        sha,
      ),
    ).rejects.toThrow("invalid");
    await expect(
      github.createRef({ owner: "acme", repo: "widget" }, ref, "main"),
    ).rejects.toThrow("exact 40-character");
  });

  it("gets and idempotently deletes exact full refs", async () => {
    const sha = "c".repeat(40);
    const ref = `refs/heads/one-cli-lease/issue-8-${"d".repeat(64)}`;
    const transport = new FakeGitHubTransport([
      { ref, object: { sha } },
      null,
      new GitHubHttpError(404, "Not Found"),
    ]);
    const github = new GitHubClient(transport);

    await expect(github.getRef({ owner: "acme", repo: "widget" }, ref)).resolves.toEqual({
      ref,
      sha,
    });
    await expect(github.deleteRef({ owner: "acme", repo: "widget" }, ref)).resolves.toBeUndefined();
    await expect(github.getRef({ owner: "acme", repo: "widget" }, ref)).resolves.toBeUndefined();
    expect(transport.requests.map((request) => request.path)).toEqual([
      `/repos/acme/widget/git/ref/heads/one-cli-lease/issue-8-${"d".repeat(64)}`,
      `/repos/acme/widget/git/refs/heads/one-cli-lease/issue-8-${"d".repeat(64)}`,
      `/repos/acme/widget/git/ref/heads/one-cli-lease/issue-8-${"d".repeat(64)}`,
    ]);
  });

  it("parses check runs and requests them by exact commit SHA", async () => {
    const sha = "c".repeat(40);
    const transport = new FakeGitHubTransport([
      {
        total_count: 2,
        check_runs: [
          {
            id: 1,
            name: "build",
            head_sha: sha,
            status: "completed",
            conclusion: "success",
            details_url: "https://example.test/build",
          },
          {
            id: 2,
            name: "test",
            head_sha: sha,
            status: "in_progress",
            conclusion: null,
            details_url: null,
          },
        ],
      },
    ]);
    const github = new GitHubClient(transport);

    const checks = await github.getChecksForCommit({ owner: "acme", repo: "widget" }, sha);

    expect(transport.requests[0]?.path).toBe(
      `/repos/acme/widget/commits/${sha}/check-runs?per_page=100`,
    );
    expect(checks).toEqual([
      {
        id: 1,
        name: "build",
        headSha: sha,
        status: "completed",
        conclusion: "success",
        detailsUrl: "https://example.test/build",
      },
      {
        id: 2,
        name: "test",
        headSha: sha,
        status: "in_progress",
        conclusion: null,
        detailsUrl: null,
      },
    ]);
  });

  it("proves repository permissions and protected required checks", async () => {
    const transport = new FakeGitHubTransport([
      { default_branch: "main", permissions: { push: true } },
      { required_status_checks: { contexts: ["verify"] } },
    ]);
    const github = new GitHubClient(transport);

    await expect(
      github.getRepositorySafety({ owner: "acme", repo: "widget" }, "main"),
    ).resolves.toEqual({
      defaultBranch: "main",
      canPush: true,
      branchProtected: true,
      requiredCheckNames: ["verify"],
    });
    expect(transport.requests.map((request) => request.path)).toEqual([
      "/repos/acme/widget",
      "/repos/acme/widget/branches/main/protection",
    ]);
  });

  it("fails sandbox availability closed off Darwin or without sandbox-exec", () => {
    const workspace = path.join(root, "workspace");
    fs.mkdirSync(workspace);
    const commands = { echo: { executable: "/bin/echo", args: ["safe"] } };

    const nonDarwin = new DarwinSandbox({
      workspace,
      commands,
      platform: "linux",
      isExecutable: () => true,
    });
    expect(nonDarwin.availability()).toEqual({
      available: false,
      reason: "sandbox-exec is only supported on Darwin",
    });

    const unavailable = new DarwinSandbox({
      workspace,
      commands,
      platform: "darwin",
      isExecutable: () => false,
    });
    expect(unavailable.availability()).toEqual({
      available: false,
      reason: "sandbox-exec is unavailable or not executable",
    });
  });

  it("uses a default-deny, no-network profile with bounded preconfigured argv", async () => {
    const workspace = path.join(root, "workspace");
    fs.mkdirSync(workspace);
    const runner = new FakeProcessRunner();
    const sandbox = new DarwinSandbox({
      workspace,
      commands: { echo: { executable: "/bin/echo", args: ["fixed;not-shell"] } },
      runner,
      platform: "darwin",
      isExecutable: () => true,
      timeoutMs: 1_234,
      maxOutputBytes: 4_321,
    });

    await expect(sandbox.run("unconfigured")).rejects.toThrow("not preconfigured");
    await sandbox.run("echo");

    const request = runner.requests[0];
    const profile = request?.args[1];
    expect(profile).toContain("(deny default)");
    expect(profile).toContain("(deny network*)");
    expect(profile).toContain('(allow file-read-data (literal "/"))');
    expect(profile).toContain(
      `(allow file-read-metadata (literal ${JSON.stringify(path.dirname(fs.realpathSync(workspace)))})`,
    );
    expect(profile).toContain(`(subpath ${JSON.stringify(fs.realpathSync(workspace))})`);
    expect(profile).not.toContain("(allow file-read*)");
    expect(profile).not.toContain("(allow network");
    expect(request?.args.slice(2)).toEqual([fs.realpathSync("/bin/echo"), "fixed;not-shell"]);
    expect(request?.timeoutMs).toBe(1_234);
    expect(request?.maxOutputBytes).toBe(4_321);
    expect(request?.env?.HOME).not.toBe(process.env.HOME);
    expect(request?.env?.HOME).toMatch(
      new RegExp(`^${escapeRegex(fs.realpathSync(os.tmpdir()))}${path.sep}`),
    );
  });

  it("allows Node to traverse only runtime path ancestors on Darwin", async () => {
    if (process.platform !== "darwin" || !fs.existsSync("/usr/bin/sandbox-exec")) return;
    const workspace = path.join(root, "node-runtime-workspace");
    fs.mkdirSync(workspace);
    const sandbox = new DarwinSandbox({
      workspace,
      commands: {
        node: {
          executable: fs.realpathSync(process.execPath),
          args: [
            "-e",
            "const fs=require('node:fs'),p=require('node:path');" +
              "fs.mkdirSync(p.join(process.env.HOME,'.npm','_logs'),{recursive:true});" +
              "process.stdout.write(process.version)",
          ],
        },
      },
    });

    const result = await sandbox.run("node");

    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stdout).toMatch(/^v\d+\.\d+\.\d+/u);
  });

  it("keeps local quality gates bounded with a ten-minute default", async () => {
    const workspace = path.join(root, "bounded-gate-workspace");
    fs.mkdirSync(workspace);
    const runner = new FakeProcessRunner();
    const sandbox = new DarwinSandbox({
      workspace,
      commands: { echo: { executable: "/bin/echo", args: ["safe"] } },
      runner,
      platform: "darwin",
      isExecutable: () => true,
    });

    await sandbox.run("echo");

    expect(runner.requests[0]?.timeoutMs).toBe(10 * 60_000);
  });

  it("escapes paths embedded in sandbox profiles", () => {
    const profile = buildDarwinSandboxProfile(
      '/tmp/workspace") (allow network*) ("',
      "/tmp/home",
      "/bin/echo",
    );
    expect(profile).toContain(
      `(subpath ${JSON.stringify('/tmp/workspace") (allow network*) ("')})`,
    );
    expect(profile.split("\n").some((line) => line.startsWith("(allow network"))).toBe(false);
  });
});

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
