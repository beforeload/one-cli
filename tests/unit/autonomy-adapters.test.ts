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
import { signalProcessGroup } from "../../src/autonomy/process.js";
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
    // No loopback network grant may be present: an independent verifier vetoed
    // loopback allows in network=false profiles, so the profile stays strictly
    // deny-default for every address including localhost.
    expect(profile).not.toContain('(allow network-bind (local ip "localhost:*"))');
    expect(profile).not.toContain('(allow network-inbound (local ip "localhost:*"))');
    expect(profile).not.toContain('(allow network-outbound (remote ip "localhost:*"))');
    expect(profile?.split("\n")).not.toContain("(allow network-outbound)");
    expect(profile?.split("\n")).not.toContain("(allow network-inbound)");
    expect(profile?.split("\n")).not.toContain("(allow network*)");
    expect(profile?.split("\n").some((line) => line.startsWith("(allow network"))).toBe(false);
    expect(request?.args.slice(2)).toEqual([fs.realpathSync("/bin/echo"), "fixed;not-shell"]);
    expect(request?.timeoutMs).toBe(1_234);
    expect(request?.maxOutputBytes).toBe(4_321);
    expect(request?.env?.HOME).not.toBe(process.env.HOME);
    expect(request?.env?.HOME).toMatch(
      new RegExp(`^${escapeRegex(fs.realpathSync(os.tmpdir()))}${path.sep}`),
    );
  });

  it("allows Node to traverse only runtime path ancestors on Darwin", async () => {
    // A live sandbox-exec run cannot be nested: when the unit gate itself runs
    // under the DarwinSandbox (signalled by ONE_CLI_SANDBOXED=1), starting a
    // second sandbox-exec layer is rejected by macOS and would fail closed.
    // Skip the live exec here while still exercising the profile shape below.
    if (
      process.platform !== "darwin" ||
      process.env.ONE_CLI_SANDBOXED === "1" ||
      !fs.existsSync("/usr/bin/sandbox-exec")
    ) {
      return;
    }
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

  it("injects only a credential-free loopback proxy for network-enabled gates", async () => {
    const workspace = path.join(root, "proxied-gate-workspace");
    fs.mkdirSync(workspace);
    const runner = new FakeProcessRunner();
    const sandbox = new DarwinSandbox({
      workspace,
      commands: {
        install: { executable: "/bin/echo", args: ["install"], network: true },
        build: { executable: "/bin/echo", args: ["build"] },
      },
      runner,
      platform: "darwin",
      isExecutable: () => true,
      networkProxy: "http://127.0.0.1:9674",
    });

    await sandbox.run("install");
    await sandbox.run("build");

    expect(runner.requests[0]?.env).toMatchObject({
      HTTP_PROXY: "http://127.0.0.1:9674/",
      HTTPS_PROXY: "http://127.0.0.1:9674/",
      NO_PROXY: "127.0.0.1,localhost",
    });
    expect(runner.requests[1]?.env).not.toHaveProperty("HTTP_PROXY");
    for (const invalid of [
      "https://127.0.0.1:9674",
      "http://example.com:9674",
      "http://user:password@127.0.0.1:9674",
      "http://127.0.0.1:9674/path",
    ]) {
      expect(() => new DarwinSandbox({
        workspace,
        commands: {},
        platform: "darwin",
        isExecutable: () => true,
        networkProxy: invalid,
      })).toThrow("credential-free loopback HTTP");
    }
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
    // The injected `(allow network*)` must not escape the escaped string into a
    // real profile line. Scoped loopback grants are expected, but no
    // unrestricted network grant may appear on its own line.
    const escapeLines = profile.split("\n");
    expect(escapeLines).not.toContain("(allow network*)");
    expect(escapeLines).not.toContain("(allow network-outbound)");
    expect(escapeLines).not.toContain("(allow network-inbound)");
    expect(
      escapeLines.some(
        (line) => line.startsWith("(allow network") && !line.includes('ip "localhost:*"'),
      ),
    ).toBe(false);
  });

  it("allows sandboxed tooling to exec helpers only inside its own scratch home", () => {
    const profile = buildDarwinSandboxProfile("/tmp/workspace", "/tmp/home", "/bin/echo");
    const lines = profile.split("\n");
    // Nested sandboxed Node (for example npm materializing and running a helper
    // under $HOME/.npm) must be able to exec files it wrote to the temporary
    // HOME; otherwise it exits with EX_OSERR (71). The grant is scoped strictly
    // to the per-run scratch home so deny-default still blocks the rest of disk.
    expect(lines).toContain('(allow process-exec (subpath "/tmp/home"))');
    // The workspace and the fixed executable remain exec-allowed as before.
    expect(lines).toContain('(allow process-exec (subpath "/tmp/workspace"))');
    expect(lines).toContain('(allow process-exec (literal "/bin/echo"))');
    // No process-exec grant may leak outside the sandbox's own scoped roots.
    expect(
      lines.some(
        (line) => line.startsWith("(allow process-exec") && !line.includes("(literal ") && !line.includes("(subpath "),
      ),
    ).toBe(false);
    expect(lines).toContain("(deny default)");
  });

  it("marks sandboxed descendants so nested sandbox-exec layers are avoided", async () => {
    const workspace = path.join(root, "sandboxed-marker-workspace");
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

    expect(runner.requests[0]?.env?.ONE_CLI_SANDBOXED).toBe("1");
  });

  it("grants sandboxed processes signal rights over only their own descendants", () => {
    const profile = buildDarwinSandboxProfile("/tmp/workspace", "/tmp/home", "/bin/echo");
    const lines = profile.split("\n");
    expect(lines).toContain("(allow signal (target self))");
    expect(lines).toContain("(allow signal (target children))");
    // Process-group termination must reach grandchildren (vitest fork/tinypool
    // workers), which share the sandboxed leader's process group but are not
    // direct children; (target pgrp) authorizes exactly that tree.
    expect(lines).toContain("(allow signal (target pgrp))");
    // Deny-default must remain and no unscoped signal grant may leak in.
    expect(lines).toContain("(deny default)");
    expect(lines.some((line) => line.startsWith("(allow signal") && !line.includes("target"))).toBe(
      false,
    );
    // No signal grant may target processes outside the sandbox's own tree.
    expect(
      lines.some(
        (line) =>
          line.startsWith("(allow signal") &&
          (line.includes("target others") || line.includes("target all")),
      ),
    ).toBe(false);
    // The signal grants are emitted alongside the process controls, after fork.
    expect(profile.indexOf("(allow process-fork)")).toBeLessThan(
      profile.indexOf("(allow signal (target self))"),
    );
    expect(profile.indexOf("(allow signal (target self))")).toBeLessThan(
      profile.indexOf("(allow signal (target pgrp))"),
    );
  });

  it("keeps the sandbox signal grant present for network-enabled install gates", () => {
    const profile = buildDarwinSandboxProfile("/tmp/workspace", "/tmp/home", "/bin/echo", true);
    const lines = profile.split("\n");
    expect(lines).toContain("(allow signal (target children))");
    expect(lines).toContain("(allow signal (target pgrp))");
    expect(lines).toContain("(allow network-outbound)");
    expect(lines).toContain("(allow network-inbound)");
    expect(lines).toContain("(deny default)");
  });

  it("keeps all network denied including loopback for non-install gates", () => {
    // Regression guard: an independent verifier vetoed loopback allows in
    // network=false profiles. Sandboxed gates that need an in-process fake
    // provider must skip those cases under ONE_CLI_SANDBOXED=1 instead of
    // opening a loopback bind, so the profile emits no network allow at all and
    // the blanket (deny network*) keeps every address — including localhost —
    // denied by default.
    const profile = buildDarwinSandboxProfile("/tmp/workspace", "/tmp/home", "/bin/echo");
    const lines = profile.split("\n");
    expect(lines).not.toContain('(allow network-bind (local ip "localhost:*"))');
    expect(lines).not.toContain('(allow network-inbound (local ip "localhost:*"))');
    expect(lines).not.toContain('(allow network-outbound (remote ip "localhost:*"))');
    // Deny-default remains, and the residual blanket network denial forbids
    // every address with no network allow leaking in.
    expect(lines).toContain("(deny default)");
    expect(lines).toContain("(deny network*)");
    expect(lines.some((line) => line.startsWith("(allow network"))).toBe(false);
  });

  it("terminates the whole process group so sandboxed fork workers are not orphaned", () => {
    const targets: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    let directKills = 0;
    const child = {
      pid: 4242,
      kill: (): boolean => {
        directKills += 1;
        return true;
      },
    };

    signalProcessGroup(child as never, "SIGTERM", (pid, signal) => {
      targets.push({ pid, signal });
    });

    if (process.platform === "win32") {
      expect(targets).toEqual([]);
    } else {
      // A successful process-group signal reaches every descendant sharing the
      // group (including grandchild vitest workers) and must not fall back to a
      // direct child-only kill that would leave grandchildren orphaned.
      expect(targets).toEqual([{ pid: -4242, signal: "SIGTERM" }]);
      expect(directKills).toBe(0);
    }
  });

  it("falls back to the direct child when the process-group signal is denied (EPERM)", () => {
    if (process.platform === "win32") return;
    const groupCalls: number[] = [];
    let directKills = 0;
    const child = {
      pid: 5150,
      kill: (): boolean => {
        directKills += 1;
        return true;
      },
    };

    signalProcessGroup(child as never, "SIGKILL", (pid) => {
      groupCalls.push(pid);
      const error = new Error("kill EPERM") as NodeJS.ErrnoException;
      error.code = "EPERM";
      throw error;
    });

    expect(groupCalls).toEqual([-5150]);
    expect(directKills).toBe(1);
  });

  it("stops retrying when the process group has already exited (ESRCH)", () => {
    if (process.platform === "win32") return;
    let directKills = 0;
    const child = {
      pid: 6060,
      kill: (): boolean => {
        directKills += 1;
        return true;
      },
    };

    signalProcessGroup(child as never, "SIGTERM", () => {
      const error = new Error("kill ESRCH") as NodeJS.ErrnoException;
      error.code = "ESRCH";
      throw error;
    });

    expect(directKills).toBe(0);
  });

  it("signals the child directly when no pid is available", () => {
    let directSignal: NodeJS.Signals | undefined;
    const child = {
      pid: undefined,
      kill: (signal: NodeJS.Signals): boolean => {
        directSignal = signal;
        return true;
      },
    };

    signalProcessGroup(child as never, "SIGTERM", () => {
      throw new Error("must not signal a group without a pid");
    });

    expect(directSignal).toBe("SIGTERM");
  });

  it("accepts a spawn-shaped child whose pid may be undefined without a cast", () => {
    // Regression guard for TS2379 under exactOptionalPropertyTypes: a spawned
    // ChildProcess exposes `pid?: number | undefined`, so signalProcessGroup's
    // parameter must accept an optional pid that explicitly allows undefined.
    // This object is typed exactly like that contract and is passed with no
    // `as never` cast, so a narrower `pid?: number` signature would fail to
    // compile the unit gate.
    const child: { readonly pid?: number | undefined; kill(signal: NodeJS.Signals): boolean } = {
      pid: 7070,
      kill: (): boolean => true,
    };
    const groupTargets: Array<{ pid: number; signal: NodeJS.Signals }> = [];

    signalProcessGroup(child, "SIGTERM", (pid, signal) => {
      groupTargets.push({ pid, signal });
    });

    if (process.platform === "win32") {
      expect(groupTargets).toEqual([]);
    } else {
      expect(groupTargets).toEqual([{ pid: -7070, signal: "SIGTERM" }]);
    }
  });

  it("signals a spawn-shaped child directly when its pid resolves to undefined", () => {
    // The same spawn contract also permits pid === undefined (for example when
    // the spawn failed). The whole-group path must be skipped and the direct
    // child signalled, again with no cast so the type contract is exercised.
    const directSignals: NodeJS.Signals[] = [];
    const child: { readonly pid?: number | undefined; kill(signal: NodeJS.Signals): boolean } = {
      pid: undefined,
      kill: (signal: NodeJS.Signals): boolean => {
        directSignals.push(signal);
        return true;
      },
    };

    signalProcessGroup(child, "SIGKILL", () => {
      throw new Error("must not signal a group when pid is undefined");
    });

    expect(directSignals).toEqual(["SIGKILL"]);
  });
});

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
