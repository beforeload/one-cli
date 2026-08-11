import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ReleaseManager,
  Supervisor,
  type ReleaseCandidateBinding,
  type ReleaseManifest,
} from "../../src/autonomy/release.js";
import type {
  ProcessRequest,
  ProcessResult,
  ProcessRunner,
} from "../../src/autonomy/process.js";
import { makeTempDir, removeTempDir } from "../helpers.js";

const FIRST_SHA = "a".repeat(40);
const SECOND_SHA = "b".repeat(40);

function binding(sha: string): ReleaseCandidateBinding {
  return {
    attemptId: `attempt-${sha.slice(0, 8)}`,
    issueDigest: "c".repeat(64),
    policyHash: "d".repeat(64),
    headSha: sha,
  };
}

class ReleaseRunner implements ProcessRunner {
  readonly requests: ProcessRequest[] = [];
  readonly daemonResults: ProcessResult[] = [];
  headSha = FIRST_SHA;

  async run(request: ProcessRequest): Promise<ProcessResult> {
    this.requests.push(request);
    if (request.args[0] === "rev-parse") return result({ stdout: `${this.headSha}\n` });
    if (request.args[0] === "status") return result();
    return this.daemonResults.shift() ?? result({ durationMs: 60_000 });
  }
}

function result(overrides: Partial<ProcessResult> = {}): ProcessResult {
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

function createArtifact(root: string, marker: string): string {
  const worktree = path.join(root, `worktree-${marker}`);
  fs.mkdirSync(path.join(worktree, "dist"), { recursive: true });
  fs.mkdirSync(path.join(worktree, "node_modules", "production-dependency"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(worktree, "package.json"),
    JSON.stringify({
      name: "one-cli",
      bin: { "one-cli": "./dist/index.js" },
      dependencies: { "production-dependency": "1.0.0" },
    }),
  );
  fs.writeFileSync(path.join(worktree, "dist", "index.js"), `console.log(${JSON.stringify(marker)});\n`);
  fs.writeFileSync(
    path.join(worktree, "node_modules", "production-dependency", "index.js"),
    `export default ${JSON.stringify(marker)};\n`,
  );
  return worktree;
}

function makeTreeWritable(directory: string): void {
  if (!fs.existsSync(directory)) return;
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) return;
  fs.chmodSync(directory, 0o700);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const nested = path.join(directory, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) makeTreeWritable(nested);
    else if (!entry.isSymbolicLink()) fs.chmodSync(nested, 0o600);
  }
}

async function activate(
  releases: ReleaseManager,
  runner: ReleaseRunner,
  root: string,
  sha: string,
  marker: string,
): Promise<void> {
  runner.headSha = sha;
  await releases.stage({
    worktreePath: createArtifact(root, marker),
    commitSha: sha,
    binding: binding(sha),
  });
  releases.markCanarySuccess(sha);
  releases.promote(sha, 1, binding(sha));
}

