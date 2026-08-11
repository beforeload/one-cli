import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SpawnProcessRunner,
  type ProcessRequest,
  type ProcessResult,
  type ProcessRunner,
} from "./process.js";

export interface SandboxAvailability {
  available: boolean;
  reason?: string;
}

export interface SandboxPort {
  availability(): SandboxAvailability;
  run(commandName: string, signal?: AbortSignal): Promise<ProcessResult>;
}

export interface SandboxCommand {
  /** Absolute executable path fixed by trusted application configuration. */
  executable: string;
  /** Fixed arguments; run() never accepts additional arguments. */
  args: readonly string[];
  /** Optional working directory, which must resolve inside the workspace. */
  cwd?: string;
  /** Trusted configuration may enable network only for dependency installation. */
  network?: boolean;
}

export interface DarwinSandboxOptions {
  workspace: string;
  commands: Readonly<Record<string, SandboxCommand>>;
  runner?: ProcessRunner;
  sandboxExecutable?: string;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  maxOutputBytes?: number;
  isExecutable?: (candidate: string) => boolean;
  runtimeRoots?: readonly string[];
  networkProxy?: string;
}

interface PreparedCommand {
  executable: string;
  args: readonly string[];
  cwd: string;
  network: boolean;
}

/**
 * A fail-closed sandbox-exec adapter. Command names map to immutable,
 * application-configured executable/argv pairs; untrusted input never becomes
 * an executable, argument, working directory, profile, or environment value.
 */
export class DarwinSandbox implements SandboxPort {
  readonly workspace: string;
  private readonly commands = new Map<string, PreparedCommand>();
  private readonly runner: ProcessRunner;
  private readonly sandboxExecutable: string;
  private readonly platform: NodeJS.Platform;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly isExecutable: (candidate: string) => boolean;
  private readonly runtimeRoots: readonly string[];
  private readonly networkProxy: string | undefined;

  constructor(options: DarwinSandboxOptions) {
    if (!path.isAbsolute(options.workspace)) throw new Error("Sandbox workspace must be absolute");
    this.workspace = fs.realpathSync(options.workspace);
    this.runner = options.runner ?? new SpawnProcessRunner();
    this.sandboxExecutable = options.sandboxExecutable ?? "/usr/bin/sandbox-exec";
    if (!path.isAbsolute(this.sandboxExecutable) || this.sandboxExecutable.includes("\0")) {
      throw new Error("sandbox-exec path must be absolute and NUL-free");
    }
    this.platform = options.platform ?? process.platform;
    this.timeoutMs = positiveInteger(options.timeoutMs ?? 10 * 60_000, "Sandbox timeout");
    this.maxOutputBytes = positiveInteger(
      options.maxOutputBytes ?? 2 * 1024 * 1024,
      "Sandbox output limit",
    );
    this.isExecutable =
      options.isExecutable ??
      ((candidate) => {
        try {
          fs.accessSync(candidate, fs.constants.X_OK);
          return true;
        } catch {
          return false;
        }
      });
    this.runtimeRoots = (options.runtimeRoots ?? defaultRuntimeRoots())
      .filter((root) => fs.existsSync(root))
      .map((root) => fs.realpathSync(root));
    this.networkProxy = checkedLoopbackProxy(options.networkProxy);

    for (const [name, command] of Object.entries(options.commands)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(name)) {
        throw new Error(`Sandbox command name is invalid: ${name}`);
      }
      if (!path.isAbsolute(command.executable) || command.executable.includes("\0")) {
        throw new Error(`Sandbox command executable must be absolute: ${name}`);
      }
      const executable = fs.realpathSync(command.executable);
      if (command.args.some((argument) => argument.includes("\0"))) {
        throw new Error(`Sandbox command arguments contain NUL: ${name}`);
      }
      const cwd = fs.realpathSync(command.cwd ?? this.workspace);
      if (!isWithin(this.workspace, cwd)) {
        throw new Error(`Sandbox command cwd escapes workspace: ${name}`);
      }
      if (command.network === true && name !== "install") {
        throw new Error("Sandbox network access is permitted only for the install command");
      }
      this.commands.set(name, {
        executable,
        args: [...command.args],
        cwd,
        network: command.network === true,
      });
    }
  }

  availability(): SandboxAvailability {
    if (this.platform !== "darwin") {
      return { available: false, reason: "sandbox-exec is only supported on Darwin" };
    }
    if (!this.isExecutable(this.sandboxExecutable)) {
      return { available: false, reason: "sandbox-exec is unavailable or not executable" };
    }
    return { available: true };
  }

  async run(commandName: string, signal?: AbortSignal): Promise<ProcessResult> {
    const availability = this.availability();
    if (!availability.available) {
      throw new Error(`Sandbox unavailable: ${availability.reason ?? "unknown reason"}`);
    }
    const command = this.commands.get(commandName);
    if (command === undefined) {
      throw new Error(`Sandbox command is not preconfigured: ${commandName}`);
    }

    const temporaryHome = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "one-cli-sandbox-")),
    );
    const temporaryDirectory = path.join(temporaryHome, "tmp");
    fs.mkdirSync(temporaryDirectory, { mode: 0o700 });
    const profile = buildDarwinSandboxProfile(
      this.workspace,
      temporaryHome,
      command.executable,
      command.network,
      this.runtimeRoots,
    );
    const request: ProcessRequest = {
      executable: this.sandboxExecutable,
      args: ["-p", profile, command.executable, ...command.args],
      cwd: command.cwd,
      env: sandboxEnvironment(
        temporaryHome,
        temporaryDirectory,
        command.network ? this.networkProxy : undefined,
      ),
      timeoutMs: this.timeoutMs,
      maxOutputBytes: this.maxOutputBytes,
      ...(signal === undefined ? {} : { signal }),
    };

    try {
      return await this.runner.run(request);
    } finally {
      fs.rmSync(temporaryHome, { recursive: true, force: true });
    }
  }
}

