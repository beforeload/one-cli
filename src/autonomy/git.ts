import fs from "node:fs";
import path from "node:path";
import {
  SpawnProcessRunner,
  assertProcessSucceeded,
  type ProcessRequest,
  type ProcessResult,
  type ProcessRunner,
} from "./process.js";

export interface GitRepository {
  readonly id: string;
  readonly barePath: string;
}

export interface GitWorktree {
  readonly id: string;
  readonly repositoryId: string;
  readonly path: string;
}

export interface GitStatus {
  readonly clean: boolean;
  readonly porcelain: string;
}

export interface GitDiff {
  readonly patch: string;
  readonly nameStatus: readonly { status: string; path: string; originalPath?: string }[];
}

export interface CreateWorktreeOptions {
  branch: string;
  startPoint: string;
  signal?: AbortSignal;
}

export interface PushOptions {
  remote: string;
  branch: string;
  setUpstream?: boolean;
  signal?: AbortSignal;
}

export interface GitManagerOptions {
  storageRoot: string;
  readOnly?: boolean;
  runner?: ProcessRunner;
  gitExecutable?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

/**
 * Returns the single repository-global exclusion ref for an immutable issue
 * digest. Every host derives the same name, so GitHub's create-ref operation is
 * the cross-host compare-and-set.
 */
export function issueClaimRef(issueNumber: number, digest: string): string {
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
    throw new Error("Issue claim number must be a positive integer");
  }
  if (!/^[0-9a-f]{64}$/u.test(digest)) {
    throw new Error("Issue claim digest must be an exact lowercase SHA-256");
  }
  return `refs/heads/one-cli-lease/issue-${issueNumber}-${digest}`;
}

/**
 * Owns a private bare-repository/worktree hierarchy. Callers choose semantic
 * values (repository id, ref, message), while this class exclusively builds
 * every git argument vector.
 */
export class GitManager {
  readonly storageRoot: string;
  private readonly repositoriesRoot: string;
  private readonly worktreesRoot: string;
  private readonly runner: ProcessRunner;
  private readonly gitExecutable: string;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;

  constructor(options: GitManagerOptions) {
    if (!path.isAbsolute(options.storageRoot)) {
      throw new Error("Git storage root must be absolute");
    }
    this.runner = options.runner ?? new SpawnProcessRunner();
    this.gitExecutable = checkedExecutable(options.gitExecutable ?? "git");
    this.timeoutMs = positiveInteger(options.timeoutMs ?? 120_000, "Git timeout");
    this.maxOutputBytes = positiveInteger(
      options.maxOutputBytes ?? 4 * 1024 * 1024,
      "Git output limit",
    );

    if (!options.readOnly) {
      fs.mkdirSync(options.storageRoot, { recursive: true, mode: 0o700 });
    }
    this.storageRoot =
      options.readOnly && !fs.existsSync(options.storageRoot)
        ? path.resolve(options.storageRoot)
        : fs.realpathSync(options.storageRoot);
    this.repositoriesRoot = path.join(this.storageRoot, "repositories");
    this.worktreesRoot = path.join(this.storageRoot, "worktrees");
    if (!options.readOnly) {
      fs.mkdirSync(this.repositoriesRoot, { recursive: true, mode: 0o700 });
      fs.mkdirSync(this.worktreesRoot, { recursive: true, mode: 0o700 });
    }
  }

  async cloneBare(
    repositoryId: string,
    remote: string,
    signal?: AbortSignal,
  ): Promise<GitRepository> {
    const id = checkedId(repositoryId, "Repository id");
    checkedRemote(remote);
    this.assertCanonicalManagedPath(this.repositoriesRoot, this.storageRoot);
    const barePath = this.repositoryPath(id);
    if (fs.existsSync(barePath)) {
      throw new Error(`Repository already exists: ${id}`);
    }

    const result = await this.git(
      ["clone", "--bare", "--no-tags", "--", remote, barePath],
      undefined,
      signal,
    );
    try {
      assertProcessSucceeded("git clone", result);
      this.assertCanonicalManagedPath(barePath, this.repositoriesRoot);
    } catch (error) {
      this.removeManagedPathIfSafe(barePath, this.repositoriesRoot);
      throw error;
    }
    return { id, barePath };
  }

