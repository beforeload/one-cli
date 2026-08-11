import path from "node:path";
import type { ProcessRunner, ProcessResult } from "./runner.js";
import { requireSuccess } from "./runner.js";
import type { HarnessRelease } from "./release.js";
import type { FailureReceiptView } from "./diagnosis.js";

export interface AttemptStatus {
  id: string;
  issueId: string;
  state: string;
  prNumber: number | null;
  detail: Record<string, unknown> | null;
}

export interface AutonomyStatus {
  schema: "autonomy.one-cli/status-v1";
  executionScope: "normal" | "roadmap-only";
  mode: string;
  activeAttempt: AttemptStatus | null;
  attempts: AttemptStatus[];
  action: { type: string; aggregateId: string; createdAt: number } | null;
}

export interface TickOutput {
  action: string;
  state: string;
  attemptId?: string;
  detail?: string;
}

export interface RecoveryEvidence {
  schema: "autonomy.one-cli/recovery-evidence-v1";
  source: FailureReceiptView["source"];
  provenance: {
    producer: string;
    operationId: string;
    observedAt: number;
  };
  failureFingerprint: string;
  failureReceiptHash: string;
  summary: string;
  hash: string;
  authentication: {
    algorithm: "hmac-sha256";
    keyId: string;
    mac: string;
  };
}

export interface FailureGateProbeOutput {
  schema: "autonomy.one-cli/failure-gate-probe-v1";
  attemptId: string;
  gate: string;
  recovered: boolean;
  receipt: FailureReceiptView;
}

export interface ExpectedRoadmapBinding {
  issueNumber: number;
  seedMarker: string;
}

export class OneCliClient {
  constructor(
    private readonly runner: ProcessRunner,
    readonly workspace: string,
    private readonly releaseResolver: string | (() => HarnessRelease),
    private readonly environment: Readonly<Record<string, string>>,
    private readonly nodeExecutable = process.execPath,
  ) {}

  get entrypoint(): string {
    return this.resolveRelease().entrypoint;
  }

  activeRelease(): HarnessRelease {
    return this.resolveRelease();
  }

  async doctor(signal?: AbortSignal): Promise<{
    ok: boolean;
    checks: readonly { name: string; ok: boolean; detail: string }[];
    process: ProcessResult;
  }> {
    const processResult = await this.invoke(
      ["doctor", "--output", "json"],
      signal,
      false,
    );
    const value = record(parseJson(processResult.stdout, "doctor"), "doctor");
    if (typeof value.ok !== "boolean" || !Array.isArray(value.checks)) {
      throw new Error("one-cli doctor returned an invalid contract");
    }
    const checks = value.checks.map((entry) => {
      const check = record(entry, "doctor check");
      if (
        typeof check.name !== "string" ||
        typeof check.ok !== "boolean" ||
        typeof check.detail !== "string"
      ) {
        throw new Error("one-cli doctor check is invalid");
      }
      return { name: check.name, ok: check.ok, detail: check.detail };
    });
    return { ok: value.ok, checks, process: processResult };
  }

  async status(
    scope: "normal" | "roadmap-only",
    expected?: ExpectedRoadmapBinding,
    signal?: AbortSignal,
  ): Promise<AutonomyStatus> {
    const result = await this.invoke(
      ["status", "--mode", "auto-merge", "--output", "json", ...scopeArgs(scope, expected)],
      signal,
    );
    return parseAutonomyStatus(parseJson(result.stdout, "status"));
  }

  async reconcile(
    scope: "normal" | "roadmap-only",
    expected: ExpectedRoadmapBinding,
    signal?: AbortSignal,
  ): Promise<TickOutput> {
    const result = await this.invoke(
      [
        "reconcile",
        "--apply",
        "--mode",
        "auto-merge",
        "--output",
        "json",
        ...scopeArgs(scope, expected),
      ],
      signal,
    );
    return parseTick(parseJson(result.stdout, "reconcile"));
  }

