import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HarnessRelease } from "./release.js";
import type { ProcessRunner } from "./runner.js";
import { requireSuccess } from "./runner.js";
import type { IndependentVerifierPolicy } from "./verifier.js";

export interface WorkerPolicyReadiness {
  readonly ready: boolean;
  readonly detail: string;
  readonly release: WorkerReleaseInspection | null;
}

export interface WorkerReleaseInspection {
  readonly bootstrap: boolean;
  readonly sha: string;
  readonly entrypoint: string;
  readonly entrypointSha256: string;
  readonly manifestSha256: string;
  readonly moduleHashes: Readonly<Record<string, string>>;
}

export interface WorkerPolicyReadinessPort {
  inspect(signal?: AbortSignal): Promise<WorkerPolicyReadiness>;
}

export const WORKER_CONTROL_PATHS = [
  "src/agent.ts",
  "src/approval.ts",
  "src/autonomy/cli.ts",
  "src/autonomy/intake.ts",
  "src/autonomy/maintenance.ts",
  "src/autonomy/orchestrator.ts",
  "src/autonomy/roadmap-enforcement.ts",
  "src/autonomy/worker.ts",
  "src/policy.ts",
  "src/tools.ts",
  "src/workspace.ts",
] as const;

const RUNTIME_MODULES = [
  "dist/index.js",
  ...WORKER_CONTROL_PATHS.map((sourcePath) =>
    sourcePath.replace(/^src\//u, "dist/").replace(/\.ts$/u, ".js")
  ),
] as const;

export interface InspectWorkerPolicyInput {
  readonly workspace: string;
  readonly release: HarnessRelease;
  readonly policy: IndependentVerifierPolicy;
  readonly runner: ProcessRunner;
  readonly nodeExecutable?: string;
  readonly gitExecutable?: string;
  readonly signal?: AbortSignal;
}

export interface WorkerReleaseReadinessOptions {
  readonly workspace: string;
  readonly policy: IndependentVerifierPolicy;
  readonly runner: ProcessRunner;
  readonly releaseResolver: () => HarnessRelease;
  readonly nodeExecutable?: string;
  readonly gitExecutable?: string;
  readonly handoffSha?: () => string | undefined;
  readonly assertDescendsFrom?: (
    ancestorSha: string,
    descendantSha: string,
    signal?: AbortSignal,
  ) => Promise<void>;
}

export class WorkerReleaseReadiness implements WorkerPolicyReadinessPort {
  private inspected: WorkerReleaseInspection | undefined;

  constructor(private readonly options: WorkerReleaseReadinessOptions) {}

  async inspect(signal?: AbortSignal): Promise<WorkerPolicyReadiness> {
    const release = this.options.releaseResolver();
    const result = await inspectWorkerPolicy({
      workspace: this.options.workspace,
      release,
      policy: this.options.policy,
      runner: this.options.runner,
      ...(this.options.nodeExecutable ? { nodeExecutable: this.options.nodeExecutable } : {}),
      ...(this.options.gitExecutable ? { gitExecutable: this.options.gitExecutable } : {}),
      ...(signal ? { signal } : {}),
    });
    if (result.ready && result.release) {
      try {
        await this.inspectLineage(result.release, signal);
        this.inspected = result.release;
        return result;
      } catch (error) {
        this.inspected = undefined;
        return {
          ready: false,
          detail: message(error),
          release: result.release,
        };
      }
    }
    this.inspected = undefined;
    return result;
  }

  executableRelease(): HarnessRelease {
    if (!this.inspected) {
      throw new Error("Product release has not passed executable-bound readiness");
    }
    const release = this.options.releaseResolver();
    const expected = this.inspected;
    if (
      release.bootstrap !== expected.bootstrap ||
      release.entrypoint !== expected.entrypoint ||
      (!release.bootstrap && release.sha !== expected.sha) ||
      (!release.bootstrap && release.manifestSha256 !== expected.manifestSha256)
    ) {
      throw new Error("Executable release changed after readiness inspection");
    }
    for (const [relativePath, expectedHash] of Object.entries(expected.moduleHashes)) {
      const actualHash = hashStaticFile(release.root, relativePath);
      if (actualHash !== expectedHash) {
        throw new Error(`Executable release module changed after readiness: ${relativePath}`);
      }
    }
    return release;
  }

  private async inspectLineage(
    release: WorkerReleaseInspection,
    signal?: AbortSignal,
  ): Promise<void> {
    const handoffSha = this.options.handoffSha?.();
    if (!handoffSha) return;
    if (release.bootstrap) {
      throw new Error("Bootstrap release is forbidden after durable roadmap handoff");
    }
    if (release.sha === handoffSha) return;
    if (!this.options.assertDescendsFrom) {
      throw new Error("Immutable release lineage cannot be verified");
    }
    await this.options.assertDescendsFrom(handoffSha, release.sha, signal);
  }
}

export async function inspectWorkerPolicy(
  input: InspectWorkerPolicyInput,
): Promise<WorkerPolicyReadiness> {
  let inspection: WorkerReleaseInspection | null = null;
  try {
    for (const protectedPath of WORKER_CONTROL_PATHS) {
      if (!input.policy.protectedPaths.exact.includes(protectedPath)) {
        throw new Error(`verifier policy does not protect ${protectedPath}`);
      }
    }
    inspection = input.release.bootstrap
      ? await inspectBootstrap(input)
      : inspectImmutable(input.release);
    inspectCompiledPolicy(input.release.root);
    return {
      ready: true,
      detail: "shell/network tools disabled; exact write paths and protected control closure enforced",
      release: inspection,
    };
  } catch (error) {
    return {
      ready: false,
      detail: message(error),
      release: inspection,
    };
  }
}

async function inspectBootstrap(
  input: InspectWorkerPolicyInput,
): Promise<WorkerReleaseInspection> {
  const workspace = fs.realpathSync(input.workspace);
  if (input.release.root !== workspace || input.release.entrypoint !== path.join(workspace, "dist/index.js")) {
    throw new Error("Bootstrap release is not the workspace dist entrypoint");
  }
  const gitExecutable = input.gitExecutable ?? "git";
  const beforeSha = await readGitHead(input.runner, gitExecutable, workspace, input.signal);
  await assertCleanHead(input.runner, gitExecutable, workspace, input.signal);
  const temporary = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "one-cli-readiness-build-")),
  );
  try {
    const compiler = path.join(workspace, "node_modules", "typescript", "bin", "tsc");
    readBoundedRegular(compiler, "TypeScript compiler", 1024 * 1024);
    requireSuccess(
      "reproducible bootstrap build",
      await input.runner.run({
        executable: input.nodeExecutable ?? process.execPath,
        args: [compiler, "-p", path.join(workspace, "tsconfig.build.json"), "--outDir", temporary],
        cwd: workspace,
        env: compilerEnvironment(),
        timeoutMs: 5 * 60_000,
        maxOutputBytes: 2 * 1024 * 1024,
        ...(input.signal ? { signal: input.signal } : {}),
      }),
    );
    const moduleHashes: Record<string, string> = {};
    for (const relativePath of RUNTIME_MODULES) {
      const actual = hashStaticFile(workspace, relativePath);
      const rebuilt = hashStaticFile(temporary, relativePath.replace(/^dist\//u, ""));
      if (actual !== rebuilt) {
        throw new Error(`Bootstrap dist is stale or non-reproducible: ${relativePath}`);
      }
      moduleHashes[relativePath] = actual;
    }
    const afterSha = await readGitHead(input.runner, gitExecutable, workspace, input.signal);
    await assertCleanHead(input.runner, gitExecutable, workspace, input.signal);
    if (afterSha !== beforeSha) throw new Error("Bootstrap HEAD changed during readiness inspection");
    return releaseInspection(
      input.release,
      beforeSha,
      bootstrapManifestHash(beforeSha, moduleHashes),
      moduleHashes,
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function inspectImmutable(release: HarnessRelease): WorkerReleaseInspection {
  if (
    release.bootstrap ||
    !release.sha ||
    !release.manifestSha256 ||
    !/^[0-9a-f]{40,64}$/u.test(release.sha) ||
    !/^[0-9a-f]{64}$/u.test(release.manifestSha256)
  ) {
    throw new Error("Immutable release identity or manifest is invalid");
  }
  const manifestHashes = new Map(release.files.map((file) => [file.path, file.sha256]));
  const moduleHashes: Record<string, string> = {};
  for (const relativePath of RUNTIME_MODULES) {
    const expected = manifestHashes.get(relativePath);
    if (!expected) throw new Error(`Immutable release manifest lacks ${relativePath}`);
    const actual = hashStaticFile(release.root, relativePath);
    if (actual !== expected) {
      throw new Error(`Immutable release module differs from manifest: ${relativePath}`);
    }
    moduleHashes[relativePath] = actual;
  }
  return releaseInspection(release, release.sha, release.manifestSha256, moduleHashes);
}

function inspectCompiledPolicy(releaseRoot: string): void {
  const worker = readStaticModule(releaseRoot, "dist/autonomy/worker.js");
  for (const marker of [
    'new ToolRunner(undefined, ["shell"])',
    "allowedWritePaths: options.approvedPaths",
    "new DenyApprovalPort()",
    "Shell and network ",
    "tools are unavailable.",
  ]) {
    if (!worker.includes(marker)) throw new Error(`Worker policy lacks ${marker}`);
  }
  if (
    occurrences(worker, "new ToolRunner(") !== 1 ||
    occurrences(worker, "new Workspace(") !== 1 ||
    occurrences(worker, "allowedWritePaths: options.approvedPaths") !== 1 ||
    occurrences(worker, "new DenyApprovalPort()") !== 1 ||
    /\bfetch\s*\(|node:(?:child_process|dgram|dns|http|https|net|tls)|\bWebSocket\b/u.test(worker)
  ) {
    throw new Error("Compiled Worker contains an alternate shell, network, or write-policy path");
  }
  const orchestrator = readStaticModule(releaseRoot, "dist/autonomy/orchestrator.js");
  for (const marker of [
    'from "./worker.js"',
    "this.dependencies.worker ?? runAutonomyWorker",
    "{ approvedPaths: [...approvedPaths] }",
    "{ approvedPaths })",
  ]) {
    if (!orchestrator.includes(marker)) {
      throw new Error(`Worker orchestration lacks ${marker}`);
    }
  }
  const cli = readStaticModule(releaseRoot, "dist/autonomy/cli.js");
  if (!cli.includes("new AutonomyOrchestrator({")) {
    throw new Error("Compiled autonomy CLI lacks the protected orchestrator");
  }
  const entrypoint = readStaticModule(releaseRoot, "dist/index.js");
  if (!entrypoint.includes('from "./cli.js"')) {
    throw new Error("Release entrypoint does not load the compiled CLI");
  }
  const tools = readStaticModule(releaseRoot, "dist/tools.js");
  const toolNames = [...tools.matchAll(/^\s+name:\s+"([^"]+)",$/gmu)]
    .map((match) => match[1]);
  if (
    JSON.stringify(toolNames) !==
      JSON.stringify(["read", "list", "grep", "write", "edit", "shell"]) ||
    tools.includes('name: "network"') ||
    tools.includes('name: "http"')
  ) {
    throw new Error("Worker tool inventory is not the fixed file-only set plus excluded shell");
  }
  const workspaceSource = readStaticModule(releaseRoot, "dist/workspace.js");
  for (const marker of [
    "this.allowedWritePaths.has(resolved.relativePath)",
    "Path is outside the approved write binding",
    "Symlinks are not followed",
  ]) {
    if (!workspaceSource.includes(marker)) {
      throw new Error(`Workspace write policy lacks ${marker}`);
    }
  }
}

function releaseInspection(
  release: HarnessRelease,
  sha: string,
  manifestSha256: string,
  moduleHashes: Readonly<Record<string, string>>,
): WorkerReleaseInspection {
  return {
    bootstrap: release.bootstrap,
    sha,
    entrypoint: release.entrypoint,
    entrypointSha256: moduleHashes["dist/index.js"]!,
    manifestSha256,
    moduleHashes,
  };
}

function bootstrapManifestHash(
  commitSha: string,
  moduleHashes: Readonly<Record<string, string>>,
): string {
  return crypto.createHash("sha256").update(stableJson({
    commitSha,
    entrypoint: "dist/index.js",
    modules: moduleHashes,
  })).digest("hex");
}

function readStaticModule(root: string, relativePath: string): string {
  return readBoundedRegular(path.join(root, ...relativePath.split("/")), relativePath, 8 * 1024 * 1024)
    .toString("utf8");
}

function hashStaticFile(root: string, relativePath: string): string {
  const absolute = path.join(root, ...relativePath.split("/"));
  const bytes = readBoundedRegular(absolute, relativePath, 8 * 1024 * 1024);
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function readBoundedRegular(absolute: string, label: string, maxBytes: number): Buffer {
  const before = fs.lstatSync(absolute);
  if (before.isSymbolicLink() || !before.isFile() || before.size > maxBytes) {
    throw new Error(`${label} must be a bounded regular file`);
  }
  if (fs.realpathSync(absolute) !== absolute) {
    throw new Error(`${label} must be canonical`);
  }
  const descriptor = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size
    ) {
      throw new Error(`${label} changed while opening`);
    }
    return fs.readFileSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

async function readGitHead(
  runner: ProcessRunner,
  executable: string,
  workspace: string,
  signal?: AbortSignal,
): Promise<string> {
  const result = requireSuccess("git rev-parse bootstrap HEAD", await runner.run({
    executable,
    args: ["rev-parse", "--verify", "HEAD"],
    cwd: workspace,
    env: gitEnvironment(),
    timeoutMs: 15_000,
    maxOutputBytes: 64 * 1024,
    ...(signal ? { signal } : {}),
  }));
  const sha = result.stdout.trim();
  if (!/^[0-9a-f]{40,64}$/u.test(sha)) throw new Error("Bootstrap HEAD SHA is invalid");
  return sha;
}

async function assertCleanHead(
  runner: ProcessRunner,
  executable: string,
  workspace: string,
  signal?: AbortSignal,
): Promise<void> {
  const result = requireSuccess("git status bootstrap HEAD", await runner.run({
    executable,
    args: ["status", "--porcelain=v1", "--untracked-files=all"],
    cwd: workspace,
    env: gitEnvironment(),
    timeoutMs: 15_000,
    maxOutputBytes: 1024 * 1024,
    ...(signal ? { signal } : {}),
  }));
  if (result.stdout.length !== 0) {
    throw new Error("Bootstrap requires a clean current HEAD");
  }
}

function compilerEnvironment(): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {
    HOME: os.tmpdir(),
    PATH: process.env.PATH ?? "/usr/bin:/bin",
  };
  for (const name of ["LANG", "LC_ALL", "LC_CTYPE", "TMPDIR"]) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

function gitEnvironment(): Readonly<Record<string, string>> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    HOME: os.tmpdir(),
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function occurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}
