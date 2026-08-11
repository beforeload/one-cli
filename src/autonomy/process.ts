import crypto from "node:crypto";
import { spawn } from "node:child_process";
import type {
  FailureReceipt,
  FailureReceiptSource,
  RecoveryEvidence,
  RecoveryEvidenceSource,
} from "./domain.js";

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

export interface FailureReceiptLimits {
  maxStdoutBytes: number;
  maxStderrBytes: number;
  maxSpawnErrorBytes: number;
}

export interface FailureReceiptContext {
  source: FailureReceiptSource;
  attemptId: string;
  operationId: string;
  operation: string;
  gate?: string;
  issueDigest: string;
  diffHash?: string;
  policyHash: string;
  environmentHash: string;
  timestamp: number;
}

export interface RecoveryEvidenceInput {
  source: RecoveryEvidenceSource;
  provenance: {
    producer: string;
    operationId: string;
    observedAt: number;
  };
  failureFingerprint: string;
  failureReceiptHash: string;
  summary: string;
}

export interface MachineRecoveryDecision {
  diagnosis:
    | "transient/network/provider"
    | "environment/toolchain"
    | "code/gate"
    | "policy/governance"
    | "unknown";
  target?: "same-state" | "implementing" | "verifying";
}

const POLICY_FAILURE =
  /\b(?:approval|required approval|governance|policy|protected path|outside (?:the )?approved|roadmap binding|permission denied|unauthori[sz]ed|forbidden|self-approv|credential|secret)\b/iu;
const TRANSIENT_FAILURE =
  /\b(?:econnreset|econnrefused|enetunreach|eai_again|dns|network|socket hang up|timed? ?out|timeout|temporary|temporarily|rate limit|too many requests|http 429|http 5\d\d|provider unavailable|service unavailable)\b/iu;
const ENVIRONMENT_FAILURE =
  /\b(?:command not found|enoent|not installed|missing executable|cannot find module|module not found|unsupported platform|toolchain|sandbox unavailable|no such file or directory)\b/iu;
const HASH = /^[a-f0-9]{64}$/u;

/**
 * Converts an untrusted process result into a bounded, redacted receipt.
 * Fingerprints exclude timing and provenance so equivalent failures dedupe.
 */
export function createFailureReceipt(
  context: FailureReceiptContext,
  result: ProcessResult,
  limits: FailureReceiptLimits,
): FailureReceipt {
  assertReceiptContext(context);
  const stdout = redactAndBound(result.stdout, limits.maxStdoutBytes);
  const stderr = redactAndBound(result.stderr, limits.maxStderrBytes);
  const spawnError =
    result.spawnError === undefined
      ? null
      : redactAndBound(result.spawnError, limits.maxSpawnErrorBytes);
  const receiptWithoutHashes = {
    schema: "autonomy.one-cli/failure-receipt-v1" as const,
    source: context.source,
    provenance: {
      producer: "one-cli" as const,
      attemptId: context.attemptId,
      operationId: context.operationId,
    },
    operation: context.operation,
    gate: context.gate ?? null,
    exitCode: result.exitCode,
    signal: result.signal,
    stdout,
    stderr,
    spawnError,
    durationMs: boundedNonNegativeInteger(result.durationMs),
    timedOut: result.timedOut,
    cancelled: result.cancelled,
    outputLimitExceeded: result.outputLimitExceeded,
    issueDigest: context.issueDigest,
    diffHash: context.diffHash ?? null,
    policyHash: context.policyHash,
    environmentHash: context.environmentHash,
    timestamp: boundedNonNegativeInteger(context.timestamp),
  };
  const fingerprint = failureFingerprint(receiptWithoutHashes);
  return {
    ...receiptWithoutHashes,
    fingerprint,
    hash: sha256(stableJson({ ...receiptWithoutHashes, fingerprint })),
  };
}

