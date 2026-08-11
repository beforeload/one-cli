import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  SpawnProcessRunner,
  assertProcessSucceeded,
  type ProcessRequest,
  type ProcessResult,
  type ProcessRunner,
} from "./process.js";

const STATE_VERSION = 1;
const MANIFEST_VERSION = 1;
const STATE_FILE = "state.json";
const MANIFEST_FILE = "manifest.json";
const SHA_PATTERN = /^[0-9a-f]{40,64}$/u;

export interface ReleaseFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly executable: boolean;
}

export interface ReleaseManifest {
  readonly version: 1;
  readonly commitSha: string;
  readonly totalBytes: number;
  readonly files: readonly ReleaseFile[];
  readonly manifestSha256: string;
}

export interface ReleaseHealth {
  readonly successes: number;
  readonly failures: number;
}

export interface ReleaseStatus {
  readonly active: string | null;
  readonly previous: string | null;
  readonly candidate: string | null;
  readonly health: Readonly<Record<string, ReleaseHealth>>;
  readonly generation: number;
  readonly candidateSuccesses: number;
  readonly candidateFailures: number;
  readonly activeFailures: number;
  readonly activeEarlyExitStreak: number;
  readonly candidateBinding: ReleaseCandidateBinding | null;
}

interface ReleaseState {
  version: 1;
  active: string | null;
  previous: string | null;
  candidate: string | null;
  health: Record<string, { successes: number; failures: number }>;
  generation: number;
  earlyExitStreak: number;
  candidateBinding: ReleaseCandidateBinding | null;
}

export interface ReleaseCandidateBinding {
  readonly attemptId: string;
  readonly issueDigest: string;
  readonly policyHash: string;
  readonly headSha: string;
  readonly approval?: {
    readonly approvalId: string;
    readonly action: string;
    readonly bindingRef: string;
  };
}

export interface ReleaseManagerOptions {
  releasesDir: string;
  readOnly?: boolean;
  runner?: ProcessRunner;
  gitExecutable?: string;
  maxFiles?: number;
  maxBytes?: number;
  gitTimeoutMs?: number;
  gitMaxOutputBytes?: number;
}

export interface StageReleaseOptions {
  worktreePath: string;
  commitSha: string;
  binding: ReleaseCandidateBinding;
  signal?: AbortSignal;
}

export interface StagedRelease {
  readonly commitSha: string;
  readonly releasePath: string;
  readonly manifest: ReleaseManifest;
  readonly binding: ReleaseCandidateBinding;
}

export interface SupervisorOptions {
  releases?: ReleaseManager;
  releasesDir?: string;
  runner: ProcessRunner;
  nodeExecutable?: string;
  healthyThresholdMs?: number;
  crashFailureThreshold?: number;
  processTimeoutMs?: number;
  maxOutputBytes?: number;
  env?: Readonly<Record<string, string | undefined>>;
}

export interface SupervisorResult {
  readonly releaseSha: string;
  readonly process: ProcessResult;
  readonly earlyExit: boolean;
  readonly rolledBack: boolean;
  readonly status: ReleaseStatus;
}

/**
 * Stores immutable, content-addressed runtime releases under a host-private
 * directory. State changes are committed with fsync + atomic rename.
 */
export class ReleaseManager {
  readonly releasesDir: string;
  private readonly runner: ProcessRunner;
  private readonly gitExecutable: string;
  private readonly maxFiles: number;
  private readonly maxBytes: number;
  private readonly gitTimeoutMs: number;
  private readonly gitMaxOutputBytes: number;

  constructor(options: ReleaseManagerOptions) {
    if (!path.isAbsolute(options.releasesDir)) {
      throw new Error("Releases directory must be absolute");
    }
    this.runner = options.runner ?? new SpawnProcessRunner();
    this.gitExecutable = checkedExecutable(options.gitExecutable ?? "git", "Git executable");
    this.maxFiles = positiveInteger(options.maxFiles ?? 50_000, "Release file limit");
    this.maxBytes = positiveInteger(options.maxBytes ?? 512 * 1024 * 1024, "Release byte limit");
    this.gitTimeoutMs = positiveInteger(options.gitTimeoutMs ?? 30_000, "Git timeout");
    this.gitMaxOutputBytes = positiveInteger(
      options.gitMaxOutputBytes ?? 1024 * 1024,
      "Git output limit",
    );

    if (!options.readOnly) {
      fs.mkdirSync(options.releasesDir, { recursive: true, mode: 0o700 });
    }
    this.releasesDir =
      options.readOnly && !fs.existsSync(options.releasesDir)
        ? path.resolve(options.releasesDir)
        : fs.realpathSync(options.releasesDir);
    if (!options.readOnly) bestEffortChmod(this.releasesDir, 0o700);
  }

