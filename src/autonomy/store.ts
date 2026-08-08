import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  canTransitionAttempt,
  type Approval,
  type ApprovalBinding,
  type Attempt,
  type AttemptState,
  type AutonomyEvent,
  type Check,
  type CheckStatus,
  type EventInput,
  type Issue,
  type IssueClaimEvidence,
  type JsonValue,
  type LeaseGrant,
  type Operation,
  type OperationReservation,
  type OutboxEntry,
  type Repo,
} from "./domain.js";
import { LeaseConflictError, LeaseLostError } from "./lease.js";

const SCHEMA_VERSION = 3;

const MIGRATIONS: ReadonlyArray<readonly [version: number, sql: string]> = [
  [
    1,
    `
      CREATE TABLE repos (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE issues (
        id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        issue_key TEXT NOT NULL,
        digest TEXT NOT NULL,
        title TEXT,
        detail_json TEXT CHECK(detail_json IS NULL OR json_valid(detail_json)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(repo_id, issue_key)
      ) STRICT;

      CREATE TABLE attempts (
        id TEXT PRIMARY KEY,
        issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
        attempt_number INTEGER NOT NULL CHECK(attempt_number > 0),
        state TEXT NOT NULL,
        branch TEXT,
        base_sha TEXT NOT NULL,
        head_sha TEXT NOT NULL,
        session_id TEXT,
        pr_number INTEGER CHECK(pr_number IS NULL OR pr_number > 0),
        detail_json TEXT CHECK(detail_json IS NULL OR json_valid(detail_json)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(issue_id, attempt_number)
      ) STRICT;

      CREATE UNIQUE INDEX one_active_attempt
        ON attempts((1))
        WHERE state NOT IN ('succeeded', 'failed', 'cancelled', 'blocked');

      CREATE TABLE leases (
        resource TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        fence INTEGER NOT NULL CHECK(fence > 0),
        expires_at INTEGER NOT NULL,
        heartbeat_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE operations (
        id TEXT PRIMARY KEY,
        issue_id TEXT REFERENCES issues(id) ON DELETE CASCADE,
        attempt_id TEXT REFERENCES attempts(id) ON DELETE CASCADE,
        idempotency_key TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        request_json TEXT NOT NULL CHECK(json_valid(request_json)),
        state TEXT NOT NULL CHECK(state IN ('reserved', 'succeeded', 'failed')),
        result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        operation_id TEXT NOT NULL UNIQUE REFERENCES operations(id) ON DELETE CASCADE,
        topic TEXT NOT NULL,
        payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
        created_at INTEGER NOT NULL,
        dispatched_at INTEGER
      ) STRICT;

      CREATE TABLE approvals (
        id TEXT PRIMARY KEY,
        issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
        action TEXT NOT NULL,
        issue_digest TEXT NOT NULL,
        policy_hash TEXT NOT NULL,
        head_sha TEXT NOT NULL,
        decision TEXT NOT NULL CHECK(decision IN ('approved', 'denied')),
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;

      CREATE INDEX approvals_binding_idx
        ON approvals(issue_id, action, issue_digest, policy_hash, head_sha, expires_at);

      CREATE TABLE checks (
        id TEXT PRIMARY KEY,
        attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'passed', 'failed', 'skipped')),
        detail_json TEXT CHECK(detail_json IS NULL OR json_valid(detail_json)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(attempt_id, name)
      ) STRICT;

      CREATE TABLE events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        aggregate_type TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        data_json TEXT NOT NULL CHECK(json_valid(data_json)),
        created_at INTEGER NOT NULL
      ) STRICT;

      CREATE INDEX events_aggregate_idx
        ON events(aggregate_type, aggregate_id, seq);
    `,
  ],
  [
    2,
    `
      ALTER TABLE approvals ADD COLUMN binding_ref TEXT NOT NULL DEFAULT '';
      DROP INDEX one_active_attempt;
      CREATE UNIQUE INDEX one_active_attempt
        ON attempts((1))
        WHERE state NOT IN ('delivered', 'succeeded', 'failed', 'cancelled', 'blocked');
    `,
  ],
  [
    3,
    `
      ALTER TABLE attempts ADD COLUMN claim_ref TEXT;
      ALTER TABLE attempts ADD COLUMN claim_head_sha TEXT;
      ALTER TABLE attempts ADD COLUMN claim_digest TEXT;
      ALTER TABLE attempts ADD COLUMN claim_owner TEXT;
      ALTER TABLE attempts ADD COLUMN claim_status TEXT
        CHECK(claim_status IS NULL OR claim_status IN ('active', 'released', 'in_doubt'));
    `,
  ],
];

interface RepoRow {
  id: string;
  path: string;
  created_at: number;
  updated_at: number;
}

interface IssueRow {
  id: string;
  repo_id: string;
  issue_key: string;
  digest: string;
  title: string | null;
  detail_json: string | null;
  created_at: number;
  updated_at: number;
}

