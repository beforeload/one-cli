import crypto from "node:crypto";
import type { GitHubPort, HostIssue } from "./github.js";
import type { HostJournal, JournalEvent } from "./host.js";
import {
  diagnoseFailure,
  type DeterministicDiagnosis,
  type FailureReceiptView,
} from "./diagnosis.js";
import type {
  AttemptStatus,
  AutonomyStatus,
  ExpectedRoadmapBinding,
  OneCliClient,
  RecoveryEvidence,
} from "./one-cli.js";
import { APPROVED_PATHS_PREFIX, NORMALIZED_FIELDS, type RoadmapChild } from "./roadmap.js";

const HASH = /^[0-9a-f]{64}$/u;
const MAX_BACKOFF_MS = 30 * 60_000;

export interface RecoveryTickResult {
  action: string;
  state: "succeeded" | "parked" | "quarantined";
  phase: "roadmap" | "normal";
  lane: "recovery";
  detail: string;
  nextAttemptAt?: number;
}

export class HarnessRecovery {
  private readonly now: () => number;

  constructor(
    private readonly dependencies: {
      oneCli: OneCliClient;
      github: GitHubPort;
      journal: HostJournal;
      recoveryKey: Uint8Array;
      now?: () => number;
      modelAdvice?: (receipt: FailureReceiptView) => Promise<string | undefined>;
    },
  ) {
    this.now = dependencies.now ?? Date.now;
  }

  async recoverWaitingAttempt(
    status: AutonomyStatus,
    scope: "normal" | "roadmap-only",
    expected?: ExpectedRoadmapBinding,
    signal?: AbortSignal,
  ): Promise<RecoveryTickResult | undefined> {
    const attempt = status.activeAttempt;
    if (!attempt || attempt.state !== "waiting_evidence") return undefined;
    let receipt = newestFailureReceipt(attempt);
    if (!receipt) {
      const operation = legacyFailureOperation(attempt);
      if (!operation.startsWith("gate:")) {
        return this.park(
          "recovery-park",
          "Waiting attempt has no machine receipt or exact legacy gate binding",
          scope,
        );
      }
      const operationId = operationKey("probe", attempt.id, operation);
      const probe = await this.dependencies.oneCli.probeFailureGate(
        attempt.id,
        operationId,
        scope,
        expected,
        signal,
      );
      this.appendOnce("harness.recovery-probed", operationId, {
        operationId,
        attemptId: attempt.id,
        fingerprint: probe.receipt.fingerprint,
        gate: probe.gate,
        recovered: probe.recovered,
      });
      return {
        action: "recovery-probe",
        state: "succeeded",
        phase: phase(scope),
        lane: "recovery",
        detail: `Collected machine evidence from gate:${probe.gate}`,
      };
    }

    let advice: string | undefined;
    try {
      advice = await this.dependencies.modelAdvice?.(receipt);
    } catch {
      // Advice is deliberately non-authoritative and cannot block deterministic recovery.
    }
    const diagnosis: DeterministicDiagnosis = recoveredProbe(attempt, receipt)
      ? {
          schema: "one-cli.harness/diagnosis-v1",
          category: "environment/toolchain",
          decision: "retry-same-state",
          target: "verifying",
          backoffMs: 0,
          reason: "The exact bound gate passed during a read-only recovery probe",
          ...(advice?.trim() ? { modelAdvice: advice.trim().slice(0, 2_000) } : {}),
        }
      : diagnoseFailure(receipt, advice === undefined ? {} : { modelAdvice: advice });
    if (diagnosis.decision === "park" || diagnosis.decision === "quarantine") {
      this.appendDiagnosisOnce(attempt, receipt, diagnosis);
      return this.park(
        "recovery-park",
        `${diagnosis.category}: ${diagnosis.reason}`,
        scope,
      );
    }

    const target = diagnosis.target;
    if (!target) {
      return this.park("recovery-park", "Recovery policy produced no safe target", scope);
    }
    const operationId = operationKey(
      "retry",
      attempt.id,
      receipt.fingerprint,
      receipt.hash,
      diagnosis.category,
      target,
    );
    const nextAttemptAt = this.scheduledAt(operationId, attempt, diagnosis);
    if (nextAttemptAt > this.now()) {
      return {
        action: "recovery-backoff",
        state: "parked",
        phase: phase(scope),
        lane: "recovery",
        detail: `${diagnosis.category} retry is scheduled`,
        nextAttemptAt,
      };
    }
    const evidence = createMachineEvidence(
      receipt,
      diagnosis,
      operationId,
      this.dependencies.recoveryKey,
    );
    const tick = await this.dependencies.oneCli.machineRetry(
      attempt.id,
      evidence,
      scope,
      expected,
      signal,
    );
    this.appendOnce("harness.recovery-retried", operationId, {
      operationId,
      attemptId: attempt.id,
      fingerprint: receipt.fingerprint,
      evidenceHash: evidence.hash,
      category: diagnosis.category,
      target,
      state: tick.state,
    });
    return {
      action: tick.action,
      state: "succeeded",
      phase: phase(scope),
      lane: "recovery",
      detail: `${diagnosis.category} recovery resumed ${target}`,
    };
  }