  async stage(options: StageReleaseOptions): Promise<StagedRelease> {
    const commitSha = checkedSha(options.commitSha, "Commit SHA");
    const binding = checkedCandidateBinding(options.binding, commitSha);
    const worktreePath = canonicalDirectory(options.worktreePath, "Worktree");
    await this.verifyWorktree(worktreePath, commitSha, options.signal);

    const destination = this.releasePath(commitSha);
    if (fs.existsSync(destination)) {
      const manifest = this.verifyManifest(commitSha);
      const existingState = this.readState();
      if (
        existingState.candidate === commitSha &&
        existingState.candidateBinding !== null &&
        stableJson(existingState.candidateBinding) !== stableJson(binding)
      ) {
        throw new Error("Release candidate is already bound to another attempt");
      }
      this.updateState((state) => {
        state.candidate = commitSha;
        state.candidateBinding = binding;
        state.health[commitSha] ??= { successes: 0, failures: 0 };
      });
      return { commitSha, releasePath: destination, manifest, binding };
    }

    const temporary = path.join(
      this.releasesDir,
      `.stage-${commitSha}-${process.pid}-${crypto.randomBytes(8).toString("hex")}`,
    );
    fs.mkdirSync(temporary, { mode: 0o700 });

    try {
      const context: CopyContext = {
        sourceRoot: worktreePath,
        destinationRoot: temporary,
        files: [],
        totalBytes: 0,
        entries: 0,
        maxFiles: this.maxFiles,
        maxBytes: this.maxBytes,
      };
      copyRequiredFile(context, "package.json");
      copyRequiredDirectory(context, "dist");
      copyRequiredDirectory(context, "node_modules");
      context.files.sort((left, right) => left.path.localeCompare(right.path));
      const packageValue = readBoundedJson(
        path.join(temporary, "package.json"),
        1024 * 1024,
      );
      const entrypoint = packageEntrypoint(packageValue);
      if (!context.files.some((file) => file.path === entrypoint)) {
        throw new Error("Release entrypoint is absent from the staged files");
      }

      const manifestBody = {
        version: MANIFEST_VERSION,
        commitSha,
        totalBytes: context.totalBytes,
        files: context.files,
      } as const;
      const manifest: ReleaseManifest = {
        ...manifestBody,
        manifestSha256: digest(Buffer.from(stableJson(manifestBody))),
      };
      writeNewFile(
        path.join(temporary, MANIFEST_FILE),
        Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
        0o600,
      );
      fsyncDirectory(temporary);
      makeTreeReadOnly(temporary);

      try {
        fs.renameSync(temporary, destination);
      } catch (error) {
        if (fs.existsSync(destination)) {
          throw new Error(`Release already exists: ${commitSha}`, { cause: error });
        }
        throw error;
      }
      fsyncDirectory(this.releasesDir);
      this.updateState((state) => {
        state.candidate = commitSha;
        state.candidateBinding = binding;
        state.health[commitSha] = { successes: 0, failures: 0 };
      });
      return { commitSha, releasePath: destination, manifest, binding };
    } catch (error) {
      removeTreeBestEffort(temporary);
      throw error;
    }
  }

  markCanarySuccess(expectedCandidateSha: string): ReleaseStatus {
    const expected = checkedSha(expectedCandidateSha, "Expected candidate SHA");
    return this.updateState((state) => {
      if (state.candidate !== expected) {
        throw new Error("Candidate SHA changed before canary success was recorded");
      }
      state.health[expected] ??= { successes: 0, failures: 0 };
      state.health[expected]!.successes += 1;
    });
  }

  promote(
    expectedCandidateSha: string,
    minimumSuccesses: number,
    expectedBinding: ReleaseCandidateBinding,
  ): ReleaseStatus {
    const expected = checkedSha(expectedCandidateSha, "Expected candidate SHA");
    const minimum = positiveInteger(minimumSuccesses, "Minimum canary successes");
    const binding = checkedCandidateBinding(expectedBinding, expected);
    this.verifyManifest(expected);
    return this.updateState((state) => {
      if (state.candidate !== expected) {
        throw new Error("Candidate SHA changed before promotion");
      }
      if (
        state.candidateBinding === null ||
        stableJson(state.candidateBinding) !== stableJson(binding)
      ) {
        throw new Error("Candidate release binding changed before promotion");
      }
      const health = state.health[expected] ?? { successes: 0, failures: 0 };
      if (health.failures > 0) {
        throw new Error("Candidate has recorded failures and cannot be promoted");
      }
      if (health.successes < minimum) {
        throw new Error(
          `Candidate has ${health.successes} successful canaries; ${minimum} required`,
        );
      }
      state.previous = state.active;
      state.active = expected;
      state.candidate = null;
      state.candidateBinding = null;
      state.earlyExitStreak = 0;
      state.health[expected] = health;
    });
  }

