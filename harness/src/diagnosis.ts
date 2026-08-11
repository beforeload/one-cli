export type DiagnosisCategory =
  | "transient/network/provider"
  | "environment/toolchain"
  | "code/gate"
  | "policy/governance"
  | "unknown";

export type RecoveryDecision =
  | "retry-same-state"
  | "retry-implement"
  | "decompose-issue"
  | "quarantine"
  | "park";

export interface FailureReceiptView {
  schema: "autonomy.one-cli/failure-receipt-v1";
  source: "local-process" | "worker" | "github-check" | "reconciler";
  operation: string;
  gate: string | null;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  spawnError: string | null;
  timedOut: boolean;
  cancelled: boolean;
  outputLimitExceeded: boolean;
  timestamp: number;
  fingerprint: string;
  hash: string;
}

export interface DeterministicDiagnosis {
  schema: "one-cli.harness/diagnosis-v1";
  category: DiagnosisCategory;
  decision: RecoveryDecision;
  target?: "same-state" | "implementing" | "verifying";
  backoffMs: number;
  reason: string;
  modelAdvice?: string;
}

const POLICY =
  /\b(?:approval|required approval|governance|policy|protected path|outside (?:the )?approved|roadmap binding|permission denied|unauthori[sz]ed|forbidden|self-approv|credential|secret)\b/iu;
const TRANSIENT =
  /\b(?:econnreset|econnrefused|enetunreach|eai_again|dns|network|socket hang up|timed? ?out|timeout|temporary|temporarily|rate limit|too many requests|http 429|http 5\d\d|provider_error|provider unavailable|service unavailable)\b/iu;
const ENVIRONMENT =
  /\b(?:command not found|enoent|not installed|missing executable|cannot find module|module not found|unsupported platform|toolchain|sandbox unavailable|no such file or directory|exit handler never called|error with npm itself|error writing to the directory)\b/iu;
const SANDBOX_DECOMPOSE =
  /\b(?:kill eperm|operation not permitted|\/private\/var\/select|failed to terminate forks worker|sandbox-exec|one_cli_sandboxed|target pgrp)\b/iu;

export function diagnoseFailure(
  receipt: FailureReceiptView,
  options: { modelAdvice?: string } = {},
): DeterministicDiagnosis {
  const text = [
    receipt.operation,
    receipt.gate ?? "",
    receipt.stdout,
    receipt.stderr,
    receipt.spawnError ?? "",
  ].join("\n");
  let result: Omit<DeterministicDiagnosis, "schema" | "modelAdvice">;
  // Sandbox/process-signal signatures win over policy text that may appear in unit stdout.
  if (SANDBOX_DECOMPOSE.test(text)) {
    result = {
      category: "environment/toolchain",
      decision: "decompose-issue",
      backoffMs: 0,
      reason:
        "Sandbox or process-signal failure is outside the current issue approved paths and must become a new agent-ready issue",
    };
  } else if (POLICY.test(text)) {
    result = {
      category: "policy/governance",
      decision: "park",
      backoffMs: 0,
      reason: "Deterministic policy or governance boundary matched the failure receipt",
    };
  } else if (
    receipt.timedOut ||
    receipt.cancelled ||
    receipt.signal !== null ||
    TRANSIENT.test(text)
  ) {
    result = {
      category: "transient/network/provider",
      decision: "retry-same-state",
      target: "same-state",
      backoffMs: 60_000,
      reason: "Deterministic transient infrastructure signature matched the failure receipt",
    };
  } else if (
    receipt.spawnError !== null ||
    receipt.exitCode === 126 ||
    receipt.exitCode === 127 ||
    ENVIRONMENT.test(text)
  ) {
    result = {
      category: "environment/toolchain",
      decision: "retry-same-state",
      target: "verifying",
      backoffMs: 2 * 60_000,
      reason: "Deterministic environment or toolchain signature matched the failure receipt",
    };
  } else if (
    receipt.operation === "worker" ||
    receipt.operation === "diff" ||
    receipt.operation.startsWith("gate:") ||
    receipt.source === "github-check"
  ) {
    result = {
      category: "code/gate",
      decision: "retry-implement",
      target: "implementing",
      backoffMs: 0,
      reason: "A deterministic implementation or quality-gate operation failed",
    };
  } else {
    result = {
      category: "unknown",
      decision: "park",
      backoffMs: 0,
      reason: "No deterministic recovery category matched the receipt",
    };
  }
  return {
    schema: "one-cli.harness/diagnosis-v1",
    ...result,
    ...(options.modelAdvice?.trim()
      ? { modelAdvice: options.modelAdvice.trim().slice(0, 2_000) }
      : {}),
  };
}