export function buildDarwinSandboxProfile(
  workspace: string,
  temporaryHome: string,
  executable: string,
  network = false,
  runtimeRoots: readonly string[] = defaultRuntimeRoots(),
): string {
  for (const [label, value] of [
    ["workspace", workspace],
    ["temporary HOME", temporaryHome],
    ["executable", executable],
  ] as const) {
    if (!path.isAbsolute(value) || value.includes("\0")) {
      throw new Error(`Sandbox ${label} path must be absolute and NUL-free`);
    }
  }

  const readRoots = unique([
    workspace,
    temporaryHome,
    executable,
    path.dirname(executable),
    path.dirname(path.dirname(executable)),
    ...runtimeRoots.filter((root) => path.isAbsolute(root) && !root.includes("\0")),
  ]);
  const traversalRoots = unique(readRoots.flatMap(pathAncestors));
  return [
    "(version 1)",
    "(deny default)",
    // Full outbound network is granted only for the trusted install command.
    // Otherwise all network access — including loopback (127.0.0.1/::1) — stays
    // denied. An independent verifier vetoed loopback allows in network=false
    // profiles because even host-local sockets widen the deny-default surface,
    // so no loopback grant is emitted here. Sandboxed unit/integration gates
    // that need an in-process fake provider must instead skip those cases when
    // ONE_CLI_SANDBOXED=1 rather than open a loopback bind. The blanket
    // (deny network*) keeps the profile strictly deny-default for every address.
    ...(network
      ? ["(allow network-outbound)", "(allow network-inbound)"]
      : ["(deny network*)"]),
    '(allow file-read-data (literal "/"))',
    ...traversalRoots.map((root) =>
      `(allow file-read-metadata (literal ${profileString(root)}))`
    ),
    ...readRoots.map((root) =>
      root === executable
        ? `(allow file-read* (literal ${profileString(root)}))`
        : `(allow file-read* (subpath ${profileString(root)}))`,
    ),
    "(allow process-fork)",
    // Sandboxed Node must be able to stop its own fork workers (for example
    // vitest workers) without kill EPERM. The runner terminates the whole
    // process group (process.kill(-pid, ...)) so that grandchildren — vitest
    // fork/tinypool workers spawned by a direct child — are not orphaned.
    // macOS evaluates the signal operation against every target in that group,
    // so a bare (target children) grant only reaches direct children and leaves
    // grandchildren orphaned with EPERM. (target pgrp) authorizes signaling any
    // process that shares the sandboxed leader's own process group, which is
    // exactly the fork-worker tree. self/children remain for direct-signal
    // fallbacks. Every grant is scoped to the sandbox's own tree, so the
    // deny-default policy still forbids signaling any process outside it.
    "(allow signal (target self))",
    "(allow signal (target children))",
    "(allow signal (target pgrp))",
    `(allow process-exec (literal ${profileString(executable)}))`,
    `(allow process-exec (subpath ${profileString(workspace)}))`,
    // Sandboxed toolchains (for example npm creating $HOME/.npm/_logs and then
    // invoking helper binaries it materialized under the temporary HOME) must
    // be able to exec files they wrote inside their own scratch home. Without
    // this grant a nested sandboxed Node run exits with EX_OSERR (71) when it
    // cannot open its exec helper. The grant is scoped strictly to the
    // per-run temporary HOME, which is created fresh and removed afterwards, so
    // the deny-default policy still forbids executing anything outside the
    // sandbox's own workspace, runtime roots, and scratch home.
    `(allow process-exec (subpath ${profileString(temporaryHome)}))`,
    ...runtimeRoots
      .filter((root) => path.isAbsolute(root) && !root.includes("\0"))
      .map((root) => `(allow process-exec (subpath ${profileString(root)}))`),
    "(allow sysctl-read)",
    `(allow file-write* (subpath ${profileString(workspace)}))`,
    `(allow file-write* (subpath ${profileString(temporaryHome)}))`,
  ].join("\n");
}