  rollback(expectedActiveSha?: string): ReleaseStatus {
    const expected =
      expectedActiveSha === undefined
        ? undefined
        : checkedSha(expectedActiveSha, "Expected active SHA");
    return this.updateState((state) => {
      if (expected !== undefined && state.active !== expected) {
        throw new Error("Active SHA changed before rollback");
      }
      if (state.previous === null) throw new Error("No previous release is available");
      const failed = state.active;
      state.active = state.previous;
      state.previous = failed;
      state.candidate = null;
      state.candidateBinding = null;
      state.earlyExitStreak = 0;
    });
  }

  status(): ReleaseStatus {
    return publicStatus(this.readState());
  }

  resolveEntrypoint(releaseSha?: string): string {
    const state = this.readState();
    const selected =
      releaseSha === undefined
        ? state.active
        : checkedSha(releaseSha, "Release SHA");
    if (selected === null) throw new Error("No active release is configured");
    const manifest = this.verifyManifest(selected);
    const packageFile = path.join(this.releasePath(selected), "package.json");
    const packageValue = readBoundedJson(packageFile, 1024 * 1024);
    const relative = packageEntrypoint(packageValue);
    const manifestEntry = manifest.files.find((file) => file.path === relative);
    if (manifestEntry === undefined) {
      throw new Error("Release entrypoint is absent from the manifest");
    }
    const absolute = path.join(this.releasePath(selected), ...relative.split("/"));
    assertWithin(this.releasePath(selected), absolute, "Release entrypoint");
    return absolute;
  }

  releasePath(commitSha: string): string {
    const checked = checkedSha(commitSha, "Release SHA");
    const candidate = path.join(this.releasesDir, checked);
    assertWithin(this.releasesDir, candidate, "Release path");
    return candidate;
  }

  recordEarlyExit(expectedActiveSha: string, failureThreshold: number): {
    status: ReleaseStatus;
    rolledBack: boolean;
  } {
    const expected = checkedSha(expectedActiveSha, "Expected active SHA");
    const threshold = positiveInteger(failureThreshold, "Crash failure threshold");
    let rolledBack = false;
    const status = this.updateState((state) => {
      if (state.active !== expected) {
        throw new Error("Active SHA changed while its process was running");
      }
      state.health[expected] ??= { successes: 0, failures: 0 };
      state.health[expected]!.failures += 1;
      state.earlyExitStreak += 1;
      if (state.earlyExitStreak >= threshold && state.previous !== null) {
        const failed = state.active;
        state.active = state.previous;
        state.previous = failed;
        state.candidate = null;
        state.candidateBinding = null;
        state.earlyExitStreak = 0;
        rolledBack = true;
      }
    });
    return { status, rolledBack };
  }

  recordHealthyRun(expectedActiveSha: string): ReleaseStatus {
    const expected = checkedSha(expectedActiveSha, "Expected active SHA");
    return this.updateState((state) => {
      if (state.active !== expected) {
        throw new Error("Active SHA changed while its process was running");
      }
      state.earlyExitStreak = 0;
    });
  }

  private async verifyWorktree(
    worktreePath: string,
    expectedSha: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const head = await this.git(
      ["rev-parse", "--verify", "HEAD^{commit}"],
      worktreePath,
      signal,
    );
    assertProcessSucceeded("git rev-parse release worktree", head);
    if (head.stdout.trim() !== expectedSha) {
      throw new Error("Worktree HEAD does not match the exact release commit");
    }

    const status = await this.git(
      ["status", "--porcelain=v1", "--untracked-files=no"],
      worktreePath,
      signal,
    );
    assertProcessSucceeded("git status release worktree", status);
    if (status.stdout.length !== 0) {
      throw new Error("Release worktree has tracked modifications");
    }
  }

  private async git(
    args: readonly string[],
    cwd: string,
    signal?: AbortSignal,
  ): Promise<ProcessResult> {
    const request: ProcessRequest = {
      executable: this.gitExecutable,
      args,
      cwd,
      env: gitEnvironment(),
      timeoutMs: this.gitTimeoutMs,
      maxOutputBytes: this.gitMaxOutputBytes,
      ...(signal === undefined ? {} : { signal }),
    };
    return await this.runner.run(request);
  }

