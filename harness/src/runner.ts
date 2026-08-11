import { spawn } from "node:child_process";

export interface ProcessRequest {
  executable: string;
  args: readonly string[];
  cwd?: string;
  env?: Readonly<Record<string, string | undefined>>;
  stdin?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
}

export interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
  outputLimitExceeded: boolean;
  spawnError?: string;
}

export interface ProcessRunner {
  run(request: ProcessRequest): Promise<ProcessResult>;
}

export class ProcessError extends Error {
  constructor(
    operation: string,
    readonly result: ProcessResult,
  ) {
    super(
      `${operation} failed: ${
        result.spawnError ??
        (result.timedOut
          ? "timeout"
          : result.cancelled
            ? "cancelled"
            : result.outputLimitExceeded
              ? "output limit exceeded"
              : `exit ${result.exitCode ?? "unknown"}`)
      }`,
    );
    this.name = "ProcessError";
  }
}

export class SpawnProcessRunner implements ProcessRunner {
  private readonly secrets: readonly string[];

  constructor(secrets: readonly string[] = []) {
    this.secrets = [...new Set(secrets.filter((value) => value.length > 0))]
      .sort((left, right) => right.length - left.length);
  }

  async run(request: ProcessRequest): Promise<ProcessResult> {
    assertRequest(request);
    const timeoutMs = request.timeoutMs ?? 60_000;
    const maxOutputBytes = request.maxOutputBytes ?? 4 * 1024 * 1024;
    const started = Date.now();
    const detached =
      process.platform !== "win32" && process.env.ONE_CLI_SANDBOXED !== "1";
    return await new Promise<ProcessResult>((resolve) => {
      const child = spawn(request.executable, [...request.args], {
        shell: false,
        detached,
        stdio: ["pipe", "pipe", "pipe"],
        ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        ...(request.env === undefined ? {} : { env: { ...request.env } as NodeJS.ProcessEnv }),
      });
      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      let bytes = 0;
      let timedOut = false;
      let cancelled = false;
      let outputLimitExceeded = false;
      let settled = false;
      let hardKill: NodeJS.Timeout | undefined;

      const kill = (signal: NodeJS.Signals): void => {
        try {
          if (child.pid !== undefined && detached) {
            process.kill(-child.pid, signal);
          } else {
            child.kill(signal);
          }
        } catch {
          // The process already exited.
        }
      };
      const terminate = (): void => {
        kill("SIGTERM");
        hardKill ??= setTimeout(() => kill("SIGKILL"), 250);
        hardKill.unref();
      };
      const append = (stream: "stdout" | "stderr", chunk: Buffer): void => {
        const remaining = maxOutputBytes - bytes;
        if (remaining > 0) {
          const bounded = chunk.subarray(0, remaining);
          bytes += bounded.length;
          if (stream === "stdout") stdout = Buffer.concat([stdout, bounded]);
          else stderr = Buffer.concat([stderr, bounded]);
        }
        if (chunk.length > remaining) {
          outputLimitExceeded = true;
          terminate();
        }
      };
      const onAbort = (): void => {
        cancelled = true;
        terminate();
      };
      const timeout = setTimeout(() => {
        timedOut = true;
        terminate();
      }, timeoutMs);
      timeout.unref();
      const finish = (
        exitCode: number | null,
        signal: NodeJS.Signals | null,
        spawnError?: string,
      ): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (hardKill) clearTimeout(hardKill);
        request.signal?.removeEventListener("abort", onAbort);
        resolve({
          exitCode,
          signal,
          stdout: this.redact(stdout.toString("utf8")),
          stderr: this.redact(stderr.toString("utf8")),
          durationMs: Date.now() - started,
          timedOut,
          cancelled,
          outputLimitExceeded,
          ...(spawnError === undefined ? {} : { spawnError: this.redact(spawnError) }),
        });
      };
      child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
      child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
      child.once("error", (error) => finish(null, null, error.message));
      child.once("close", (code, signal) => finish(code, signal));
      if (request.signal?.aborted) onAbort();
      else request.signal?.addEventListener("abort", onAbort, { once: true });
      child.stdin.once("error", () => undefined);
      child.stdin.end(request.stdin);
    });
  }

  private redact(value: string): string {
    let redacted = value;
    for (const secret of this.secrets) redacted = redacted.replaceAll(secret, "[REDACTED]");
    return redacted;
  }
}

export function requireSuccess(operation: string, result: ProcessResult): ProcessResult {
  if (
    result.exitCode !== 0 ||
    result.signal !== null ||
    result.spawnError !== undefined ||
    result.timedOut ||
    result.cancelled ||
    result.outputLimitExceeded
  ) {
    throw new ProcessError(operation, result);
  }
  return result;
}

function assertRequest(request: ProcessRequest): void {
  if (!request.executable || request.executable.includes("\0")) {
    throw new Error("Executable must be non-empty and NUL-free");
  }
  if (request.args.some((argument) => argument.includes("\0"))) {
    throw new Error("Arguments must be NUL-free");
  }
  for (const [value, label] of [
    [request.timeoutMs ?? 60_000, "timeout"],
    [request.maxOutputBytes ?? 4 * 1024 * 1024, "output limit"],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`Process ${label} must be a positive integer`);
    }
  }
}