export function failureFingerprint(
  receipt: Omit<FailureReceipt, "fingerprint" | "hash">,
): string {
  return sha256(
    stableJson({
      source: receipt.source,
      operation: receipt.operation,
      gate: receipt.gate,
      exitCode: receipt.exitCode,
      signal: receipt.signal,
      stdoutHash: sha256(receipt.stdout),
      stderrHash: sha256(receipt.stderr),
      spawnErrorHash: receipt.spawnError === null ? null : sha256(receipt.spawnError),
      timedOut: receipt.timedOut,
      cancelled: receipt.cancelled,
      outputLimitExceeded: receipt.outputLimitExceeded,
      issueDigest: receipt.issueDigest,
      diffHash: receipt.diffHash,
      policyHash: receipt.policyHash,
      environmentHash: receipt.environmentHash,
    }),
  );
}

export function createRecoveryEvidence(
  input: RecoveryEvidenceInput,
  authenticationKey: Uint8Array,
  maxSummaryBytes = 4_096,
): RecoveryEvidence {
  assertRecoveryAuthenticationKey(authenticationKey);
  if (!input.provenance.producer.trim() || !input.provenance.operationId.trim()) {
    throw new Error("Recovery evidence provenance requires producer and operationId");
  }
  assertHash(input.failureFingerprint, "failure fingerprint");
  assertHash(input.failureReceiptHash, "failure receipt hash");
  const evidenceWithoutHash = {
    schema: "autonomy.one-cli/recovery-evidence-v1" as const,
    source: input.source,
    provenance: {
      producer: redactAndBound(input.provenance.producer, 256),
      operationId: redactAndBound(input.provenance.operationId, 512),
      observedAt: boundedNonNegativeInteger(input.provenance.observedAt),
    },
    failureFingerprint: input.failureFingerprint,
    failureReceiptHash: input.failureReceiptHash,
    summary: redactAndBound(input.summary, maxSummaryBytes),
  };
  if (!evidenceWithoutHash.summary) throw new Error("Recovery evidence summary must not be empty");
  const evidenceWithHash = {
    ...evidenceWithoutHash,
    hash: recoveryEvidenceDigest(evidenceWithoutHash),
  };
  return {
    ...evidenceWithHash,
    authentication: {
      algorithm: "hmac-sha256",
      keyId: recoveryAuthenticationKeyId(authenticationKey),
      mac: recoveryEvidenceMac(evidenceWithHash, authenticationKey),
    },
  };
}

export function recoveryEvidenceDigest(
  evidence: Omit<RecoveryEvidence, "hash" | "authentication">,
): string {
  return sha256(stableJson(evidence));
}

export function assertRecoveryEvidence(
  evidence: RecoveryEvidence,
  options: {
    maxSummaryBytes: number;
    allowedSources: readonly RecoveryEvidenceSource[];
  },
  authenticationKey: Uint8Array,
): void {
  assertRecoveryAuthenticationKey(authenticationKey);
  if (evidence.schema !== "autonomy.one-cli/recovery-evidence-v1") {
    throw new Error("Unsupported recovery evidence schema");
  }
  if (!options.allowedSources.includes(evidence.source)) {
    throw new Error(`Recovery evidence source is not allowed: ${evidence.source}`);
  }
  assertHash(evidence.failureFingerprint, "failure fingerprint");
  assertHash(evidence.failureReceiptHash, "failure receipt hash");
  assertHash(evidence.hash, "recovery evidence hash");
  if (
    evidence.authentication?.algorithm !== "hmac-sha256" ||
    evidence.authentication.keyId !== recoveryAuthenticationKeyId(authenticationKey) ||
    !HASH.test(evidence.authentication.mac)
  ) {
    throw new Error("Recovery evidence authentication is invalid");
  }
  const normalized = createRecoveryEvidence(
    {
      source: evidence.source,
      provenance: evidence.provenance,
      failureFingerprint: evidence.failureFingerprint,
      failureReceiptHash: evidence.failureReceiptHash,
      summary: evidence.summary,
    },
    authenticationKey,
    options.maxSummaryBytes,
  );
  const suppliedMac = Buffer.from(evidence.authentication.mac, "hex");
  const expectedMac = Buffer.from(normalized.authentication.mac, "hex");
  if (
    suppliedMac.byteLength !== expectedMac.byteLength ||
    !crypto.timingSafeEqual(suppliedMac, expectedMac)
  ) {
    throw new Error("Recovery evidence authentication is invalid");
  }
  if (stableJson(normalized) !== stableJson(evidence)) {
    throw new Error("Recovery evidence is not normalized, authenticated, or its hash is invalid");
  }
}