  async remediateExhaustedRoadmapFailure(
    status: AutonomyStatus,
    issue: HostIssue,
    child: RoadmapChild,
    parentNumber: number,
    signal?: AbortSignal,
  ): Promise<RecoveryTickResult | undefined> {
    const attempt = [...status.attempts]
      .reverse()
      .find((candidate) => candidate.issueId === `github-${issue.number}`);
    if (
      !attempt ||
      attempt.state !== "failed" ||
      !issue.labels.some((label) => label === "agent-failed" || label === "quarantined")
    ) {
      return undefined;
    }
    const receipt = newestFailureReceipt(attempt);
    const fingerprint = receipt?.fingerprint ?? legacyFailureFingerprint(attempt);
    if (!fingerprint) {
      return this.park(
        "recovery-park",
        "Quarantined roadmap failure has no durable fingerprint",
        "roadmap-only",
      );
    }
    const marker = `<!-- one-cli:recovery-remediation:${fingerprint} -->`;
    const existing = await this.dependencies.github.findIssuesByMarker(marker, signal);
    if (existing.length > 1) {
      return this.park(
        "recovery-park",
        "Recovery remediation marker is duplicated",
        "roadmap-only",
      );
    }
    if (existing.length === 0) {
      const created = await this.dependencies.github.createIssue({
        title: `Remediate quarantined roadmap failure #${issue.number}`,
        body: remediationBody(child, issue, parentNumber, fingerprint, marker),
        labels: ["enhancement", "agent-failed", "quarantined"],
      }, signal);
      this.dependencies.journal.append("harness.recovery-remediation-created", {
        operationId: operationKey("remediation", fingerprint),
        parentIssueNumber: issue.number,
        remediationIssueNumber: created.number,
        fingerprint,
      });
      return {
        action: "recovery-remediation",
        state: "quarantined",
        phase: "roadmap",
        lane: "recovery",
        detail: `Quarantined #${issue.number}; created remediation #${created.number}`,
      };
    }
    return {
      action: "recovery-quarantine",
      state: "quarantined",
      phase: "roadmap",
      lane: "recovery",
      detail: `Quarantined #${issue.number}; remediation #${existing[0]!.number} is parked`,
    };
  }

  private scheduledAt(
    operationId: string,
    attempt: AttemptStatus,
    diagnosis: DeterministicDiagnosis,
  ): number {
    if (diagnosis.backoffMs === 0) return this.now();
    const existing = this.eventFor("harness.recovery-scheduled", operationId);
    const existingAt = existing?.data.nextAttemptAt;
    if (typeof existingAt === "number" && Number.isSafeInteger(existingAt) && existingAt >= 0) {
      return existingAt;
    }
    const count = legacyFailureCount(attempt);
    const delay = Math.min(
      MAX_BACKOFF_MS,
      diagnosis.backoffMs * 2 ** Math.min(Math.max(0, count - 1), 8),
    );
    const nextAttemptAt = this.now() + delay;
    this.dependencies.journal.append("harness.recovery-scheduled", {
      operationId,
      attemptId: attempt.id,
      category: diagnosis.category,
      nextAttemptAt,
    });
    return nextAttemptAt;
  }