  async ensureBare(
    repositoryId: string,
    remote: string,
    signal?: AbortSignal,
  ): Promise<GitRepository> {
    const id = checkedId(repositoryId, "Repository id");
    const barePath = this.repositoryPath(id);
    if (!fs.existsSync(barePath)) return await this.cloneBare(id, remote, signal);
    const repository = { id, barePath };
    this.validateRepository(repository);
    const setUrl = await this.git(
      [`--git-dir=${barePath}`, "remote", "set-url", "origin", checkedRemote(remote)],
      undefined,
      signal,
    );
    assertProcessSucceeded("git remote set-url", setUrl);
    return repository;
  }

  async fetchBase(
    repository: GitRepository,
    remote: string,
    baseBranch: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const barePath = this.validateRepository(repository);
    const remoteName = checkedRemoteName(remote);
    const branch = checkedRef(baseBranch, "Base branch");
    const result = await this.git(
      [
        `--git-dir=${barePath}`,
        "fetch",
        "--no-tags",
        "--prune",
        "--",
        remoteName,
        `+refs/heads/${branch}:refs/remotes/${remoteName}/${branch}`,
      ],
      undefined,
      signal,
    );
    assertProcessSucceeded("git fetch", result);
    return await this.sha(
      [`--git-dir=${barePath}`, "rev-parse", "--verify", `refs/remotes/${remoteName}/${branch}^{commit}`],
      this.storageRoot,
      "git rev-parse fetched base",
      signal,
    );
  }

  async remoteBranchExists(
    repository: GitRepository,
    remote: string,
    branch: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const barePath = this.validateRepository(repository);
    const remoteName = checkedRemoteName(remote);
    const ref = `refs/heads/${checkedRef(branch, "Remote branch")}`;
    const result = await this.git(
      [`--git-dir=${barePath}`, "ls-remote", "--exit-code", "--heads", "--", remoteName, ref],
      undefined,
      signal,
    );
    if (result.exitCode === 2 && !result.spawnError && !result.timedOut && !result.cancelled) return false;
    assertProcessSucceeded("git ls-remote", result);
    return true;
  }

  async remoteBranchHead(
    repository: GitRepository,
    remote: string,
    branch: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const barePath = this.validateRepository(repository);
    const remoteName = checkedRemoteName(remote);
    const ref = `refs/heads/${checkedRef(branch, "Remote branch")}`;
    const result = await this.git(
      [`--git-dir=${barePath}`, "ls-remote", "--exit-code", "--heads", "--", remoteName, ref],
      undefined,
      signal,
    );
    if (result.exitCode === 2 && !result.spawnError && !result.timedOut && !result.cancelled) {
      return undefined;
    }
    assertProcessSucceeded("git ls-remote", result);
    const [sha, observedRef, extra] = result.stdout.trim().split(/\s+/u);
    if (
      extra !== undefined ||
      observedRef !== ref ||
      sha === undefined ||
      !/^[0-9a-f]{40,64}$/u.test(sha)
    ) {
      throw new Error("git ls-remote returned an invalid branch result");
    }
    return sha;
  }

  async isAncestor(
    repository: GitRepository,
    ancestor: string,
    descendant: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const barePath = this.validateRepository(repository);
    const result = await this.git(
      [
        `--git-dir=${barePath}`,
        "merge-base",
        "--is-ancestor",
        checkedRef(ancestor, "Ancestor"),
        checkedRef(descendant, "Descendant"),
      ],
      undefined,
      signal,
    );
    if (result.exitCode === 1 && !result.spawnError && !result.timedOut && !result.cancelled) {
      return false;
    }
    assertProcessSucceeded("git merge-base --is-ancestor", result);
    return true;
  }