export function assertFailureReceipt(receipt: FailureReceipt): void {
  if (
    receipt.schema !== "autonomy.one-cli/failure-receipt-v1" ||
    !["local-process", "worker", "github-check", "reconciler"].includes(receipt.source) ||
    receipt.provenance?.producer !== "one-cli" ||
    !receipt.provenance.attemptId ||
    !receipt.provenance.operationId ||
    !receipt.operation ||
    (receipt.gate !== null && typeof receipt.gate !== "string") ||
    (receipt.exitCode !== null && !Number.isSafeInteger(receipt.exitCode)) ||
    (receipt.signal !== null && typeof receipt.signal !== "string") ||
    typeof receipt.stdout !== "string" ||
    typeof receipt.stderr !== "string" ||
    (receipt.spawnError !== null && typeof receipt.spawnError !== "string") ||
    !Number.isSafeInteger(receipt.durationMs) ||
    receipt.durationMs < 0 ||
    typeof receipt.timedOut !== "boolean" ||
    typeof receipt.cancelled !== "boolean" ||
    typeof receipt.outputLimitExceeded !== "boolean" ||
    !HASH.test(receipt.issueDigest) ||
    (receipt.diffHash !== null && !HASH.test(receipt.diffHash)) ||
    !HASH.test(receipt.policyHash) ||
    !HASH.test(receipt.environmentHash) ||
    !Number.isSafeInteger(receipt.timestamp) ||
    receipt.timestamp < 0 ||
    !HASH.test(receipt.fingerprint) ||
    !HASH.test(receipt.hash)
  ) {
    throw new Error("Failure receipt shape is invalid");
  }
  const { fingerprint, hash, ...withoutHashes } = receipt;
  if (
    failureFingerprint(withoutHashes) !== fingerprint ||
    sha256(stableJson({ ...withoutHashes, fingerprint })) !== hash
  ) {
    throw new Error("Failure receipt hash binding is invalid");
  }
}

export function deriveMachineRecoveryDecision(receipt: FailureReceipt): MachineRecoveryDecision {
  assertFailureReceipt(receipt);
  const text = [
    receipt.operation,
    receipt.gate ?? "",
    receipt.stdout,
    receipt.stderr,
    receipt.spawnError ?? "",
  ].join("\n");
  if (POLICY_FAILURE.test(text)) return { diagnosis: "policy/governance" };
  if (
    receipt.gate !== null &&
    receipt.exitCode === 0 &&
    receipt.signal === null &&
    receipt.spawnError === null &&
    !receipt.timedOut &&
    !receipt.cancelled &&
    !receipt.outputLimitExceeded
  ) {
    return { diagnosis: "environment/toolchain", target: "verifying" };
  }
  if (
    receipt.timedOut ||
    receipt.cancelled ||
    receipt.signal !== null ||
    TRANSIENT_FAILURE.test(text)
  ) {
    return { diagnosis: "transient/network/provider", target: "same-state" };
  }
  if (
    receipt.spawnError !== null ||
    receipt.exitCode === 126 ||
    receipt.exitCode === 127 ||
    ENVIRONMENT_FAILURE.test(text)
  ) {
    return { diagnosis: "environment/toolchain", target: "verifying" };
  }
  if (
    receipt.operation === "worker" ||
    receipt.operation === "diff" ||
    receipt.operation.startsWith("gate:") ||
    receipt.source === "github-check"
  ) {
    return { diagnosis: "code/gate", target: "implementing" };
  }
  return { diagnosis: "unknown" };
}