  private verifyManifest(commitSha: string): ReleaseManifest {
    const releasePath = this.releasePath(commitSha);
    const releaseStat = lstatNoSymlink(releasePath, "Release");
    if (!releaseStat.isDirectory()) throw new Error("Release path is not a directory");
    const canonical = fs.realpathSync(releasePath);
    assertWithin(this.releasesDir, canonical, "Release");
    if (canonical !== releasePath) throw new Error("Release path is not canonical");

    const value = readBoundedJson(path.join(releasePath, MANIFEST_FILE), 16 * 1024 * 1024);
    const manifest = parseManifest(value, commitSha);
    const body = {
      version: manifest.version,
      commitSha: manifest.commitSha,
      totalBytes: manifest.totalBytes,
      files: manifest.files,
    } as const;
    if (digest(Buffer.from(stableJson(body))) !== manifest.manifestSha256) {
      throw new Error("Release manifest hash is invalid");
    }

    const actualFiles = listPayloadFiles(releasePath);
    if (actualFiles.length !== manifest.files.length) {
      throw new Error("Release contents do not match the manifest");
    }
    let totalBytes = 0;
    for (let index = 0; index < manifest.files.length; index += 1) {
      const expected = manifest.files[index]!;
      const actualPath = actualFiles[index];
      if (actualPath !== expected.path) {
        throw new Error("Release contents do not match the manifest");
      }
      const absolute = path.join(releasePath, ...expected.path.split("/"));
      const stat = lstatNoSymlink(absolute, `Manifest file ${expected.path}`);
      if (!stat.isFile() || stat.size !== expected.bytes) {
        throw new Error(`Release file metadata differs from manifest: ${expected.path}`);
      }
      if (((stat.mode & 0o111) !== 0) !== expected.executable) {
        throw new Error(`Release file mode differs from manifest: ${expected.path}`);
      }
      if (hashFileNoFollow(absolute) !== expected.sha256) {
        throw new Error(`Release file hash differs from manifest: ${expected.path}`);
      }
      totalBytes += stat.size;
    }
    if (totalBytes !== manifest.totalBytes) {
      throw new Error("Release byte total differs from manifest");
    }
    return manifest;
  }

  private readState(): ReleaseState {
    const statePath = path.join(this.releasesDir, STATE_FILE);
    if (!fs.existsSync(statePath)) return emptyState();
    const stat = lstatNoSymlink(statePath, "Release state");
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error("Release state file is invalid");
    return parseState(readBoundedJson(statePath, 1024 * 1024));
  }

  private updateState(mutator: (state: ReleaseState) => void): ReleaseStatus {
    const state = this.readState();
    mutator(state);
    state.generation += 1;
    validateStateReferences(state);
    writeAtomicJson(path.join(this.releasesDir, STATE_FILE), state);
    return publicStatus(state);
  }
}

/** Launches one active daemon generation and crash-loop rolls back atomically. */
export class Supervisor {
  private readonly releases: ReleaseManager;
  private readonly runner: ProcessRunner;
  private readonly nodeExecutable: string;
  private readonly healthyThresholdMs: number;
  private readonly crashFailureThreshold: number;
  private readonly processTimeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly env: Readonly<Record<string, string | undefined>> | undefined;

  constructor(options: SupervisorOptions) {
    if (options.releases === undefined && options.releasesDir === undefined) {
      throw new Error("Supervisor requires releases or releasesDir");
    }
    this.releases =
      options.releases ??
      new ReleaseManager({ releasesDir: options.releasesDir!, runner: options.runner });
    this.runner = options.runner;
    this.nodeExecutable = checkedExecutable(options.nodeExecutable ?? process.execPath, "Node executable");
    this.healthyThresholdMs = positiveInteger(
      options.healthyThresholdMs ?? 30_000,
      "Healthy threshold",
    );
    this.crashFailureThreshold = positiveInteger(
      options.crashFailureThreshold ?? 3,
      "Crash failure threshold",
    );
    this.processTimeoutMs = positiveInteger(
      options.processTimeoutMs ?? 24 * 60 * 60 * 1000,
      "Supervisor process timeout",
    );
    this.maxOutputBytes = positiveInteger(
      options.maxOutputBytes ?? 4 * 1024 * 1024,
      "Supervisor output limit",
    );
    this.env = options.env;
  }