  async createDetachedWorktree(
    repository: GitRepository,
    worktreeId: string,
    startPoint: string,
    signal?: AbortSignal,
  ): Promise<GitWorktree> {
    const barePath = this.validateRepository(repository);
    const id = checkedId(worktreeId, "Worktree id");
    const ref = checkedRef(startPoint, "Start point");
    const worktreePath = this.worktreePath(repository.id, id);
    if (fs.existsSync(worktreePath)) throw new Error(`Worktree already exists: ${repository.id}/${id}`);
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true, mode: 0o700 });
    const result = await this.git(
      [`--git-dir=${barePath}`, "worktree", "add", "--detach", "--", worktreePath, ref],
      undefined,
      signal,
    );
    assertProcessSucceeded("git worktree add", result);
    this.assertCanonicalManagedPath(worktreePath, this.worktreesRoot);
    return { id, repositoryId: repository.id, path: worktreePath };
  }

  async createWorktree(
    repository: GitRepository,
    worktreeId: string,
    options: CreateWorktreeOptions,
  ): Promise<GitWorktree> {
    const barePath = this.validateRepository(repository);
    const id = checkedId(worktreeId, "Worktree id");
    const branch = checkedRef(options.branch, "Branch");
    const startPoint = checkedRef(options.startPoint, "Start point");
    const worktreePath = this.worktreePath(repository.id, id);
    this.assertCanonicalManagedPath(this.worktreesRoot, this.storageRoot);
    if (fs.existsSync(worktreePath)) {
      this.assertCanonicalManagedPath(worktreePath, this.worktreesRoot);
      const listed = await this.git(
        [`--git-dir=${barePath}`, "worktree", "list", "--porcelain"],
        undefined,
        options.signal,
      );
      assertProcessSucceeded("git worktree list", listed);
      if (listed.stdout.split(/\r?\n/u).some((line) => line === `worktree ${worktreePath}`)) {
        return { id, repositoryId: repository.id, path: worktreePath };
      }
      // Orphan directory left after a crash: remove and recreate below.
      fs.rmSync(worktreePath, { recursive: true, force: true });
    }
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true, mode: 0o700 });
    this.assertCanonicalManagedPath(path.dirname(worktreePath), this.worktreesRoot);

    const result = await this.git(
      [
        `--git-dir=${barePath}`,
        "worktree",
        "add",
        "-b",
        branch,
        "--",
        worktreePath,
        startPoint,
      ],
      undefined,
      options.signal,
    );
    try {
      assertProcessSucceeded("git worktree add", result);
      this.assertCanonicalManagedPath(worktreePath, this.worktreesRoot);
    } catch (error) {
      this.removeManagedPathIfSafe(worktreePath, this.worktreesRoot);
      throw error;
    }
    return { id, repositoryId: repository.id, path: worktreePath };
  }

  async status(worktree: GitWorktree, signal?: AbortSignal): Promise<GitStatus> {
    const cwd = this.validateWorktree(worktree);
    const result = await this.git(
      ["status", "--porcelain=v1", "--untracked-files=all"],
      cwd,
      signal,
    );
    assertProcessSucceeded("git status", result);
    return { clean: result.stdout.length === 0, porcelain: result.stdout };
  }

  async stageAll(worktree: GitWorktree, signal?: AbortSignal): Promise<void> {
    const cwd = this.validateWorktree(worktree);
    const result = await this.git(["add", "--all", "--", "."], cwd, signal);
    assertProcessSucceeded("git add", result);
  }

  async diff(
    worktree: GitWorktree,
    options: { staged?: boolean; baseRef?: string; maxBytes?: number; signal?: AbortSignal } = {},
  ): Promise<GitDiff> {
    const cwd = this.validateWorktree(worktree);
    const range = options.baseRef === undefined ? [] : [checkedRef(options.baseRef, "Diff base")];
    const common = [...(options.staged === true ? ["--cached"] : []), "--no-ext-diff"];
    const patch = await this.git(["diff", ...common, ...range, "--"], cwd, options.signal);
    assertProcessSucceeded("git diff", patch);
    const limit = positiveInteger(options.maxBytes ?? this.maxOutputBytes, "Diff limit");
    if (Buffer.byteLength(patch.stdout) > limit) throw new Error("Git diff exceeds configured limit");
    const names = await this.git(
      ["diff", ...common, "--name-status", "-z", ...range, "--"],
      cwd,
      options.signal,
    );
    assertProcessSucceeded("git diff --name-status", names);
    const fields = names.stdout.split("\0");
    const nameStatus: Array<{ status: string; path: string; originalPath?: string }> = [];
    for (let index = 0; index < fields.length - 1; ) {
      const status = fields[index++]!;
      const firstPath = fields[index++]!;
      if (/^[RC]/u.test(status)) {
        const secondPath = fields[index++]!;
        nameStatus.push({
          status,
          path: secondPath || firstPath,
          ...(secondPath && secondPath !== firstPath ? { originalPath: firstPath } : {}),
        });
      } else {
        nameStatus.push({ status, path: firstPath });
      }
    }
    return { patch: patch.stdout, nameStatus };
  }

  async base(
    worktree: GitWorktree,
    baseRef: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const cwd = this.validateWorktree(worktree);
    const ref = checkedRef(baseRef, "Base ref");
    return await this.sha(["merge-base", "HEAD", ref], cwd, "git merge-base", signal);
  }

  async head(worktree: GitWorktree, signal?: AbortSignal): Promise<string> {
    const cwd = this.validateWorktree(worktree);
    return await this.sha(["rev-parse", "--verify", "HEAD^{commit}"], cwd, "git rev-parse", signal);
  }

  async branch(worktree: GitWorktree, signal?: AbortSignal): Promise<string | null> {
    const cwd = this.validateWorktree(worktree);
    const result = await this.git(["symbolic-ref", "--quiet", "--short", "HEAD"], cwd, signal);
    if (
      result.exitCode === 1 &&
      !result.timedOut &&
      !result.cancelled &&
      !result.outputLimitExceeded &&
      result.spawnError === undefined
    ) {
      return null;
    }
    assertProcessSucceeded("git symbolic-ref", result);
    return checkedOutput(result.stdout, "Current branch");
  }

  async commit(
    worktree: GitWorktree,
    message: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const cwd = this.validateWorktree(worktree);
    if (!message.trim() || message.includes("\0")) {
      throw new Error("Commit message must be non-empty and NUL-free");
    }
    const result = await this.git(["commit", "-m", message], cwd, signal);
    assertProcessSucceeded("git commit", result);
    return await this.head(worktree, signal);
  }

  async push(worktree: GitWorktree, options: PushOptions): Promise<void> {
    const cwd = this.validateWorktree(worktree);
    const remote = checkedRemoteName(options.remote);
    const branch = checkedRef(options.branch, "Push branch");
    const result = await this.git(
      [
        "push",
        "--porcelain",
        ...(options.setUpstream === true ? ["--set-upstream"] : []),
        "--",
        remote,
        `HEAD:refs/heads/${branch}`,
      ],
      cwd,
      options.signal,
    );
    assertProcessSucceeded("git push", result);
  }

  async removeWorktree(
    repository: GitRepository,
    worktree: GitWorktree,
    signal?: AbortSignal,
  ): Promise<void> {
    const barePath = this.validateRepository(repository);
    const worktreePath = this.validateWorktree(worktree);
    if (worktree.repositoryId !== repository.id) {
      throw new Error("Worktree does not belong to repository");
    }
    const status = await this.status(worktree, signal);
    if (!status.clean) throw new Error("Refusing to remove a dirty worktree");
    const result = await this.git(
      [`--git-dir=${barePath}`, "worktree", "remove", "--", worktreePath],
      undefined,
      signal,
    );
    assertProcessSucceeded("git worktree remove", result);
    const prune = await this.git(
      [`--git-dir=${barePath}`, "worktree", "prune"],
      undefined,
      signal,
    );
    assertProcessSucceeded("git worktree prune", prune);
  }

  private async sha(
    args: readonly string[],
    cwd: string,
    operation: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const result = await this.git(args, cwd, signal);
    assertProcessSucceeded(operation, result);
    const value = checkedOutput(result.stdout, "Git SHA");
    if (!/^[0-9a-f]{40,64}$/u.test(value)) {
      throw new Error(`${operation} returned an invalid object id`);
    }
    return value;
  }

  private async git(
    args: readonly string[],
    cwd?: string,
    signal?: AbortSignal,
  ): Promise<ProcessResult> {
    const request: ProcessRequest = {
      executable: this.gitExecutable,
      args,
      env: gitEnvironment(),
      timeoutMs: this.timeoutMs,
      maxOutputBytes: this.maxOutputBytes,
      ...(cwd === undefined ? {} : { cwd }),
      ...(signal === undefined ? {} : { signal }),
    };
    return await this.runner.run(request);
  }

  private repositoryPath(id: string): string {
    return containedPath(this.repositoriesRoot, `${id}.git`);
  }

  private worktreePath(repositoryId: string, worktreeId: string): string {
    return containedPath(this.worktreesRoot, repositoryId, worktreeId);
  }

  private validateRepository(repository: GitRepository): string {
    const id = checkedId(repository.id, "Repository id");
    const expected = this.repositoryPath(id);
    if (path.resolve(repository.barePath) !== expected) {
      throw new Error("Repository path is outside managed storage");
    }
    this.assertCanonicalManagedPath(expected, this.repositoriesRoot);
    return expected;
  }

  private validateWorktree(worktree: GitWorktree): string {
    const repositoryId = checkedId(worktree.repositoryId, "Repository id");
    const id = checkedId(worktree.id, "Worktree id");
    const expected = this.worktreePath(repositoryId, id);
    if (path.resolve(worktree.path) !== expected) {
      throw new Error("Worktree path is outside managed storage");
    }
    this.assertCanonicalManagedPath(expected, this.worktreesRoot);
    return expected;
  }

  private assertCanonicalManagedPath(candidate: string, root: string): void {
    const canonical = fs.realpathSync(candidate);
    const canonicalRoot = fs.realpathSync(root);
    if (!isWithin(canonicalRoot, canonical)) {
      throw new Error(`Managed path escapes storage root: ${candidate}`);
    }
  }

  private removeManagedPathIfSafe(candidate: string, root: string): void {
    if (!fs.existsSync(candidate)) return;
    try {
      this.assertCanonicalManagedPath(candidate, root);
      fs.rmSync(candidate, { recursive: true, force: true });
    } catch {
      // Never clean up a path whose canonical location cannot be proven safe.
    }
  }
}