  private appendDiagnosisOnce(
    attempt: AttemptStatus,
    receipt: FailureReceiptView,
    diagnosis: DeterministicDiagnosis,
  ): void {
    const operationId = operationKey(
      "diagnosis",
      attempt.id,
      receipt.fingerprint,
      diagnosis.category,
    );
    this.appendOnce("harness.recovery-diagnosed", operationId, {
      operationId,
      attemptId: attempt.id,
      fingerprint: receipt.fingerprint,
      category: diagnosis.category,
      decision: diagnosis.decision,
      reason: diagnosis.reason,
    });
  }

  private appendOnce(
    type: string,
    operationId: string,
    data: Readonly<Record<string, unknown>>,
  ): void {
    if (!this.eventFor(type, operationId)) this.dependencies.journal.append(type, data);
  }

  private eventFor(type: string, operationId: string): JournalEvent | undefined {
    return this.dependencies.journal
      .read(Number.MAX_SAFE_INTEGER)
      .find((event) => event.type === type && event.data.operationId === operationId);
  }

  private park(
    action: string,
    detail: string,
    scope: "normal" | "roadmap-only",
  ): RecoveryTickResult {
    return {
      action,
      state: "parked",
      phase: phase(scope),
      lane: "recovery",
      detail,
    };
  }
}

export function newestFailureReceipt(attempt: AttemptStatus): FailureReceiptView | undefined {
  const detail = attempt.detail;
  if (!detail) return undefined;
  const candidates: unknown[] = [];
  if (Array.isArray(detail.failureReceipts)) candidates.push(...detail.failureReceipts);
  const lastFailure = object(detail.lastFailure);
  if (lastFailure.receipt !== undefined) candidates.push(lastFailure.receipt);
  return candidates
    .map(parseReceipt)
    .filter((receipt): receipt is FailureReceiptView => receipt !== undefined)
    .sort((left, right) => left.timestamp - right.timestamp)
    .at(-1);
}

export function createMachineEvidence(
  receipt: FailureReceiptView,
  diagnosis: DeterministicDiagnosis,
  operationId: string,
  authenticationKey: Uint8Array,
): RecoveryEvidence {
  if (authenticationKey.byteLength !== 32) {
    throw new Error("Recovery evidence authentication key must contain exactly 32 bytes");
  }
  const core = {
    schema: "autonomy.one-cli/recovery-evidence-v1" as const,
    source: receipt.source,
    provenance: {
      producer: "one-cli-harness",
      operationId,
      observedAt: receipt.timestamp,
    },
    failureFingerprint: receipt.fingerprint,
    failureReceiptHash: receipt.hash,
    summary: [
      `category=${diagnosis.category}`,
      `decision=${diagnosis.decision}`,
      `target=${diagnosis.target ?? "none"}`,
      `receipt=${receipt.hash}`,
    ].join(";"),
  };
  const evidence = {
    ...core,
    hash: crypto.createHash("sha256").update(stableJson(core)).digest("hex"),
  };
  return {
    ...evidence,
    authentication: {
      algorithm: "hmac-sha256" as const,
      keyId: crypto.createHash("sha256").update(authenticationKey).digest("hex"),
      mac: crypto
        .createHmac("sha256", authenticationKey)
        .update(stableJson(evidence))
        .digest("hex"),
    },
  };
}