  async once(
    scope: "normal" | "roadmap-only",
    expected?: ExpectedRoadmapBinding,
    signal?: AbortSignal,
  ): Promise<TickOutput> {
    const result = await this.invoke(
      [
        "once",
        "--mode",
        "auto-merge",
        "--output",
        "json",
        ...scopeArgs(scope, expected),
      ],
      signal,
      false,
    );
    if (!result.stdout.trim()) {
      const detail = result.stderr.trim().split(/\r?\n/u).at(-1) || `exit ${result.exitCode}`;
      throw new Error(`one-cli once returned no JSON: ${detail.slice(0, 400)}`);
    }
    const tick = parseTick(parseJson(result.stdout, "once"));
    if (result.exitCode !== 0 && !["blocked", "failed", "in_doubt"].includes(tick.state)) {
      requireSuccess("one-cli autonomy once", result);
    }
    return tick;
  }

  async probeFailureGate(
    attemptId: string,
    operationId: string,
    scope: "normal" | "roadmap-only",
    expected?: ExpectedRoadmapBinding,
    signal?: AbortSignal,
  ): Promise<FailureGateProbeOutput> {
    const result = await this.invoke(
      [
        "recover",
        "probe",
        attemptId,
        "--operation-id",
        operationId,
        "--mode",
        "auto-merge",
        "--output",
        "json",
        ...scopeArgs(scope, expected),
      ],
      signal,
    );
    return parseFailureGateProbe(parseJson(result.stdout, "recover probe"));
  }

  async machineRetry(
    attemptId: string,
    evidence: RecoveryEvidence,
    scope: "normal" | "roadmap-only",
    expected?: ExpectedRoadmapBinding,
    signal?: AbortSignal,
  ): Promise<TickOutput> {
    const result = await this.invoke(
      [
        "recover",
        "retry",
        attemptId,
        "--machine-evidence",
        "-",
        "--operation-id",
        evidence.provenance.operationId,
        "--mode",
        "auto-merge",
        "--output",
        "json",
        ...scopeArgs(scope, expected),
      ],
      signal,
      false,
      JSON.stringify(evidence),
    );
    const tick = parseTick(parseJson(result.stdout, "recover retry"));
    if (
      result.exitCode !== 0 &&
      !["in_doubt", "blocked", "failed"].includes(tick.state)
    ) {
      requireSuccess("one-cli autonomy recover retry", result);
    }
    return tick;
  }

  private async invoke(
    args: readonly string[],
    signal?: AbortSignal,
    assert = true,
    stdin?: string,
  ): Promise<ProcessResult> {
    const release = this.resolveRelease();
    const result = await this.runner.run({
      executable: this.nodeExecutable,
      args: [
        release.entrypoint,
        "autonomy",
        ...args,
        "--workspace",
        path.resolve(this.workspace),
      ],
      cwd: this.workspace,
      env: this.environment,
      timeoutMs: 30 * 60_000,
      maxOutputBytes: 8 * 1024 * 1024,
      ...(stdin === undefined ? {} : { stdin }),
      ...(signal ? { signal } : {}),
    });
    return assert ? requireSuccess(`one-cli autonomy ${args[0] ?? ""}`, result) : result;
  }

  private resolveRelease(): HarnessRelease {
    return typeof this.releaseResolver === "string"
      ? {
          entrypoint: path.resolve(this.releaseResolver),
          root: path.dirname(path.dirname(path.resolve(this.releaseResolver))),
          sha: null,
          bootstrap: true,
          manifestSha256: null,
          files: [],
        }
      : this.releaseResolver();
  }
}

function parseFailureGateProbe(value: unknown): FailureGateProbeOutput {
  const object = record(value, "failure gate probe");
  if (
    object.schema !== "autonomy.one-cli/failure-gate-probe-v1" ||
    typeof object.attemptId !== "string" ||
    typeof object.gate !== "string" ||
    typeof object.recovered !== "boolean"
  ) {
    throw new Error("one-cli failure gate probe schema is invalid");
  }
  return {
    schema: object.schema,
    attemptId: object.attemptId,
    gate: object.gate,
    recovered: object.recovered,
    receipt: parseFailureReceipt(object.receipt),
  };
}