function containedPath(root: string, ...segments: readonly string[]): string {
  const candidate = path.resolve(root, ...segments);
  if (!isWithin(root, candidate)) throw new Error("Managed path escapes storage root");
  return candidate;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function checkedId(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value) || value === "." || value === "..") {
    throw new Error(`${label} contains unsupported characters`);
  }
  return value;
}

function checkedRef(value: string, label: string): string {
  if (
    !value ||
    value.startsWith("-") ||
    value.endsWith(".") ||
    value.endsWith("/") ||
    value.includes("..") ||
    value.includes("@{") ||
    /[\0-\x20~^:?*[\]\\]/u.test(value)
  ) {
    throw new Error(`${label} is not a safe Git ref`);
  }
  return value;
}

function checkedRemote(value: string): string {
  if (!value || value.includes("\0") || /[\r\n]/u.test(value)) {
    throw new Error("Git remote must be non-empty and contain no control lines");
  }
  return value;
}

function checkedRemoteName(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) {
    throw new Error("Git remote name contains unsupported characters");
  }
  return value;
}

function checkedExecutable(value: string): string {
  if (!value || value.includes("\0")) throw new Error("Git executable is invalid");
  return value;
}

function checkedOutput(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed || /[\r\n]/u.test(trimmed)) throw new Error(`${label} output is invalid`);
  return trimmed;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be positive`);
  return value;
}

function gitEnvironment(): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
  };
  for (const name of ["HOME", "PATH", "SSH_AUTH_SOCK", "XDG_CONFIG_HOME"] as const) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}