function parseReceipt(value: unknown): FailureReceiptView | undefined {
  const candidate = object(value);
  if (
    candidate.schema !== "autonomy.one-cli/failure-receipt-v1" ||
    !["local-process", "worker", "github-check", "reconciler"].includes(
      String(candidate.source),
    ) ||
    typeof candidate.operation !== "string" ||
    (candidate.gate !== null && typeof candidate.gate !== "string") ||
    (candidate.exitCode !== null && typeof candidate.exitCode !== "number") ||
    (candidate.signal !== null && typeof candidate.signal !== "string") ||
    typeof candidate.stdout !== "string" ||
    typeof candidate.stderr !== "string" ||
    (candidate.spawnError !== null && typeof candidate.spawnError !== "string") ||
    typeof candidate.timedOut !== "boolean" ||
    typeof candidate.cancelled !== "boolean" ||
    typeof candidate.outputLimitExceeded !== "boolean" ||
    typeof candidate.timestamp !== "number" ||
    typeof candidate.fingerprint !== "string" ||
    !HASH.test(candidate.fingerprint) ||
    typeof candidate.hash !== "string" ||
    !HASH.test(candidate.hash)
  ) {
    return undefined;
  }
  return candidate as unknown as FailureReceiptView;
}

function legacyFailureOperation(attempt: AttemptStatus): string {
  const failure = object(attempt.detail?.lastFailure);
  return typeof failure.operation === "string" ? failure.operation : "";
}

function legacyFailureFingerprint(attempt: AttemptStatus): string | undefined {
  const failure = object(attempt.detail?.lastFailure);
  return typeof failure.fingerprint === "string" && HASH.test(failure.fingerprint)
    ? failure.fingerprint
    : undefined;
}

function legacyFailureCount(attempt: AttemptStatus): number {
  const count = object(attempt.detail?.lastFailure).count;
  return typeof count === "number" && Number.isSafeInteger(count) && count > 0 ? count : 1;
}

function recoveredProbe(
  attempt: AttemptStatus,
  receipt: FailureReceiptView,
): boolean {
  const probes = attempt.detail?.recoveryProbes;
  return Array.isArray(probes) && probes.some((value) => {
    const probe = object(value);
    return (
      probe.recovered === true &&
      object(probe.receipt).hash === receipt.hash
    );
  });
}

function remediationBody(
  child: RoadmapChild,
  issue: HostIssue,
  parentNumber: number,
  fingerprint: string,
  marker: string,
): string {
  const binding = `${APPROVED_PATHS_PREFIX}${JSON.stringify(child.approvedPaths)}`;
  const fields: Record<(typeof NORMALIZED_FIELDS)[number], string> = {
    ...child.fields,
    sourceType: "self-discovery",
    sourceLinkOrEvidence:
      `Machine recovery fingerprint ${fingerprint}. ${marker}`,
    problemStatement:
      `Roadmap issue #${issue.number} exhausted deterministic recovery and was quarantined.`,
    scope: `${binding}\nRemediate only the original approved paths after deterministic root-cause review.`,
    acceptanceCriteria:
      `${binding}\nThe original failure is fixed with a new machine receipt and all bound gates pass.`,
    duplicateSearchEvidence:
      `Idempotent recovery marker ${marker}; linked quarantined issue #${issue.number}.`,
    parentChildRelationship:
      `Remediation for #${issue.number}. Roadmap parent: #${parentNumber}.`,
    dependencyOrder:
      `Parked outside the cold-start roadmap until #${issue.number} is explicitly remediated.`,
  };
  return [
    marker,
    ...NORMALIZED_FIELDS.flatMap((field) => [
      `## ${heading(field)}`,
      fields[field],
    ]),
  ].join("\n\n");
}

function phase(scope: "normal" | "roadmap-only"): "normal" | "roadmap" {
  return scope === "roadmap-only" ? "roadmap" : "normal";
}

function operationKey(prefix: string, ...parts: string[]): string {
  return `harness:${prefix}:${crypto
    .createHash("sha256")
    .update(parts.join("\0"))
    .digest("hex")}`;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function heading(value: string): string {
  return value.replace(/[A-Z]/gu, (letter) => ` ${letter}`).replace(/^./u, (letter) =>
    letter.toUpperCase());
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