  async launch(
    daemonArgs: readonly string[] = [],
    signal?: AbortSignal,
  ): Promise<SupervisorResult> {
    for (const argument of daemonArgs) checkedArgument(argument);
    const before = this.releases.status();
    if (before.active === null) throw new Error("No active release is configured");
    const releaseSha = before.active;
    const entrypoint = this.releases.resolveEntrypoint(releaseSha);
    const request: ProcessRequest = {
      executable: this.nodeExecutable,
      args: [entrypoint, "autonomy", "daemon", ...daemonArgs],
      cwd: this.releases.releasePath(releaseSha),
      timeoutMs: this.processTimeoutMs,
      maxOutputBytes: this.maxOutputBytes,
      ...(this.env === undefined ? {} : { env: this.env }),
      ...(signal === undefined ? {} : { signal }),
    };
    const processResult = await this.runner.run(request);
    const earlyExit = processResult.durationMs < this.healthyThresholdMs;
    if (!earlyExit) {
      return {
        releaseSha,
        process: processResult,
        earlyExit: false,
        rolledBack: false,
        status: this.releases.recordHealthyRun(releaseSha),
      };
    }
    const outcome = this.releases.recordEarlyExit(
      releaseSha,
      this.crashFailureThreshold,
    );
    return {
      releaseSha,
      process: processResult,
      earlyExit: true,
      rolledBack: outcome.rolledBack,
      status: outcome.status,
    };
  }

  async run(
    daemonArgs: readonly string[] = [],
    signal?: AbortSignal,
  ): Promise<SupervisorResult> {
    return await this.launch(daemonArgs, signal);
  }
}

export async function stage(
  options: ReleaseManagerOptions & StageReleaseOptions,
): Promise<StagedRelease> {
  return await new ReleaseManager(options).stage(options);
}

export function markCanarySuccess(
  options: ReleaseManagerOptions & { expectedCandidateSha: string },
): ReleaseStatus {
  return new ReleaseManager(options).markCanarySuccess(options.expectedCandidateSha);
}

export function promote(
  options: ReleaseManagerOptions & {
    expectedCandidateSha: string;
    minimumSuccesses: number;
    binding: ReleaseCandidateBinding;
  },
): ReleaseStatus {
  return new ReleaseManager(options).promote(
    options.expectedCandidateSha,
    options.minimumSuccesses,
    options.binding,
  );
}

export function rollback(
  options: ReleaseManagerOptions & { expectedActiveSha?: string },
): ReleaseStatus {
  return new ReleaseManager(options).rollback(options.expectedActiveSha);
}

export function status(options: ReleaseManagerOptions): ReleaseStatus {
  return new ReleaseManager(options).status();
}

export function resolveEntrypoint(
  options: ReleaseManagerOptions & { releaseSha?: string },
): string {
  return new ReleaseManager(options).resolveEntrypoint(options.releaseSha);
}

interface CopyContext {
  readonly sourceRoot: string;
  readonly destinationRoot: string;
  readonly files: ReleaseFile[];
  totalBytes: number;
  entries: number;
  readonly maxFiles: number;
  readonly maxBytes: number;
}

function copyRequiredFile(context: CopyContext, relative: string): void {
  const source = sourcePath(context, relative);
  const stat = lstatNoSymlink(source, relative);
  if (!stat.isFile()) throw new Error(`Required release file is not regular: ${relative}`);
  copyOneFile(context, relative, stat);
}

function copyRequiredDirectory(context: CopyContext, relative: string): void {
  const source = sourcePath(context, relative);
  const stat = lstatNoSymlink(source, relative);
  if (!stat.isDirectory()) {
    throw new Error(`Required release directory is not a directory: ${relative}`);
  }
  copyDirectory(context, relative);
}

