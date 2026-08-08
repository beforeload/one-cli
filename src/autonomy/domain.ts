export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | { readonly [key: string]: JsonValue } | readonly JsonValue[];

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