interface AttemptRow {
  id: string;
  issue_id: string;
  attempt_number: number;
  state: AttemptState;
  branch: string | null;
  base_sha: string;
  head_sha: string;
  session_id: string | null;
  pr_number: number | null;
  claim_ref: string | null;
  claim_head_sha: string | null;
  claim_digest: string | null;
  claim_owner: string | null;
  claim_status: IssueClaimEvidence["status"] | null;
  detail_json: string | null;
  created_at: number;
  updated_at: number;
}

interface EventRow {
  seq: number;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  data_json: string;
  created_at: number;
}

interface LeaseRow {
  resource: string;
  owner: string;
  fence: number;
  expires_at: number;
}

interface OperationRow {
  id: string;
  issue_id: string | null;
  attempt_id: string | null;
  idempotency_key: string;
  kind: string;
  request_json: string;
  state: "reserved" | "succeeded" | "failed";
  result_json: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

interface OutboxRow {
  id: number;
  operation_id: string;
  topic: string;
  payload_json: string;
  created_at: number;
  dispatched_at: number | null;
}

interface ApprovalRow {
  id: string;
  issue_id: string;
  action: string;
  issue_digest: string;
  policy_hash: string;
  head_sha: string;
  binding_ref: string;
  decision: "approved" | "denied";
  expires_at: number;
  created_at: number;
}

interface CheckRow {
  id: string;
  attempt_id: string;
  name: string;
  status: CheckStatus;
  detail_json: string | null;
  created_at: number;
  updated_at: number;
}

export class AutonomyStore {
  private readonly database: DatabaseSync;
  private closed = false;

  constructor(readonly filePath: string) {
    if (filePath !== ":memory:") {
      fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true, mode: 0o700 });
    }
    this.database = new DatabaseSync(filePath);
    try {
      this.database.exec("PRAGMA journal_mode = WAL");
      this.database.exec("PRAGMA foreign_keys = ON");
      this.database.exec("PRAGMA synchronous = FULL");
      this.database.exec("PRAGMA busy_timeout = 5000");
      this.migrate();
    } catch (error) {
      this.database.close();
      this.closed = true;
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
  }

