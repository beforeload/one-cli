export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | { readonly [key: string]: JsonValue } | readonly JsonValue[];

export type FailureReceiptSource =
  | "local-process"
  | "worker"
  | "github-check"
  | "reconciler";

export interface FailureProvenance {
  producer: "one-cli";
  attemptId: string;
  operationId: string;
}

/**
 * A bounded, redacted, content-addressed record of one failed operation.
 * It is intentionally additive so attempts written before receipts existed
 * remain readable through their legacy `lastFailure` fields.
 */
export interface FailureReceipt {
  schema: "autonomy.one-cli/failure-receipt-v1";
  source: FailureReceiptSource;
  provenance: FailureProvenance;
  operation: string;
  gate: string | null;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  spawnError: string | null;
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
  outputLimitExceeded: boolean;
  issueDigest: string;
  diffHash: string | null;
  policyHash: string;
  environmentHash: string;
  timestamp: number;
  fingerprint: string;
  hash: string;
}

export type RecoveryEvidenceSource =
  | "local-process"
  | "worker"
  | "github-check"
  | "reconciler";

export interface RecoveryEvidenceProvenance {
  producer: string;
  operationId: string;
  observedAt: number;
}

/** Machine-verifiable evidence that is bound to exactly one failure fingerprint. */
export interface RecoveryEvidence {
  schema: "autonomy.one-cli/recovery-evidence-v1";
  source: RecoveryEvidenceSource;
  provenance: RecoveryEvidenceProvenance;
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

/**
 * Closed taxonomy for deterministic CI-failure classification.
 * `unknown` is the mandatory fallback so the classifier is total.
 */
export type FailureClass =
  | "dependency"
  | "typecheck"
  | "lint"
  | "unit-test"
  | "e2e"
  | "build"
  | "credential"
  | "roadmap-marker"
  | "flaky-transient"
  | "unknown";

export const FAILURE_CLASSES: readonly FailureClass[] = [
  "dependency",
  "typecheck",
  "lint",
  "unit-test",
  "e2e",
  "build",
  "credential",
  "roadmap-marker",
  "flaky-transient",
  "unknown",
] as const;

export type DiagnosisReceiptSource =
  | "local-process"
  | "worker"
  | "github-check"
  | "reconciler";

export interface DiagnosisProvenance {
  producer: "one-cli";
  attemptId: string;
  operationId: string;
}

/**
 * A bounded, content-addressed structured diagnosis of one CI/gate failure.
 *
 * It is a *bypass observation* (Phase 1 of PR self-heal): produced from a
 * FailureReceipt via a deterministic, zero-LLM classifier and written additively
 * onto attempt detail. It never drives state transitions or repairs — it only
 * attributes a failure so humans (and later phases) can act. Content-addressed
 * like FailureReceipt so equivalent diagnoses dedupe and stay auditable.
 */
export interface DiagnosisReceipt {
  schema: "autonomy.one-cli/diagnosis-receipt-v1";
  source: DiagnosisReceiptSource;
  provenance: DiagnosisProvenance;
  failureClass: FailureClass;
  gate: string | null;
  /** Repository-relative paths implicated by the failure, best-effort, bounded. */
  affectedFiles: readonly string[];
  rootCauseHypothesis: string;
  /** Deterministic classifier confidence in [0, 1]. */
  confidence: number;
  /** Bounded, redacted excerpt of the log lines that drove classification. */
  logExcerpt: string;
  /** Fingerprint of the failure this diagnosis explains (from the FailureReceipt). */
  failureFingerprint: string;
  /** Content-addressed fingerprint of the diagnosis itself (class + cause + gate). */
  fingerprint: string;
  timestamp: number;
  hash: string;
}

/**
 * Lifecycle of a single self-heal repair task.
 * `queued` → `in_progress` → `applied` → `verified`, or `abandoned` at any
 * point when a safety boundary / bound is hit. It is deliberately *not* an
 * {@link AttemptState}: repair progress is tracked additively on attempt
 * detail (via a `healPhase` sub-phase) so the attempt state machine contract
 * (ATTEMPT_TRANSITIONS) is never touched.
 */
export type RepairTaskStatus =
  | "queued"
  | "in_progress"
  | "applied"
  | "verified"
  | "abandoned";

export const REPAIR_TASK_STATUSES: readonly RepairTaskStatus[] = [
  "queued",
  "in_progress",
  "applied",
  "verified",
  "abandoned",
] as const;

/**
 * A bounded, content-addressed unit of repair work decomposed from a
 * {@link DiagnosisReceipt} (Phase 2 of PR self-heal).
 *
 * Additive and auditable, mirroring {@link DiagnosisReceipt}: one RepairTask
 * targets exactly one gate / one failure class. It never mutates the attempt
 * state machine — the orchestrator drives it through a `healPhase` sub-phase on
 * attempt detail. For `flaky-transient` the instruction is a plain CI re-run
 * with no code change (empty `targetPaths`); classes on the safety boundary
 * (credential / roadmap-marker / protected-path) are never decomposed into a
 * task and are routed to a human instead.
 */
export interface RepairTask {
  schema: "autonomy.one-cli/repair-task-v1";
  taskId: string;
  failureClass: FailureClass;
  /** Fingerprint of the failure this task repairs (from the DiagnosisReceipt). */
  failureFingerprint: string;
  /** Repository-relative paths this task may modify. Empty for re-run-only. */
  targetPaths: readonly string[];
  /** Deterministic, human-readable action ("retry CI, no code change"). */
  instruction: string;
  /**
   * True when this task's repair action is NOT a deterministic command but an
   * agent-driven fix (Phase 3): the semantic classes (typecheck / unit-test)
   * whose correct repair requires model analysis of the failure log. The agent
   * is still bounded — it may write only inside `targetPaths`/approvedPaths, its
   * diff must pass the existing deterministic review + change-file budget before
   * any commit, and a would-be protected-path touch routes to a human at
   * decompose time. Absent/false for the deterministic classes (flaky/lint/dep).
   */
  requiresAgent?: boolean;
  /** Gate that must pass to consider this task verified (from the diagnosis). */
  verifyGate: string | null;
  /** taskIds that must reach `verified` before this task may start. */
  dependsOn: readonly string[];
  status: RepairTaskStatus;
  createdAt: number;
  /** Content-addressed fingerprint of the task (class + fingerprint + gate + paths + instruction). */
  hash: string;
}

export type AttemptState =
  | "pending"
  | "running"
  | "issue_selected"
  | "planning"
  | "implementing"
  | "verifying"
  | "waiting_approval"
  | "pr_open"
  | "waiting_ci"
  | "merging"
  | "post_merge"
  | "waiting"
  | "waiting_evidence"
  | "blocked"
  | "in_doubt"
  | "delivered"
  | "succeeded"
  | "failed"
  | "cancelled";

export const ATTEMPT_TRANSITIONS: Readonly<Record<AttemptState, readonly AttemptState[]>> = {
  pending: ["running", "issue_selected", "planning", "blocked", "in_doubt", "cancelled"],
  running: ["waiting_approval", "succeeded", "failed", "cancelled"],
  issue_selected: ["planning", "waiting", "blocked", "in_doubt", "cancelled"],
  planning: ["implementing", "waiting", "blocked", "in_doubt", "failed", "cancelled"],
  implementing: ["verifying", "waiting", "waiting_evidence", "blocked", "in_doubt", "failed", "cancelled"],
  verifying: ["waiting_approval", "pr_open", "post_merge", "waiting", "waiting_evidence", "blocked", "in_doubt", "succeeded", "failed", "cancelled"],
  waiting_approval: ["running", "verifying", "pr_open", "merging", "post_merge", "blocked", "in_doubt", "failed", "cancelled"],
  pr_open: ["waiting_ci", "waiting_approval", "merging", "post_merge", "waiting", "waiting_evidence", "blocked", "in_doubt", "delivered", "failed", "cancelled"],
  waiting_ci: ["waiting_ci", "waiting_approval", "merging", "post_merge", "waiting", "waiting_evidence", "blocked", "in_doubt", "delivered", "failed", "cancelled"],
  merging: ["post_merge", "in_doubt", "waiting", "failed", "cancelled"],
  post_merge: ["succeeded", "waiting", "blocked", "in_doubt", "failed", "cancelled"],
  waiting: [
    "planning",
    "implementing",
    "verifying",
    "pr_open",
    "waiting_ci",
    "merging",
    "post_merge",
    "blocked",
    "in_doubt",
    "failed",
    "cancelled",
  ],
  waiting_evidence: [
    "planning",
    "implementing",
    "verifying",
    "waiting_ci",
    "post_merge",
    "in_doubt",
    "failed",
    "cancelled",
  ],
  blocked: [
    "planning",
    "implementing",
    "verifying",
    "pr_open",
    "waiting_ci",
    "merging",
    "post_merge",
    "in_doubt",
    "cancelled",
    "failed",
  ],
  in_doubt: ["verifying", "pr_open", "waiting_ci", "post_merge", "failed", "cancelled"],
  delivered: [],
  succeeded: [],
  failed: [],
  cancelled: [],
};

export function canTransitionAttempt(from: AttemptState, to: AttemptState): boolean {
  return ATTEMPT_TRANSITIONS[from].includes(to);
}

export interface Repo {
  id: string;
  path: string;
  createdAt: number;
  updatedAt: number;
}

export interface Issue {
  id: string;
  repoId: string;
  key: string;
  digest: string;
  title: string | null;
  detail: JsonValue | null;
  createdAt: number;
  updatedAt: number;
}

export type IssueClaimStatus = "active" | "released" | "in_doubt";

/**
 * Durable evidence binding a GitHub-visible exclusion ref to one local attempt.
 * The ref may only be deleted when all fields exactly match the attempt record.
 */
export interface IssueClaimEvidence {
  ref: string;
  headSha: string;
  digest: string;
  owner: string;
  status: IssueClaimStatus;
}

export interface Attempt {
  id: string;
  issueId: string;
  number: number;
  state: AttemptState;
  branch: string | null;
  baseSha: string;
  headSha: string;
  sessionId: string | null;
  prNumber: number | null;
  claim: IssueClaimEvidence | null;
  detail: JsonValue | null;
  createdAt: number;
  updatedAt: number;
}

export interface AutonomyEvent {
  seq: number;
  aggregateType: string;
  aggregateId: string;
  type: string;
  data: JsonValue;
  createdAt: number;
}

export interface EventInput {
  aggregateType: string;
  aggregateId: string;
  type: string;
  data?: JsonValue;
  createdAt?: number;
}

export interface LeaseGrant {
  resource: string;
  owner: string;
  fence: number;
  expiresAt: number;
}

export type OperationState = "reserved" | "succeeded" | "failed";

export interface Operation {
  id: string;
  issueId: string | null;
  attemptId: string | null;
  idempotencyKey: string;
  kind: string;
  request: JsonValue;
  state: OperationState;
  result: JsonValue | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface OperationReservation {
  operation: Operation;
  created: boolean;
}

export interface OutboxEntry {
  id: number;
  operationId: string;
  topic: string;
  payload: JsonValue;
  createdAt: number;
  dispatchedAt: number | null;
}

export type ApprovalDecision = "approved" | "denied";

export interface ApprovalBinding {
  issueId: string;
  action: string;
  issueDigest: string;
  policyHash: string;
  headSha: string;
  /** Base/diff/head evidence that makes an approval single-use for one action. */
  bindingRef?: string;
}

export interface Approval extends ApprovalBinding {
  id: string;
  decision: ApprovalDecision;
  expiresAt: number;
  createdAt: number;
}

export type CheckStatus = "pending" | "running" | "passed" | "failed" | "skipped";

export interface Check {
  id: string;
  attemptId: string;
  name: string;
  status: CheckStatus;
  detail: JsonValue | null;
  createdAt: number;
  updatedAt: number;
}

export type ResearchKind = "repository" | "release" | "discussion" | "documentation";

export interface ResearchCheckpoint {
  sourceId: string;
  kind: ResearchKind;
  policyHash: string;
  channelState: "unavailable" | "baselined";
  cursor: string | null;
  page: number | null;
  lastSha: string | null;
  lastId: string | null;
  lastAt: number | null;
  boundarySha: string | null;
  boundaryId: string | null;
  boundaryAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface ResearchObservation {
  id: string;
  sourceId: string;
  kind: ResearchKind;
  externalId: string;
  sourceUrl: string;
  sha: string | null;
  evidence: JsonValue;
  observedAt: number;
  createdAt: number;
  updatedAt: number;
}

export type GapCategory =
  | "project-monitoring"
  | "interactive-coding-agent"
  | "long-sessions-context"
  | "extensions-parallelism"
  | "provider-cost-governance"
  | "safety-platform-testing-docs";
export type GapConfidence = "speculative" | "likely" | "confirmed";
export type GapFindingStatus =
  | "queued"
  | "eligible"
  | "retryable"
  | "in_doubt"
  | "promoted"
  | "duplicate"
  | "blocked"
  | "rejected"
  | "expired";

export interface GapFinding {
  fingerprint: string;
  sourceId: string;
  observationId: string;
  category: GapCategory;
  topic: string;
  subcode: string;
  evidence: JsonValue;
  score: number;
  confidence: GapConfidence;
  status: GapFindingStatus;
  policyHash: string;
  operationId: string | null;
  retryCount: number;
  retryAfter: number | null;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
}

/** Outcome of a single repair application, recorded onto its playbook. */
export type RepairOutcome = "applied" | "abandoned";

/**
 * Phase 3-B of the PR self-heal loop — the self-evolving playbook library.
 *
 * A RepairPlaybook is a bounded, deterministic tally of how one repair
 * *strategy* has historically fared against one {@link FailureClass}. It is the
 * memory that lets self-heal get "smarter": strategies that keep working are
 * ranked ahead of ones that keep failing, and strategies that fail past a
 * threshold are demoted so the loop stops retrying dead ends.
 *
 * It is pure statistics — zero LLM. `successCount / appliedCount` is a plain
 * ratio; ranking is a deterministic sort. It never drives an AttemptState
 * transition and never bypasses the deterministic review / change-file budget;
 * it only *reorders* the candidate strategies the existing detect* functions
 * already produce (with the current hard-coded order as the no-history tie-break
 * fallback). Persisted additively via {@link AutonomyStore}, mirroring
 * {@link GapFinding}.
 *
 * `playbookKey` = `failureClass:strategySource` — e.g.
 *   `lint:package.json:lint:fix`, `dependency:pnpm-lock.yaml`, `agent:typecheck`.
 */
export interface RepairPlaybook {
  schema: "autonomy.one-cli/repair-playbook-v1";
  /** `failureClass:strategySource`; the natural dedupe / lookup key. */
  playbookKey: string;
  failureClass: FailureClass;
  /** How the strategy was detected — e.g. a detect* `source`, or `agent`. */
  strategy: string;
  /** Total times this strategy was applied (success + failure). */
  appliedCount: number;
  /** Times this strategy produced a verified/applied fix. */
  successCount: number;
  lastAppliedAt: number;
  lastOutcome: RepairOutcome;
  createdAt: number;
  updatedAt: number;
}