function copyDirectory(context: CopyContext, relative: string): void {
  context.entries += 1;
  if (context.entries > context.maxFiles * 4) {
    throw new Error("Release contains too many filesystem entries");
  }
  const source = sourcePath(context, relative);
  const canonical = fs.realpathSync(source);
  assertWithin(context.sourceRoot, canonical, `Release source ${relative}`);
  if (canonical !== source) throw new Error(`Release source path is not canonical: ${relative}`);
  const destination = destinationPath(context, relative);
  fs.mkdirSync(destination, { mode: 0o700 });

  for (const entry of fs.readdirSync(source, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (entry.name === "." || entry.name === ".." || entry.name.includes("\0")) {
      throw new Error("Release contains an unsafe path");
    }
    const childRelative = `${relative}/${entry.name}`;
    const childSource = sourcePath(context, childRelative);
    const stat = fs.lstatSync(childSource);
    // npm writes package bin shims as symlinks under node_modules/.bin. Releases
    // execute via the package entrypoint (`node dist/index.js`), so omit that
    // directory instead of rejecting an otherwise valid install tree.
    if (childRelative === "node_modules/.bin") continue;
    if (stat.isSymbolicLink()) {
      throw new Error(`${childRelative} must not be a symbolic link`);
    }
    if (stat.isDirectory()) copyDirectory(context, childRelative);
    else if (stat.isFile()) copyOneFile(context, childRelative, stat);
    else throw new Error(`Release contains a non-regular entry: ${childRelative}`);
  }
}

function copyOneFile(context: CopyContext, relative: string, before: fs.Stats): void {
  if (context.files.length >= context.maxFiles) {
    throw new Error("Release exceeds configured file count");
  }
  if (before.size > context.maxBytes - context.totalBytes) {
    throw new Error("Release exceeds configured byte size");
  }

  const source = sourcePath(context, relative);
  const destination = destinationPath(context, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const sourceFd = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let destinationFd: number | undefined;
  try {
    const opened = fs.fstatSync(sourceFd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(`Release source changed while staging: ${relative}`);
    }
    destinationFd = fs.openSync(destination, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    const hash = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let bytes = 0;
    for (;;) {
      const read = fs.readSync(sourceFd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      bytes += read;
      if (bytes > before.size || bytes > context.maxBytes - context.totalBytes) {
        throw new Error("Release exceeds configured byte size");
      }
      const chunk = buffer.subarray(0, read);
      hash.update(chunk);
      writeAll(destinationFd, chunk);
    }
    const after = fs.fstatSync(sourceFd);
    if (bytes !== before.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) {
      throw new Error(`Release source changed while staging: ${relative}`);
    }
    fs.fsyncSync(destinationFd);
    bestEffortFchmod(destinationFd, (before.mode & 0o111) !== 0 ? 0o700 : 0o600);
    context.totalBytes += bytes;
    context.files.push({
      path: relative,
      bytes,
      sha256: hash.digest("hex"),
      executable: (before.mode & 0o111) !== 0,
    });
  } finally {
    if (destinationFd !== undefined) fs.closeSync(destinationFd);
    fs.closeSync(sourceFd);
  }
}

function sourcePath(context: CopyContext, relative: string): string {
  const checked = checkedRelativePath(relative, "Release source path");
  const value = path.join(context.sourceRoot, ...checked.split("/"));
  assertWithin(context.sourceRoot, value, "Release source path");
  return value;
}

function destinationPath(context: CopyContext, relative: string): string {
  const checked = checkedRelativePath(relative, "Release destination path");
  const value = path.join(context.destinationRoot, ...checked.split("/"));
  assertWithin(context.destinationRoot, value, "Release destination path");
  return value;
}

function listPayloadFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string, prefix: string): void => {
    const canonical = fs.realpathSync(directory);
    assertWithin(root, canonical, "Release content");
    if (canonical !== directory) throw new Error("Release contains a non-canonical directory");
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      const stat = lstatNoSymlink(absolute, `Release content ${relative}`);
      if (stat.isDirectory()) visit(absolute, relative);
      else if (stat.isFile()) {
        if (relative !== MANIFEST_FILE) files.push(relative);
      } else {
        throw new Error(`Release contains a non-regular entry: ${relative}`);
      }
    }
  };
  visit(root, "");
  return files.sort((left, right) => left.localeCompare(right));
}

function makeTreeReadOnly(root: string): void {
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const stat = lstatNoSymlink(absolute, "Staged release");
      if (stat.isDirectory()) visit(absolute);
      else if (stat.isFile()) {
        bestEffortChmod(absolute, (stat.mode & 0o111) !== 0 ? 0o555 : 0o444);
      }
    }
    bestEffortChmod(directory, 0o555);
  };
  visit(root);
}

function parseManifest(value: unknown, expectedSha: string): ReleaseManifest {
  if (!isRecord(value) || value.version !== MANIFEST_VERSION) {
    throw new Error("Release manifest has an unsupported format");
  }
  if (value.commitSha !== expectedSha) throw new Error("Release manifest commit does not match");
  if (
    !nonNegativeInteger(value.totalBytes) ||
    typeof value.manifestSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.manifestSha256)
  ) {
    throw new Error("Release manifest metadata is invalid");
  }
  if (!Array.isArray(value.files)) throw new Error("Release manifest files are invalid");
  const files: ReleaseFile[] = [];
  let prior = "";
  for (const item of value.files) {
    if (
      !isRecord(item) ||
      typeof item.path !== "string" ||
      !nonNegativeInteger(item.bytes) ||
      typeof item.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/u.test(item.sha256) ||
      typeof item.executable !== "boolean"
    ) {
      throw new Error("Release manifest file entry is invalid");
    }
    const relative = checkedRelativePath(item.path, "Manifest path");
    if (relative === MANIFEST_FILE || (prior !== "" && prior.localeCompare(relative) >= 0)) {
      throw new Error("Release manifest paths are duplicated or unsorted");
    }
    files.push({
      path: relative,
      bytes: item.bytes,
      sha256: item.sha256,
      executable: item.executable,
    });
    prior = relative;
  }
  return {
    version: 1,
    commitSha: expectedSha,
    totalBytes: value.totalBytes,
    files,
    manifestSha256: String(value.manifestSha256),
  };
}