  putRepo(input: { id: string; path: string; now?: number }): Repo {
    const now = timestamp(input.now);
    requireText(input.id, "repo id");
    requireText(input.path, "repo path");
    return this.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO repos(id, path, created_at, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET path = excluded.path, updated_at = excluded.updated_at`,
        )
        .run(input.id, input.path, now, now);
      const row = this.getRequiredRow<RepoRow>(
        "SELECT id, path, created_at, updated_at FROM repos WHERE id = ?",
        input.id,
      );
      this.appendEventUnsafe({
        aggregateType: "repo",
        aggregateId: input.id,
        type: "repo.saved",
        data: { path: input.path },
        createdAt: now,
      });
      return repoFromRow(row);
    });
  }

  putIssue(input: {
    id: string;
    repoId: string;
    key: string;
    digest: string;
    title?: string | null;
    detail?: JsonValue;
    now?: number;
  }): Issue {
    const now = timestamp(input.now);
    requireText(input.id, "issue id");
    requireText(input.repoId, "repo id");
    requireText(input.key, "issue key");
    requireText(input.digest, "issue digest");
    return this.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO issues(
             id, repo_id, issue_key, digest, title, detail_json, created_at, updated_at
           )
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             repo_id = excluded.repo_id,
             issue_key = excluded.issue_key,
             digest = excluded.digest,
             title = excluded.title,
             detail_json = excluded.detail_json,
             updated_at = excluded.updated_at`,
        )
        .run(
          input.id,
          input.repoId,
          input.key,
          input.digest,
          input.title ?? null,
          input.detail === undefined ? null : serializeJson(input.detail),
          now,
          now,
        );
      const row = this.getRequiredRow<IssueRow>(
        `SELECT id, repo_id, issue_key, digest, title, detail_json, created_at, updated_at
         FROM issues WHERE id = ?`,
        input.id,
      );
      this.appendEventUnsafe({
        aggregateType: "issue",
        aggregateId: input.id,
        type: "issue.saved",
        data: { digest: input.digest, key: input.key },
        createdAt: now,
      });
      return issueFromRow(row);
    });
  }

  beginAttempt(input: {
    id: string;
    issueId: string;
    headSha: string;
    baseSha?: string;
    branch?: string;
    sessionId?: string;
    prNumber?: number;
    claim?: IssueClaimEvidence;
    detail?: JsonValue;
    initialState?: AttemptState;
    now?: number;
  }): Attempt {
    const now = timestamp(input.now);
    requireText(input.id, "attempt id");
    requireText(input.issueId, "issue id");
    requireText(input.headSha, "head SHA");
    if (input.claim !== undefined) validateIssueClaim(input.claim);
    const initialState = input.initialState ?? "pending";
    return this.transaction(() => {
      const numberRow = this.database
        .prepare(
          `SELECT COALESCE(MAX(attempt_number), 0) + 1 AS next_number
           FROM attempts WHERE issue_id = ?`,
        )
        .get(input.issueId) as unknown as { next_number: number };
      const attemptNumber = numberRow.next_number;
      this.database
        .prepare(
          `INSERT INTO attempts(
             id, issue_id, attempt_number, state, branch, base_sha, head_sha,
             session_id, pr_number, claim_ref, claim_head_sha, claim_digest,
             claim_owner, claim_status, detail_json, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.issueId,
          attemptNumber,
          initialState,
          input.branch ?? null,
          input.baseSha ?? input.headSha,
          input.headSha,
          input.sessionId ?? null,
          input.prNumber ?? null,
          input.claim?.ref ?? null,
          input.claim?.headSha ?? null,
          input.claim?.digest ?? null,
          input.claim?.owner ?? null,
          input.claim?.status ?? null,
          input.detail === undefined ? null : serializeJson(input.detail),
          now,
          now,
        );
      this.appendEventUnsafe({
        aggregateType: "attempt",
        aggregateId: input.id,
        type: "attempt.begun",
        data: { issueId: input.issueId, number: attemptNumber, state: initialState },
        createdAt: now,
      });
      return this.getAttemptRequired(input.id);
    });
  }

  transitionAttempt(input: {
    attemptId: string;
    to: AttemptState;
    data?: JsonValue;
    lease?: LeaseGrant;
    now?: number;
  }): Attempt {
    const now = timestamp(input.now);
    return this.transaction(() => {
      const current = this.getAttemptRequired(input.attemptId);
      if (input.lease) {
        if (input.lease.resource !== `issue:${current.issueId}`) {
          throw new LeaseLostError(input.lease.resource);
        }
        this.assertLeaseUnsafe(input.lease, now);
      }
      if (!canTransitionAttempt(current.state, input.to)) {
        throw new Error(`Invalid attempt transition: ${current.state} -> ${input.to}`);
      }
      const result = this.database
        .prepare("UPDATE attempts SET state = ?, updated_at = ? WHERE id = ? AND state = ?")
        .run(input.to, now, input.attemptId, current.state);
      if (Number(result.changes) !== 1) {
        throw new Error(`Attempt "${input.attemptId}" changed concurrently`);
      }
      this.appendEventUnsafe({
        aggregateType: "attempt",
        aggregateId: input.attemptId,
        type: "attempt.transitioned",
        data: { from: current.state, to: input.to, detail: input.data ?? null },
        createdAt: now,
      });
      return this.getAttemptRequired(input.attemptId);
    });
  }

  getAttempt(attemptId: string): Attempt | undefined {
    this.assertOpen();
    const row = this.database
      .prepare(
        `SELECT id, issue_id, attempt_number, state, branch, base_sha, head_sha,
                session_id, pr_number, claim_ref, claim_head_sha, claim_digest,
                claim_owner, claim_status, detail_json, created_at, updated_at
         FROM attempts WHERE id = ?`,
      )
      .get(attemptId) as unknown as AttemptRow | undefined;
    return row ? attemptFromRow(row) : undefined;
  }

  getIssue(issueId: string): Issue | undefined {
    this.assertOpen();
    const row = this.database
      .prepare(
        `SELECT id, repo_id, issue_key, digest, title, detail_json, created_at, updated_at
         FROM issues WHERE id = ?`,
      )
      .get(issueId) as unknown as IssueRow | undefined;
    return row ? issueFromRow(row) : undefined;
  }

  listIssues(repoId?: string): Issue[] {
    this.assertOpen();
    const rows = (repoId === undefined
      ? this.database
          .prepare(
            `SELECT id, repo_id, issue_key, digest, title, detail_json, created_at, updated_at
             FROM issues ORDER BY created_at ASC`,
          )
          .all()
      : this.database
          .prepare(
            `SELECT id, repo_id, issue_key, digest, title, detail_json, created_at, updated_at
             FROM issues WHERE repo_id = ? ORDER BY created_at ASC`,
          )
          .all(repoId)) as unknown as IssueRow[];
    return rows.map(issueFromRow);
  }

  listAttempts(issueId?: string): Attempt[] {
    this.assertOpen();
    const select =
      `SELECT id, issue_id, attempt_number, state, branch, base_sha, head_sha,
              session_id, pr_number, claim_ref, claim_head_sha, claim_digest,
              claim_owner, claim_status, detail_json, created_at, updated_at FROM attempts`;
    const rows = (issueId === undefined
      ? this.database.prepare(`${select} ORDER BY created_at ASC`).all()
      : this.database
          .prepare(`${select} WHERE issue_id = ? ORDER BY attempt_number ASC`)
          .all(issueId)) as unknown as AttemptRow[];
    return rows.map(attemptFromRow);
  }

  getActiveAttempt(): Attempt | undefined {
    this.assertOpen();
    const row = this.database
      .prepare(
        `SELECT id, issue_id, attempt_number, state, branch, base_sha, head_sha,
                session_id, pr_number, claim_ref, claim_head_sha, claim_digest,
                claim_owner, claim_status, detail_json, created_at, updated_at
         FROM attempts
         WHERE state NOT IN ('delivered', 'succeeded', 'failed', 'cancelled', 'blocked')
         ORDER BY created_at ASC LIMIT 1`,
      )
      .get() as unknown as AttemptRow | undefined;
    return row ? attemptFromRow(row) : undefined;
  }

  updateIssueDetail(issueId: string, detail: JsonValue, now?: number): Issue {
    const at = timestamp(now);
    return this.transaction(() => {
      const result = this.database
        .prepare("UPDATE issues SET detail_json = ?, updated_at = ? WHERE id = ?")
        .run(serializeJson(detail), at, issueId);
      if (Number(result.changes) !== 1) throw new Error(`Unknown issue "${issueId}"`);
      this.appendEventUnsafe({
        aggregateType: "issue",
        aggregateId: issueId,
        type: "issue.detail-updated",
        data: detail,
        createdAt: at,
      });
      return this.getIssue(issueId)!;
    });
  }

  updateAttempt(input: {
    attemptId: string;
    branch?: string | null;
    baseSha?: string;
    headSha?: string;
    sessionId?: string | null;
    prNumber?: number | null;
    claim?: IssueClaimEvidence | null;
    detail?: JsonValue | null;
    lease?: LeaseGrant;
    now?: number;
  }): Attempt {
    const at = timestamp(input.now);
    return this.transaction(() => {
      const current = this.getAttemptRequired(input.attemptId);
      if (input.lease) {
        if (input.lease.resource !== `issue:${current.issueId}`) {
          throw new LeaseLostError(input.lease.resource);
        }
        this.assertLeaseUnsafe(input.lease, at);
      }
      const next = {
        branch: input.branch === undefined ? current.branch : input.branch,
        baseSha: input.baseSha ?? current.baseSha,
        headSha: input.headSha ?? current.headSha,
        sessionId: input.sessionId === undefined ? current.sessionId : input.sessionId,
        prNumber: input.prNumber === undefined ? current.prNumber : input.prNumber,
        claim: input.claim === undefined ? current.claim : input.claim,
        detail: input.detail === undefined ? current.detail : input.detail,
      };
      if (next.claim !== null) validateIssueClaim(next.claim);
      this.database
        .prepare(
          `UPDATE attempts SET branch = ?, base_sha = ?, head_sha = ?, session_id = ?,
             pr_number = ?, claim_ref = ?, claim_head_sha = ?, claim_digest = ?,
             claim_owner = ?, claim_status = ?, detail_json = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          next.branch,
          next.baseSha,
          next.headSha,
          next.sessionId,
          next.prNumber,
          next.claim?.ref ?? null,
          next.claim?.headSha ?? null,
          next.claim?.digest ?? null,
          next.claim?.owner ?? null,
          next.claim?.status ?? null,
          next.detail === null ? null : serializeJson(next.detail),
          at,
          input.attemptId,
        );
      this.appendEventUnsafe({
        aggregateType: "attempt",
        aggregateId: input.attemptId,
        type: "attempt.updated",
        data: {
          branch: next.branch,
          baseSha: next.baseSha,
          headSha: next.headSha,
          sessionId: next.sessionId,
          prNumber: next.prNumber,
          claim:
            next.claim === null
              ? null
              : {
                  ref: next.claim.ref,
                  headSha: next.claim.headSha,
                  digest: next.claim.digest,
                  owner: next.claim.owner,
                  status: next.claim.status,
                },
        },
        createdAt: at,
      });
      return this.getAttemptRequired(input.attemptId);
    });
  }

  appendEvent(input: EventInput): AutonomyEvent {
    return this.transaction(() => this.appendEventUnsafe(input));
  }

  listEvents(options: {
    afterSeq?: number;
    aggregateType?: string;
    aggregateId?: string;
    limit?: number;
  } = {}): AutonomyEvent[] {
    this.assertOpen();
    const clauses = ["seq > ?"];
    const parameters: Array<string | number> = [options.afterSeq ?? 0];
    if (options.aggregateType !== undefined) {
      clauses.push("aggregate_type = ?");
      parameters.push(options.aggregateType);
    }
    if (options.aggregateId !== undefined) {
      clauses.push("aggregate_id = ?");
      parameters.push(options.aggregateId);
    }
    const limit = options.limit ?? 1_000;
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Event limit must be positive");
    parameters.push(limit);
    const rows = this.database
      .prepare(
        `SELECT seq, aggregate_type, aggregate_id, event_type, data_json, created_at
         FROM events
         WHERE ${clauses.join(" AND ")}
         ORDER BY seq ASC
         LIMIT ?`,
      )
      .all(...parameters) as unknown as EventRow[];
    return rows.map(eventFromRow);
  }

  acquireLease(input: {
    resource: string;
    owner: string;
    ttlMs: number;
    now?: number;
  }): LeaseGrant {
    requireText(input.resource, "lease resource");
    requireText(input.owner, "lease owner");
    const now = timestamp(input.now);
    const expiresAt = leaseExpiry(now, input.ttlMs);
    return this.transaction(() => {
      const existing = this.database
        .prepare("SELECT resource, owner, fence, expires_at FROM leases WHERE resource = ?")
        .get(input.resource) as unknown as LeaseRow | undefined;
      if (existing && existing.expires_at > now) throw new LeaseConflictError(input.resource);

      const fence = existing ? existing.fence + 1 : 1;
      if (existing) {
        this.database
          .prepare(
            `UPDATE leases
             SET owner = ?, fence = ?, expires_at = ?, heartbeat_at = ?
             WHERE resource = ?`,
          )
          .run(input.owner, fence, expiresAt, now, input.resource);
      } else {
        this.database
          .prepare(
            `INSERT INTO leases(resource, owner, fence, expires_at, heartbeat_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(input.resource, input.owner, fence, expiresAt, now);
      }
      const grant = { resource: input.resource, owner: input.owner, fence, expiresAt };
      this.appendEventUnsafe({
        aggregateType: "lease",
        aggregateId: input.resource,
        type: "lease.acquired",
        data: { owner: input.owner, fence, expiresAt },
        createdAt: now,
      });
      return grant;
    });
  }

  heartbeatLease(input: {
    resource: string;
    owner: string;
    fence: number;
    ttlMs: number;
    now?: number;
  }): LeaseGrant {
    const now = timestamp(input.now);
    const expiresAt = leaseExpiry(now, input.ttlMs);
    requireFence(input.fence);
    return this.transaction(() => {
      const result = this.database
        .prepare(
          `UPDATE leases
           SET expires_at = ?, heartbeat_at = ?
           WHERE resource = ? AND owner = ? AND fence = ? AND expires_at > ?`,
        )
        .run(expiresAt, now, input.resource, input.owner, input.fence, now);
      if (Number(result.changes) !== 1) throw new LeaseLostError(input.resource);
      const grant = {
        resource: input.resource,
        owner: input.owner,
        fence: input.fence,
        expiresAt,
      };
      this.appendEventUnsafe({
        aggregateType: "lease",
        aggregateId: input.resource,
        type: "lease.heartbeat",
        data: { owner: input.owner, fence: input.fence, expiresAt },
        createdAt: now,
      });
      return grant;
    });
  }

  releaseLease(input: {
    resource: string;
    owner: string;
    fence: number;
    now?: number;
  }): boolean {
    const now = timestamp(input.now);
    requireFence(input.fence);
    return this.transaction(() => {
      const result = this.database
        .prepare("DELETE FROM leases WHERE resource = ? AND owner = ? AND fence = ?")
        .run(input.resource, input.owner, input.fence);
      if (Number(result.changes) !== 1) return false;
      this.appendEventUnsafe({
        aggregateType: "lease",
        aggregateId: input.resource,
        type: "lease.released",
        data: { owner: input.owner, fence: input.fence },
        createdAt: now,
      });
      return true;
    });
  }

  assertLease(grant: LeaseGrant, now?: number): void {
    const at = timestamp(now);
    this.assertOpen();
    this.assertLeaseUnsafe(grant, at);
  }

  reserveOperation(input: {
    id: string;
    idempotencyKey: string;
    kind: string;
    request: JsonValue;
    issueId?: string;
    attemptId?: string;
    outbox?: { topic: string; payload: JsonValue };
    now?: number;
  }): OperationReservation {
    const now = timestamp(input.now);
    const requestJson = serializeJson(input.request);
    requireText(input.id, "operation id");
    requireText(input.idempotencyKey, "idempotency key");
    requireText(input.kind, "operation kind");
    return this.transaction(() => {
      const existing = this.getOperationRow(input.idempotencyKey);
      if (existing) {
        if (
          existing.kind !== input.kind ||
          existing.request_json !== requestJson ||
          existing.issue_id !== (input.issueId ?? null) ||
          existing.attempt_id !== (input.attemptId ?? null)
        ) {
          throw new Error(`Idempotency key "${input.idempotencyKey}" is bound to another request`);
        }
        return { operation: operationFromRow(existing), created: false };
      }

      this.database
        .prepare(
          `INSERT INTO operations(
             id, issue_id, attempt_id, idempotency_key, kind, request_json,
             state, result_json, error, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'reserved', NULL, NULL, ?, ?)`,
        )
        .run(
          input.id,
          input.issueId ?? null,
          input.attemptId ?? null,
          input.idempotencyKey,
          input.kind,
          requestJson,
          now,
          now,
        );
      if (input.outbox) {
        requireText(input.outbox.topic, "outbox topic");
        this.database
          .prepare(
            `INSERT INTO outbox(operation_id, topic, payload_json, created_at, dispatched_at)
             VALUES (?, ?, ?, ?, NULL)`,
          )
          .run(input.id, input.outbox.topic, serializeJson(input.outbox.payload), now);
      }
      this.appendEventUnsafe({
        aggregateType: "operation",
        aggregateId: input.id,
        type: "operation.reserved",
        data: { idempotencyKey: input.idempotencyKey, kind: input.kind },
        createdAt: now,
      });
      return {
        operation: operationFromRow(this.getOperationRowRequired(input.idempotencyKey)),
        created: true,
      };
    });
  }

  reconcileOperation(input: {
    idempotencyKey: string;
    state: "succeeded" | "failed";
    result?: JsonValue;
    error?: string;
    now?: number;
  }): Operation {
    const now = timestamp(input.now);
    const resultJson = input.result === undefined ? null : serializeJson(input.result);
    const error = input.error ?? null;
    return this.transaction(() => {
      const existing = this.getOperationRowRequired(input.idempotencyKey);
      if (existing.state !== "reserved") {
        if (
          existing.state === input.state &&
          existing.result_json === resultJson &&
          existing.error === error
        ) {
          return operationFromRow(existing);
        }
        throw new Error(`Operation "${input.idempotencyKey}" was already reconciled differently`);
      }
      this.database
        .prepare(
          `UPDATE operations
           SET state = ?, result_json = ?, error = ?, updated_at = ?
           WHERE idempotency_key = ? AND state = 'reserved'`,
        )
        .run(input.state, resultJson, error, now, input.idempotencyKey);
      this.appendEventUnsafe({
        aggregateType: "operation",
        aggregateId: existing.id,
        type: "operation.reconciled",
        data: { state: input.state, error },
        createdAt: now,
      });
      return operationFromRow(this.getOperationRowRequired(input.idempotencyKey));
    });
  }

  listPendingOutbox(limit = 100): OutboxEntry[] {
    this.assertOpen();
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Outbox limit must be positive");
    const rows = this.database
      .prepare(
        `SELECT id, operation_id, topic, payload_json, created_at, dispatched_at
         FROM outbox WHERE dispatched_at IS NULL ORDER BY id ASC LIMIT ?`,
      )
      .all(limit) as unknown as OutboxRow[];
    return rows.map(outboxFromRow);
  }

  markOutboxDispatched(id: number, now?: number): boolean {
    const dispatchedAt = timestamp(now);
    return this.transaction(() => {
      const result = this.database
        .prepare("UPDATE outbox SET dispatched_at = ? WHERE id = ? AND dispatched_at IS NULL")
        .run(dispatchedAt, id);
      return Number(result.changes) === 1;
    });
  }

  recordApproval(input: {
    id: string;
    binding: ApprovalBinding;
    decision: "approved" | "denied";
    expiresAt: number;
    now?: number;
  }): Approval {
    const now = timestamp(input.now);
    const expiresAt = timestamp(input.expiresAt);
    const binding = input.binding;
    requireText(input.id, "approval id");
    return this.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO approvals(
             id, issue_id, action, issue_digest, policy_hash, head_sha,
             binding_ref, decision, expires_at, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          binding.issueId,
          binding.action,
          binding.issueDigest,
          binding.policyHash,
          binding.headSha,
          binding.bindingRef ?? "",
          input.decision,
          expiresAt,
          now,
        );
      this.appendEventUnsafe({
        aggregateType: "approval",
        aggregateId: input.id,
        type: "approval.recorded",
        data: { ...binding, decision: input.decision, expiresAt },
        createdAt: now,
      });
      return this.getApprovalRequired(input.id);
    });
  }

  findValidApproval(binding: ApprovalBinding, now?: number): Approval | undefined {
    this.assertOpen();
    const at = timestamp(now);
    const row = this.database
      .prepare(
        `SELECT id, issue_id, action, issue_digest, policy_hash, head_sha, binding_ref,
                decision, expires_at, created_at
         FROM approvals
         WHERE issue_id = ?
           AND action = ?
           AND issue_digest = ?
           AND policy_hash = ?
           AND head_sha = ?
           AND binding_ref = ?
           AND decision = 'approved'
           AND expires_at > ?
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(
        binding.issueId,
        binding.action,
        binding.issueDigest,
        binding.policyHash,
        binding.headSha,
        binding.bindingRef ?? "",
        at,
      ) as unknown as ApprovalRow | undefined;
    return row ? approvalFromRow(row) : undefined;
  }

  listApprovals(issueId?: string): Approval[] {
    this.assertOpen();
    const select =
      `SELECT id, issue_id, action, issue_digest, policy_hash, head_sha, binding_ref,
              decision, expires_at, created_at FROM approvals`;
    const rows = (issueId === undefined
      ? this.database.prepare(`${select} ORDER BY created_at DESC`).all()
      : this.database
          .prepare(`${select} WHERE issue_id = ? ORDER BY created_at DESC`)
          .all(issueId)) as unknown as ApprovalRow[];
    return rows.map(approvalFromRow);
  }

  recordCheck(input: {
    id: string;
    attemptId: string;
    name: string;
    status: CheckStatus;
    detail?: JsonValue;
    now?: number;
  }): Check {
    const now = timestamp(input.now);
    const detailJson = input.detail === undefined ? null : serializeJson(input.detail);
    return this.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO checks(
             id, attempt_id, name, status, detail_json, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(attempt_id, name) DO UPDATE SET
             status = excluded.status,
             detail_json = excluded.detail_json,
             updated_at = excluded.updated_at`,
        )
        .run(input.id, input.attemptId, input.name, input.status, detailJson, now, now);
      const row = this.database
        .prepare(
          `SELECT id, attempt_id, name, status, detail_json, created_at, updated_at
           FROM checks WHERE attempt_id = ? AND name = ?`,
        )
        .get(input.attemptId, input.name) as unknown as CheckRow;
      this.appendEventUnsafe({
        aggregateType: "check",
        aggregateId: row.id,
        type: "check.recorded",
        data: { attemptId: input.attemptId, name: input.name, status: input.status },
        createdAt: now,
      });
      return checkFromRow(row);
    });
  }

  listChecks(attemptId: string): Check[] {
    this.assertOpen();
    const rows = this.database
      .prepare(
        `SELECT id, attempt_id, name, status, detail_json, created_at, updated_at
         FROM checks WHERE attempt_id = ? ORDER BY name ASC`,
      )
      .all(attemptId) as unknown as CheckRow[];
    return rows.map(checkFromRow);
  }

  listOperations(attemptId?: string): Operation[] {
    this.assertOpen();
    const select =
      `SELECT id, issue_id, attempt_id, idempotency_key, kind, request_json,
              state, result_json, error, created_at, updated_at FROM operations`;
    const rows = (attemptId === undefined
      ? this.database.prepare(`${select} ORDER BY created_at ASC`).all()
      : this.database
          .prepare(`${select} WHERE attempt_id = ? ORDER BY created_at ASC`)
          .all(attemptId)) as unknown as OperationRow[];
    return rows.map(operationFromRow);
  }

  private migrate(): void {
    const current = Number(
      (
        this.database.prepare("PRAGMA user_version").get() as unknown as {
          user_version: number;
        }
      ).user_version,
    );
    if (current > SCHEMA_VERSION) {
      throw new Error(
        `Autonomy database schema ${current} is newer than supported version ${SCHEMA_VERSION}`,
      );
    }
    for (const [version, sql] of MIGRATIONS) {
      if (version <= current) continue;
      this.transaction(() => {
        this.database.exec(sql);
        this.database.exec(
          `CREATE TABLE IF NOT EXISTS schema_migrations (
             version INTEGER PRIMARY KEY,
             applied_at INTEGER NOT NULL
           ) STRICT`,
        );
        this.database
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
          .run(version, Date.now());
        this.database.exec(`PRAGMA user_version = ${version}`);
      });
    }
  }

  private transaction<T>(work: () => T): T {
    this.assertOpen();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const value = work();
      this.database.exec("COMMIT");
      return value;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private appendEventUnsafe(input: EventInput): AutonomyEvent {
    const createdAt = timestamp(input.createdAt);
    requireText(input.aggregateType, "event aggregate type");
    requireText(input.aggregateId, "event aggregate id");
    requireText(input.type, "event type");
    const result = this.database
      .prepare(
        `INSERT INTO events(aggregate_type, aggregate_id, event_type, data_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        input.aggregateType,
        input.aggregateId,
        input.type,
        serializeJson(input.data ?? null),
        createdAt,
      );
    const seq = Number(result.lastInsertRowid);
    return {
      seq,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      type: input.type,
      data: input.data ?? null,
      createdAt,
    };
  }

  private getAttemptRequired(attemptId: string): Attempt {
    const attempt = this.getAttempt(attemptId);
    if (!attempt) throw new Error(`Unknown attempt "${attemptId}"`);
    return attempt;
  }

  private getOperationRow(idempotencyKey: string): OperationRow | undefined {
    return this.database
      .prepare(
        `SELECT id, issue_id, attempt_id, idempotency_key, kind, request_json,
                state, result_json, error, created_at, updated_at
         FROM operations WHERE idempotency_key = ?`,
      )
      .get(idempotencyKey) as unknown as OperationRow | undefined;
  }

  private getOperationRowRequired(idempotencyKey: string): OperationRow {
    const row = this.getOperationRow(idempotencyKey);
    if (!row) throw new Error(`Unknown operation "${idempotencyKey}"`);
    return row;
  }

  private getApprovalRequired(id: string): Approval {
    const row = this.getRequiredRow<ApprovalRow>(
      `SELECT id, issue_id, action, issue_digest, policy_hash, head_sha, binding_ref,
              decision, expires_at, created_at
       FROM approvals WHERE id = ?`,
      id,
    );
    return approvalFromRow(row);
  }

  private getRequiredRow<Row>(sql: string, parameter: string): Row {
    const row = this.database.prepare(sql).get(parameter) as unknown as Row | undefined;
    if (!row) throw new Error("Expected row was not persisted");
    return row;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Autonomy store is closed");
  }

  private assertLeaseUnsafe(grant: LeaseGrant, now: number): void {
    const row = this.database
      .prepare("SELECT resource, owner, fence, expires_at FROM leases WHERE resource = ?")
      .get(grant.resource) as unknown as LeaseRow | undefined;
    if (
      !row ||
      row.owner !== grant.owner ||
      row.fence !== grant.fence ||
      row.expires_at <= now
    ) {
      throw new LeaseLostError(grant.resource);
    }
  }
}

function repoFromRow(row: RepoRow): Repo {
  return {
    id: row.id,
    path: row.path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function issueFromRow(row: IssueRow): Issue {
  return {
    id: row.id,
    repoId: row.repo_id,
    key: row.issue_key,
    digest: row.digest,
    title: row.title,
    detail: row.detail_json === null ? null : parseJson(row.detail_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function attemptFromRow(row: AttemptRow): Attempt {
  const claimValues = [
    row.claim_ref,
    row.claim_head_sha,
    row.claim_digest,
    row.claim_owner,
    row.claim_status,
  ];
  if (claimValues.some((value) => value === null) && claimValues.some((value) => value !== null)) {
    throw new Error("Attempt has partial issue-claim evidence");
  }
  const claim =
    row.claim_ref === null
      ? null
      : {
          ref: row.claim_ref,
          headSha: row.claim_head_sha!,
          digest: row.claim_digest!,
          owner: row.claim_owner!,
          status: row.claim_status!,
        };
  if (claim !== null) validateIssueClaim(claim);
  return {
    id: row.id,
    issueId: row.issue_id,
    number: row.attempt_number,
    state: row.state,
    branch: row.branch,
    baseSha: row.base_sha,
    headSha: row.head_sha,
    sessionId: row.session_id,
    prNumber: row.pr_number,
    claim,
    detail: row.detail_json === null ? null : parseJson(row.detail_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function eventFromRow(row: EventRow): AutonomyEvent {
  return {
    seq: row.seq,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    type: row.event_type,
    data: parseJson(row.data_json),
    createdAt: row.created_at,
  };
}

function operationFromRow(row: OperationRow): Operation {
  return {
    id: row.id,
    issueId: row.issue_id,
    attemptId: row.attempt_id,
    idempotencyKey: row.idempotency_key,
    kind: row.kind,
    request: parseJson(row.request_json),
    state: row.state,
    result: row.result_json === null ? null : parseJson(row.result_json),
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function outboxFromRow(row: OutboxRow): OutboxEntry {
  return {
    id: row.id,
    operationId: row.operation_id,
    topic: row.topic,
    payload: parseJson(row.payload_json),
    createdAt: row.created_at,
    dispatchedAt: row.dispatched_at,
  };
}

function approvalFromRow(row: ApprovalRow): Approval {
  return {
    id: row.id,
    issueId: row.issue_id,
    action: row.action,
    issueDigest: row.issue_digest,
    policyHash: row.policy_hash,
    headSha: row.head_sha,
    ...(row.binding_ref ? { bindingRef: row.binding_ref } : {}),
    decision: row.decision,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

function checkFromRow(row: CheckRow): Check {
  return {
    id: row.id,
    attemptId: row.attempt_id,
    name: row.name,
    status: row.status,
    detail: row.detail_json === null ? null : parseJson(row.detail_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeJson(value: JsonValue): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Value is not JSON serializable");
  return serialized;
}

function parseJson(value: string): JsonValue {
  return JSON.parse(value) as JsonValue;
}

function timestamp(value: number | undefined): number {
  const result = value ?? Date.now();
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error("Timestamp must be a non-negative safe integer");
  }
  return result;
}

function leaseExpiry(now: number, ttlMs: number): number {
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new Error("Lease TTL must be a positive safe integer");
  }
  const expiresAt = now + ttlMs;
  if (!Number.isSafeInteger(expiresAt)) throw new Error("Lease expiry is out of range");
  return expiresAt;
}

function requireFence(fence: number): void {
  if (!Number.isSafeInteger(fence) || fence <= 0) {
    throw new Error("Lease fence must be a positive safe integer");
  }
}

function requireText(value: string, label: string): void {
  if (!value.trim()) throw new Error(`${label} must not be empty`);
}

function validateIssueClaim(claim: IssueClaimEvidence): void {
  requireText(claim.ref, "claim ref");
  requireText(claim.owner, "claim owner");
  if (!/^refs\/heads\/one-cli-lease\/issue-[1-9][0-9]*-[0-9a-f]{64}$/u.test(claim.ref)) {
    throw new Error("Claim ref is invalid");
  }
  if (!/^[0-9a-f]{40}$/u.test(claim.headSha)) throw new Error("Claim head SHA is invalid");
  if (!/^[0-9a-f]{64}$/u.test(claim.digest)) throw new Error("Claim digest is invalid");
  if (!["active", "released", "in_doubt"].includes(claim.status)) {
    throw new Error("Claim status is invalid");
  }
}