function recoveryAuthenticationKeyId(authenticationKey: Uint8Array): string {
  return crypto.createHash("sha256").update(authenticationKey).digest("hex");
}

function recoveryEvidenceMac(
  evidence: Omit<RecoveryEvidence, "authentication">,
  authenticationKey: Uint8Array,
): string {
  return crypto
    .createHmac("sha256", authenticationKey)
    .update(stableJson(evidence))
    .digest("hex");
}

function assertRecoveryAuthenticationKey(authenticationKey: Uint8Array): void {
  if (authenticationKey.byteLength !== 32) {
    throw new Error("Recovery evidence authentication key must contain exactly 32 bytes");
  }
}

export function runtimeEnvironmentHash(
  environment: {
    platform?: string;
    architecture?: string;
    nodeVersion?: string;
  } = {},
): string {
  return sha256(
    stableJson({
      platform: environment.platform ?? process.platform,
      architecture: environment.architecture ?? process.arch,
      nodeVersion: environment.nodeVersion ?? process.versions.node,
    }),
  );
}

/** Redacts credential-shaped values before applying a UTF-8 byte bound. */
export function redactAndBound(value: string, maxBytes: number): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("Redacted output byte limit must be a positive integer");
  }
  let redacted = value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/\0/gu, "\uFFFD")
    .replace(
      /((?:api[_-]?key|access[_-]?token|auth[_-]?token|password|secret|credentials?|private[_-]?key)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
      "$1[REDACTED]",
    )
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/=._~-]+/giu, "$1 [REDACTED]")
    .replace(/\b(?:github_pat_|gh[pousr]_|sk-)[A-Za-z0-9_-]{8,}\b/gu, "[REDACTED]")
    .replace(/(https?:\/\/)[^/\s:@]+:[^@\s/]+@/giu, "$1[REDACTED]@")
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gu,
      "[REDACTED PRIVATE KEY]",
    )
    .trim();
  const encoded = Buffer.from(redacted, "utf8");
  if (encoded.length <= maxBytes) return redacted;
  const suffix = "\n[TRUNCATED]";
  const suffixBytes = Buffer.byteLength(suffix);
  if (maxBytes <= suffixBytes) return Buffer.from(suffix).subarray(0, maxBytes).toString("utf8");
  redacted = encoded.subarray(0, maxBytes - suffixBytes).toString("utf8");
  return `${redacted}${suffix}`;
}

export class ProcessFailure extends Error {
  readonly result: ProcessResult;

  constructor(operation: string, result: ProcessResult) {
    const reason = result.spawnError
      ? `could not start: ${redactAndBound(result.spawnError, 1_024)}`
      : result.timedOut
        ? "timed out"
        : result.cancelled
          ? "was cancelled"
          : result.outputLimitExceeded
            ? "exceeded its output limit"
            : `exited with status ${result.exitCode ?? "unknown"}`;
    super(
      `${operation} ${reason}${
        result.stderr ? `: ${redactAndBound(result.stderr, 2_048)}` : ""
      }`,
    );
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
    const detached =
      process.platform !== "win32" && process.env.ONE_CLI_SANDBOXED !== "1";

    return await new Promise<ProcessResult>((resolve) => {
      const child = spawn(request.executable, [...request.args], {
        ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        ...(request.env === undefined
          ? {}
          : { env: { ...request.env } as NodeJS.ProcessEnv }),
        detached,
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
          if (child.pid !== undefined && detached) {
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

function assertReceiptContext(context: FailureReceiptContext): void {
  for (const [name, value] of Object.entries({
    attemptId: context.attemptId,
    operationId: context.operationId,
    operation: context.operation,
    issueDigest: context.issueDigest,
    policyHash: context.policyHash,
    environmentHash: context.environmentHash,
  })) {
    if (!value || value.includes("\0")) throw new Error(`Failure receipt ${name} is invalid`);
  }
}

function assertHash(value: string, name: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error(`Recovery evidence ${name} is invalid`);
}

function boundedNonNegativeInteger(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(value));
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return `{${entries
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