function packageEntrypoint(value: unknown): string {
  if (!isRecord(value)) throw new Error("Release package.json must be an object");
  const configuredBin = value.bin;
  let entry: unknown;
  if (typeof configuredBin === "string") {
    entry = configuredBin;
  } else if (isRecord(configuredBin)) {
    entry = configuredBin["one-cli"];
    if (entry === undefined) {
      const values = Object.values(configuredBin);
      if (values.length === 1) entry = values[0];
    }
  }
  if (typeof entry !== "string") throw new Error("Release package.json has no one-cli entrypoint");
  return checkedRelativePath(entry, "Release entrypoint");
}

function parseState(value: unknown): ReleaseState {
  if (!isRecord(value) || value.version !== STATE_VERSION) {
    throw new Error("Release state has an unsupported format");
  }
  if (!nonNegativeInteger(value.generation) || !isRecord(value.health)) {
    throw new Error("Release state metadata is invalid");
  }
  const active = nullableSha(value.active, "active");
  const previous = nullableSha(value.previous, "previous");
  const candidate = nullableSha(value.candidate, "candidate");
  const health: Record<string, { successes: number; failures: number }> = {};
  for (const [sha, counts] of Object.entries(value.health)) {
    checkedSha(sha, "Release health SHA");
    if (
      !isRecord(counts) ||
      !nonNegativeInteger(counts.successes) ||
      !nonNegativeInteger(counts.failures)
    ) {
      throw new Error("Release health counts are invalid");
    }
    health[sha] = { successes: counts.successes, failures: counts.failures };
  }
  const state: ReleaseState = {
    version: 1,
    active,
    previous,
    candidate,
    health,
    generation: value.generation,
    earlyExitStreak: nonNegativeInteger(value.earlyExitStreak) ? value.earlyExitStreak : 0,
    candidateBinding:
      value.candidateBinding === undefined || value.candidateBinding === null
        ? null
        : checkedCandidateBinding(value.candidateBinding, candidate ?? undefined),
  };
  validateStateReferences(state);
  return state;
}

function validateStateReferences(state: ReleaseState): void {
  for (const sha of [state.active, state.previous, state.candidate]) {
    if (sha !== null) checkedSha(sha, "Release state SHA");
  }
}

function publicStatus(state: ReleaseState): ReleaseStatus {
  const health: Record<string, ReleaseHealth> = {};
  for (const [sha, counts] of Object.entries(state.health)) health[sha] = { ...counts };
  return {
    active: state.active,
    previous: state.previous,
    candidate: state.candidate,
    health,
    generation: state.generation,
    candidateSuccesses: state.candidate === null ? 0 : (health[state.candidate]?.successes ?? 0),
    candidateFailures: state.candidate === null ? 0 : (health[state.candidate]?.failures ?? 0),
    activeFailures: state.active === null ? 0 : (health[state.active]?.failures ?? 0),
    activeEarlyExitStreak: state.active === null ? 0 : state.earlyExitStreak,
    candidateBinding: state.candidateBinding,
  };
}

function emptyState(): ReleaseState {
  return {
    version: 1,
    active: null,
    previous: null,
    candidate: null,
    health: {},
    generation: 0,
    earlyExitStreak: 0,
    candidateBinding: null,
  };
}

function checkedCandidateBinding(
  value: unknown,
  expectedSha?: string,
): ReleaseCandidateBinding {
  if (!isRecord(value)) throw new Error("Release candidate binding is invalid");
  const attemptId = checkedBindingText(value.attemptId, "attempt id");
  const issueDigest = checkedDigest(value.issueDigest, "issue digest");
  const policyHash = checkedDigest(value.policyHash, "policy hash");
  const headSha = checkedSha(
    checkedBindingText(value.headSha, "head SHA"),
    "Release binding head SHA",
  );
  if (expectedSha !== undefined && headSha !== expectedSha) {
    throw new Error("Release binding head SHA does not match the candidate");
  }
  let approval: ReleaseCandidateBinding["approval"];
  if (value.approval !== undefined) {
    if (!isRecord(value.approval)) throw new Error("Release approval binding is invalid");
    approval = {
      approvalId: checkedBindingText(value.approval.approvalId, "approval id"),
      action: checkedBindingText(value.approval.action, "approval action"),
      bindingRef: checkedBindingText(value.approval.bindingRef, "approval binding ref"),
    };
  }
  return { attemptId, issueDigest, policyHash, headSha, ...(approval ? { approval } : {}) };
}