describe("immutable autonomy releases", () => {
  let root: string;
  let releasesDir: string;
  let runner: ReleaseRunner;
  let releases: ReleaseManager;

  beforeEach(() => {
    root = makeTempDir("autonomy-release");
    releasesDir = path.join(root, "private-releases");
    runner = new ReleaseRunner();
    releases = new ReleaseManager({ releasesDir, runner, maxFiles: 100, maxBytes: 1024 * 1024 });
  });

  afterEach(() => {
    makeTreeWritable(root);
    removeTempDir(root);
  });

  it("rejects symlinks and traversal entrypoints", async () => {
    const symlinked = createArtifact(root, "symlink");
    const outside = path.join(root, "outside.js");
    fs.writeFileSync(outside, "outside");
    fs.unlinkSync(path.join(symlinked, "dist", "index.js"));
    fs.symlinkSync(outside, path.join(symlinked, "dist", "index.js"));

    await expect(
      releases.stage({
        worktreePath: symlinked,
        commitSha: FIRST_SHA,
        binding: binding(FIRST_SHA),
      }),
    ).rejects.toThrow(/symbolic link/u);
    expect(fs.existsSync(path.join(releasesDir, FIRST_SHA))).toBe(false);

    const traversing = createArtifact(root, "traversal");
    fs.writeFileSync(
      path.join(traversing, "package.json"),
      JSON.stringify({ name: "one-cli", bin: { "one-cli": "../outside.js" } }),
    );
    await expect(
      releases.stage({
        worktreePath: traversing,
        commitSha: FIRST_SHA,
        binding: binding(FIRST_SHA),
      }),
    ).rejects.toThrow(/traversal/u);
    expect(fs.existsSync(path.join(releasesDir, FIRST_SHA))).toBe(false);
  });

  it("omits npm node_modules/.bin shims while still rejecting other symlinks", async () => {
    const worktree = createArtifact(root, "npm-bin");
    const binDir = path.join(worktree, "node_modules", ".bin");
    const target = path.join(worktree, "node_modules", "production-dependency", "index.js");
    fs.mkdirSync(binDir, { recursive: true });
    fs.symlinkSync(path.relative(binDir, target), path.join(binDir, "prod-dep"));

    const staged = await releases.stage({
      worktreePath: worktree,
      commitSha: FIRST_SHA,
      binding: binding(FIRST_SHA),
    });
    expect(fs.existsSync(path.join(staged.releasePath, "node_modules", ".bin"))).toBe(false);
    expect(
      JSON.parse(fs.readFileSync(path.join(staged.releasePath, "manifest.json"), "utf8")).files.map(
        (file: { path: string }) => file.path,
      ),
    ).toEqual([
      "dist/index.js",
      "node_modules/production-dependency/index.js",
      "package.json",
    ]);

    const sneaky = createArtifact(root, "sneaky-link");
    fs.symlinkSync(
      path.join(sneaky, "node_modules", "production-dependency", "index.js"),
      path.join(sneaky, "node_modules", "sneaky-link"),
    );
    runner.headSha = SECOND_SHA;
    await expect(
      releases.stage({
        worktreePath: sneaky,
        commitSha: SECOND_SHA,
        binding: binding(SECOND_SHA),
      }),
    ).rejects.toThrow(/symbolic link/u);
  });

  it("manifests every payload file and detects later tampering", async () => {
    const worktree = createArtifact(root, "integrity");
    const staged = await releases.stage({
      worktreePath: worktree,
      commitSha: FIRST_SHA,
      binding: binding(FIRST_SHA),
    });
    const manifest = JSON.parse(
      fs.readFileSync(path.join(staged.releasePath, "manifest.json"), "utf8"),
    ) as ReleaseManifest;

    expect(manifest.files.map((file) => file.path)).toEqual([
      "dist/index.js",
      "node_modules/production-dependency/index.js",
      "package.json",
    ]);
    expect(manifest.totalBytes).toBe(
      manifest.files.reduce((total, file) => total + file.bytes, 0),
    );
    expect(manifest.files.every((file) => /^[0-9a-f]{64}$/u.test(file.sha256))).toBe(true);
    expect(fs.statSync(releasesDir).mode & 0o077).toBe(0);

    const entrypoint = path.join(staged.releasePath, "dist", "index.js");
    fs.chmodSync(entrypoint, 0o644);
    fs.appendFileSync(entrypoint, "tampered\n");
    expect(() => releases.resolveEntrypoint(FIRST_SHA)).toThrow(/differs from manifest/u);
  });

  it("requires the expected candidate and promotion success threshold", async () => {
    await releases.stage({
      worktreePath: createArtifact(root, "candidate"),
      commitSha: FIRST_SHA,
      binding: binding(FIRST_SHA),
    });

    expect(() => releases.promote(FIRST_SHA, 2, binding(FIRST_SHA))).toThrow(/2 required/u);
    expect(() => releases.markCanarySuccess(SECOND_SHA)).toThrow(/Candidate SHA changed/u);
    releases.markCanarySuccess(FIRST_SHA);
    expect(() => releases.promote(FIRST_SHA, 2, binding(FIRST_SHA))).toThrow(/2 required/u);
    releases.markCanarySuccess(FIRST_SHA);

    expect(() =>
      releases.promote(FIRST_SHA, 2, {
        ...binding(FIRST_SHA),
        attemptId: "stale-attempt",
      }),
    ).toThrow(/binding changed/u);
    const promoted = releases.promote(FIRST_SHA, 2, binding(FIRST_SHA));
    expect(promoted).toMatchObject({
      active: FIRST_SHA,
      previous: null,
      candidate: null,
      activeFailures: 0,
    });
    expect(releases.resolveEntrypoint()).toBe(
      path.join(releasesDir, FIRST_SHA, "dist", "index.js"),
    );
  });

  it("rolls back to and preserves the N-1 release", async () => {
    await activate(releases, runner, root, FIRST_SHA, "first");
    await activate(releases, runner, root, SECOND_SHA, "second");
    expect(releases.status()).toMatchObject({ active: SECOND_SHA, previous: FIRST_SHA });

    const rolledBack = releases.rollback(SECOND_SHA);
    expect(rolledBack).toMatchObject({ active: FIRST_SHA, previous: SECOND_SHA });
    expect(fs.existsSync(path.join(releasesDir, SECOND_SHA, "dist", "index.js"))).toBe(true);
  });

  it("supervisor uses argv and atomically rolls back a crash loop", async () => {
    await activate(releases, runner, root, FIRST_SHA, "first");
    await activate(releases, runner, root, SECOND_SHA, "second");
    runner.daemonResults.push(
      result({ exitCode: 1, durationMs: 10 }),
      result({ exitCode: 1, durationMs: 10 }),
      result({ exitCode: 1, durationMs: 10 }),
    );
    const supervisor = new Supervisor({
      releases,
      runner,
      nodeExecutable: "/safe/node;not-a-shell",
      healthyThresholdMs: 1_000,
      crashFailureThreshold: 3,
    });

    expect((await supervisor.launch(["--label", "$(touch nope)"])).rolledBack).toBe(false);
    expect((await supervisor.launch()).rolledBack).toBe(false);
    const third = await supervisor.launch();

    expect(third.rolledBack).toBe(true);
    expect(third.status).toMatchObject({ active: FIRST_SHA, previous: SECOND_SHA });
    expect(third.status.health[SECOND_SHA]?.failures).toBe(3);
    const daemonRequest = runner.requests.find(
      (request) => request.args[1] === "autonomy" && request.args[2] === "daemon",
    );
    expect(daemonRequest).toMatchObject({
      executable: "/safe/node;not-a-shell",
      args: [
        path.join(releasesDir, SECOND_SHA, "dist", "index.js"),
        "autonomy",
        "daemon",
        "--label",
        "$(touch nope)",
      ],
    });
  });

  it("resets consecutive early-exit streak after a healthy run", async () => {
    await activate(releases, runner, root, FIRST_SHA, "first");
    await activate(releases, runner, root, SECOND_SHA, "second");
    const supervisor = new Supervisor({
      releases,
      runner,
      healthyThresholdMs: 1_000,
      crashFailureThreshold: 3,
    });
    runner.daemonResults.push(
      result({ exitCode: 1, durationMs: 10 }),
      result({ exitCode: 0, durationMs: 2_000 }),
      result({ exitCode: 1, durationMs: 10 }),
      result({ exitCode: 1, durationMs: 10 }),
    );
    expect((await supervisor.launch()).status.activeEarlyExitStreak).toBe(1);
    expect((await supervisor.launch()).status.activeEarlyExitStreak).toBe(0);
    expect((await supervisor.launch()).rolledBack).toBe(false);
    expect((await supervisor.launch()).rolledBack).toBe(false);
    expect(releases.status()).toMatchObject({
      active: SECOND_SHA,
      activeEarlyExitStreak: 2,
    });
  });

  it("ignores torn temporary state and never accepts malformed committed state", async () => {
    await activate(releases, runner, root, FIRST_SHA, "state");
    const stable = releases.status();
    fs.writeFileSync(path.join(releasesDir, ".state-interrupted.tmp"), '{"active":');

    expect(releases.status()).toEqual(stable);
    const statePath = path.join(releasesDir, "state.json");
    const validState = fs.readFileSync(statePath);
    const legacy = JSON.parse(validState.toString("utf8")) as Record<string, unknown>;
    delete legacy.earlyExitStreak;
    delete legacy.candidateBinding;
    fs.writeFileSync(statePath, JSON.stringify(legacy));
    expect(releases.status()).toMatchObject({ activeEarlyExitStreak: 0 });

    fs.writeFileSync(statePath, '{"active":');
    expect(() => releases.status()).toThrow(/malformed/u);

    fs.writeFileSync(statePath, validState);
    expect(releases.status()).toEqual(stable);
  });
});