function defaultRuntimeRoots(): string[] {
  const nodeExecutable = fs.realpathSync(process.execPath);
  const nodeDirectory = path.dirname(nodeExecutable);
  return [
    "/System",
    "/usr/bin",
    "/usr/lib",
    "/usr/share",
    "/bin",
    "/dev",
    "/private/var/db/timezone",
    "/Library/Apple/System/Library",
    nodeDirectory,
    path.dirname(nodeDirectory),
  ];
}

function pathAncestors(candidate: string): string[] {
  const ancestors: string[] = [];
  let current = path.resolve(candidate);
  while (current !== path.dirname(current)) {
    current = path.dirname(current);
    ancestors.push(current);
  }
  return ancestors;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function profileString(value: string): string {
  return JSON.stringify(value)
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function sandboxEnvironment(
  temporaryHome: string,
  temporaryDirectory: string,
  networkProxy?: string,
): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {
    HOME: temporaryHome,
    TMPDIR: temporaryDirectory,
    LC_ALL: "C",
    // Mark every descendant as running inside a sandbox so that nested tooling
    // (and unit tests) can detect the enclosing sandbox and avoid spawning a
    // second, guaranteed-to-fail sandbox-exec layer that macOS rejects.
    ONE_CLI_SANDBOXED: "1",
  };
  const pathValue = process.env.PATH;
  if (pathValue !== undefined) environment.PATH = pathValue;
  if (networkProxy !== undefined) {
    environment.HTTP_PROXY = networkProxy;
    environment.HTTPS_PROXY = networkProxy;
    environment.NO_PROXY = "127.0.0.1,localhost";
  }
  return environment;
}

function checkedLoopbackProxy(value: string | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Sandbox network proxy must be a valid URL");
  }
  const port = Number(parsed.port);
  if (
    parsed.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("Sandbox network proxy must be credential-free loopback HTTP with an explicit port");
  }
  return parsed.toString();
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be positive`);
  return value;
}