function checkedBindingText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 4_096 || value.includes("\0")) {
    throw new Error(`Release binding ${label} is invalid`);
  }
  return value;
}

function checkedDigest(value: unknown, label: string): string {
  const text = checkedBindingText(value, label);
  if (!/^[0-9a-f]{64}$/u.test(text)) throw new Error(`Release binding ${label} is invalid`);
  return text;
}

function writeAtomicJson(target: string, value: unknown): void {
  const directory = path.dirname(target);
  const temporary = path.join(
    directory,
    `.state-${process.pid}-${crypto.randomBytes(8).toString("hex")}.tmp`,
  );
  let fd: number | undefined;
  try {
    fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    writeAll(fd, Buffer.from(`${JSON.stringify(value, null, 2)}\n`));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, target);
    fsyncDirectory(directory);
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    try {
      fs.unlinkSync(temporary);
    } catch {
      // A failed or already-renamed temporary file needs no cleanup.
    }
    throw error;
  }
}

function writeNewFile(target: string, data: Buffer, mode: number): void {
  const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, mode);
  try {
    writeAll(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function writeAll(fd: number, data: Buffer): void {
  let offset = 0;
  while (offset < data.length) offset += fs.writeSync(fd, data, offset);
}

function hashFileNoFollow(filePath: string): string {
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const hash = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytes === 0) return hash.digest("hex");
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    fs.closeSync(fd);
  }
}

function readBoundedJson(filePath: string, maxBytes: number): unknown {
  const stat = lstatNoSymlink(filePath, filePath);
  if (!stat.isFile() || stat.size > maxBytes) throw new Error(`JSON file is invalid: ${filePath}`);
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`JSON file is malformed: ${filePath}`, { cause: error });
  }
}

function canonicalDirectory(directory: string, label: string): string {
  if (!path.isAbsolute(directory)) throw new Error(`${label} path must be absolute`);
  const stat = lstatNoSymlink(directory, label);
  if (!stat.isDirectory()) throw new Error(`${label} is not a directory`);
  return fs.realpathSync(directory);
}

function lstatNoSymlink(candidate: string, label: string): fs.Stats {
  const stat = fs.lstatSync(candidate);
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
  return stat;
}

function checkedRelativePath(value: string, label: string): string {
  let normalized = value.replaceAll("\\", "/");
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  if (
    !normalized ||
    normalized.includes("\0") ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//u.test(normalized)
  ) {
    throw new Error(`${label} is not a safe relative path`);
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`${label} contains traversal`);
  }
  return segments.join("/");
}

function checkedSha(value: string, label: string): string {
  if (!SHA_PATTERN.test(value)) throw new Error(`${label} must be an exact lowercase commit SHA`);
  return value;
}

function nullableSha(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`Release state ${field} is invalid`);
  return checkedSha(value, `Release state ${field}`);
}

function checkedExecutable(value: string, label: string): string {
  if (!value || value.includes("\0")) throw new Error(`${label} is invalid`);
  return value;
}

function checkedArgument(value: string): void {
  if (value.includes("\0")) throw new Error("Daemon arguments must not contain NUL bytes");
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be positive`);
  return value;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertWithin(root: string, candidate: string, label: string): void {
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes its managed root`);
  }
}

function digest(value: Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function fsyncDirectory(directory: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(directory, fs.constants.O_RDONLY);
    fs.fsyncSync(fd);
  } catch {
    // Some filesystems do not support syncing directory handles.
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function bestEffortChmod(candidate: string, mode: number): void {
  try {
    fs.chmodSync(candidate, mode);
  } catch {
    // Permissions are best-effort on filesystems without POSIX modes.
  }
}

function bestEffortFchmod(fd: number, mode: number): void {
  try {
    fs.fchmodSync(fd, mode);
  } catch {
    // Permissions are best-effort on filesystems without POSIX modes.
  }
}

function removeTreeBestEffort(directory: string): void {
  if (!fs.existsSync(directory)) return;
  try {
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return;
    const canonical = fs.realpathSync(directory);
    if (canonical !== directory) return;
    const makeWritable = (current: string): void => {
      bestEffortChmod(current, 0o700);
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const nested = path.join(current, entry.name);
        if (entry.isDirectory() && !entry.isSymbolicLink()) makeWritable(nested);
        else if (!entry.isSymbolicLink()) bestEffortChmod(nested, 0o600);
      }
    };
    makeWritable(directory);
    fs.rmSync(directory, { recursive: true, force: true });
  } catch {
    // Cleanup must never replace the staging error.
  }
}

function gitEnvironment(): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
  };
  for (const name of ["HOME", "PATH", "XDG_CONFIG_HOME"] as const) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}
