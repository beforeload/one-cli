import { spawn } from "node:child_process";

export interface ProcessRequest {
  executable: string;
  args: readonly string[];
  cwd?: string;
  env?: Readonly<Record<string, string | undefined>>;
  stdin?: string | Uint8Array;
  timeoutMs: number;
  maxOutputBytes: number;
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

export class ProcessFailure extends Error {
  readonly result: ProcessResult;

  constructor(operation: string, result: ProcessResult) {
    const reason = result.spawnError
      ? `could not start: ${result.spawnError}`
      : result.timedOut
        ? "timed out"
        : result.cancelled
          ? "was cancelled"
          : result.outputLimitExceeded
            ? "exceeded its output limit"
            : `exited with status ${result.exitCode ?? "unknown"}`;
    super(`${operation} ${reason}${result.stderr ? `: ${result.stderr.trim()}` : ""}`);
    this.name = "ProcessFailure";
    this.result = result;
  }
}

/**
 * Runs an executable directly. It never invokes a shell, bounds combined output,
 * and terminates the whole child process group on timeout or cancellation.
 */
export class SpawnProcessRunner implements ProcessRunner {
  async run(request: ProcessRequest): Promise<ProcessResult> {
    assertRequest(request);
    const started = Date.now();

    return await new Promise<ProcessResult>((resolve) => {
      const child = spawn(request.executable, [...request.args], {
        ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        ...(request.env === undefined
          ? {}
          : { env: { ...request.env } as NodeJS.ProcessEnv }),
        detached: process.platform !== "win32",
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      let capturedBytes = 0;
      let timedOut = false;
      let cancelled = false;
      let outputLimitExceeded = false;
      let settled = false;
      let forceKillTimer: NodeJS.Timeout | undefined;

      const append = (target: "stdout" | "stderr", chunk: Buffer): void => {
        const remaining = request.maxOutputBytes - capturedBytes;
        if (remaining > 0) {
          const captured = chunk.subarray(0, remaining);
          capturedBytes += captured.length;
          if (target === "stdout") stdout = Buffer.concat([stdout, captured]);
          else stderr = Buffer.concat([stderr, captured]);
        }
        if (chunk.length > remaining) {
          outputLimitExceeded = true;
          terminate();
        }
      };

      const kill = (signal: NodeJS.Signals): void => {
        try {
          if (child.pid !== undefined && process.platform !== "win32") {
            process.kill(-child.pid, signal);
          } else {
            child.kill(signal);
          }
        } catch {
          // The process may have exited between the state check and the signal.
        }
      };

      const terminate = (): void => {
        kill("SIGTERM");
        if (forceKillTimer === undefined) {
          forceKillTimer = setTimeout(() => kill("SIGKILL"), 250);
          forceKillTimer.unref();
        }
      };

      const onAbort = (): void => {
        cancelled = true;
        terminate();
      };

      const timeout = setTimeout(() => {
        timedOut = true;
        terminate();
      }, request.timeoutMs);
      timeout.unref();

      const cleanup = (): void => {
        clearTimeout(timeout);
        if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
        request.signal?.removeEventListener("abort", onAbort);
      };

      const finish = (
        exitCode: number | null,
        signal: NodeJS.Signals | null,
        spawnError?: string,
      ): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({
          exitCode,
          signal,
          stdout: stdout.toString("utf8"),
          stderr: stderr.toString("utf8"),
          durationMs: Date.now() - started,
          timedOut,
          cancelled,
          outputLimitExceeded,
          ...(spawnError === undefined ? {} : { spawnError }),
        });
      };

      child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
      child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
      child.once("error", (error) => finish(null, null, error.message));
      child.once("close", (code, signal) => finish(code, signal));

      if (request.signal?.aborted) onAbort();
      else request.signal?.addEventListener("abort", onAbort, { once: true });

      child.stdin.once("error", () => {
        // EPIPE is expected when a child exits before consuming all input.
      });
      if (request.stdin !== undefined) child.stdin.end(request.stdin);
      else child.stdin.end();
    });
  }
}

export function assertProcessSucceeded(operation: string, result: ProcessResult): void {
  if (
    result.exitCode !== 0 ||
    result.spawnError !== undefined ||
    result.timedOut ||
    result.cancelled ||
    result.outputLimitExceeded
  ) {
    throw new ProcessFailure(operation, result);
  }
}

function assertRequest(request: ProcessRequest): void {
  if (!request.executable || request.executable.includes("\0")) {
    throw new Error("Process executable must be a non-empty, NUL-free string");
  }
  if (request.args.some((argument) => argument.includes("\0"))) {
    throw new Error("Process arguments must not contain NUL bytes");
  }
  if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0) {
    throw new Error("Process timeout must be a positive integer");
  }
  if (!Number.isSafeInteger(request.maxOutputBytes) || request.maxOutputBytes <= 0) {
    throw new Error("Process output limit must be a positive integer");
  }
}