function parseFailureReceipt(value: unknown): FailureReceiptView {
  const object = record(value, "failure receipt");
  const source = object.source;
  if (
    object.schema !== "autonomy.one-cli/failure-receipt-v1" ||
    !["local-process", "worker", "github-check", "reconciler"].includes(String(source)) ||
    typeof object.operation !== "string" ||
    (object.gate !== null && typeof object.gate !== "string") ||
    (object.exitCode !== null && typeof object.exitCode !== "number") ||
    (object.signal !== null && typeof object.signal !== "string") ||
    typeof object.stdout !== "string" ||
    typeof object.stderr !== "string" ||
    (object.spawnError !== null && typeof object.spawnError !== "string") ||
    typeof object.timedOut !== "boolean" ||
    typeof object.cancelled !== "boolean" ||
    typeof object.outputLimitExceeded !== "boolean" ||
    typeof object.timestamp !== "number" ||
    typeof object.fingerprint !== "string" ||
    typeof object.hash !== "string"
  ) {
    throw new Error("one-cli failure receipt is invalid");
  }
  return object as unknown as FailureReceiptView;
}

export function parseAutonomyStatus(value: unknown): AutonomyStatus {
  const object = record(value, "autonomy status");
  if (
    object.schema !== "autonomy.one-cli/status-v1" ||
    (object.executionScope !== "normal" && object.executionScope !== "roadmap-only") ||
    typeof object.mode !== "string" ||
    !Array.isArray(object.attempts)
  ) {
    throw new Error("one-cli status schema is invalid");
  }
  const activeAttempt =
    object.activeAttempt === null ? null : parseAttempt(object.activeAttempt);
  let action: AutonomyStatus["action"] = null;
  if (object.action !== null) {
    const nested = record(object.action, "autonomy action");
    if (
      typeof nested.type !== "string" ||
      typeof nested.aggregateId !== "string" ||
      typeof nested.createdAt !== "number"
    ) {
      throw new Error("one-cli status action is invalid");
    }
    action = {
      type: nested.type,
      aggregateId: nested.aggregateId,
      createdAt: nested.createdAt,
    };
  }
  return {
    schema: object.schema,
    executionScope: object.executionScope,
    mode: object.mode,
    activeAttempt,
    attempts: object.attempts.map(parseAttempt),
    action,
  };
}

function parseAttempt(value: unknown): AttemptStatus {
  const object = record(value, "attempt");
  if (
    typeof object.id !== "string" ||
    typeof object.issueId !== "string" ||
    typeof object.state !== "string" ||
    (object.prNumber !== null && typeof object.prNumber !== "number") ||
    (object.detail !== null &&
      (!object.detail || typeof object.detail !== "object" || Array.isArray(object.detail)))
  ) {
    throw new Error("one-cli status attempt is invalid");
  }
  return {
    id: object.id,
    issueId: object.issueId,
    state: object.state,
    prNumber: object.prNumber,
    detail: object.detail as Record<string, unknown> | null,
  };
}

function parseTick(value: unknown): TickOutput {
  const object = record(value, "autonomy tick");
  if (typeof object.action !== "string" || typeof object.state !== "string") {
    throw new Error("one-cli tick output is invalid");
  }
  return {
    action: object.action,
    state: object.state,
    ...(typeof object.attemptId === "string" ? { attemptId: object.attemptId } : {}),
    ...(typeof object.detail === "string" ? { detail: object.detail } : {}),
  };
}

function scopeArgs(
  scope: "normal" | "roadmap-only",
  expected?: ExpectedRoadmapBinding,
): string[] {
  if (scope === "normal") {
    if (expected) throw new Error("Normal scope cannot carry a roadmap binding");
    return [];
  }
  return [
    "--roadmap-only",
    ...(expected
      ? [
          "--expected-roadmap-issue",
          String(expected.issueNumber),
          "--expected-roadmap-marker",
          expected.seedMarker,
        ]
      : []),
  ];
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`one-cli ${label} returned malformed JSON`);
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}
