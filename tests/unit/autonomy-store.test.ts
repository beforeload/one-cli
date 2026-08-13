import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApprovalBinding } from "../../src/autonomy/domain.js";
import {
  LeaseConflictError,
  LeaseCoordinator,
  LeaseLostError,
} from "../../src/autonomy/lease.js";
import { AutonomyStore } from "../../src/autonomy/store.js";
import { makeTempDir, removeTempDir } from "../helpers.js";

describe("AutonomyStore", () => {
  let root: string;
  let databasePath: string;
  let store: AutonomyStore;

  beforeEach(() => {
    root = makeTempDir("autonomy");
    databasePath = path.join(root, "nested", "state.sqlite");
    store = new AutonomyStore(databasePath);
    store.putRepo({ id: "repo-1", path: "/workspace/repo", now: 1 });
    store.putIssue({
      id: "issue-1",
      repoId: "repo-1",
      key: "ONE-1",
      digest: "digest-1",
      now: 2,
    });
  });

  afterEach(() => {
    store.close();
    removeTempDir(root);
  });

  it("enforces lease exclusivity and fences stale owners after takeover", () => {
    const first = store.acquireLease({
      resource: "issue:issue-1",
      owner: "worker-a",
      ttlMs: 100,
      now: 1_000,
    });
    expect(first).toMatchObject({ fence: 1, expiresAt: 1_100 });
    expect(() =>
      store.acquireLease({
        resource: "issue:issue-1",
        owner: "worker-b",
        ttlMs: 100,
        now: 1_050,
      }),
    ).toThrow(LeaseConflictError);

    const renewed = store.heartbeatLease({ ...first, ttlMs: 100, now: 1_050 });
    expect(renewed.expiresAt).toBe(1_150);
    const takeover = store.acquireLease({
      resource: "issue:issue-1",
      owner: "worker-b",
      ttlMs: 100,
      now: 1_150,
    });
    expect(takeover.fence).toBe(2);
    expect(() => store.heartbeatLease({ ...first, ttlMs: 100, now: 1_151 })).toThrow(
      LeaseLostError,
    );
    expect(store.releaseLease({ ...first, now: 1_151 })).toBe(false);
    expect(store.releaseLease({ ...takeover, now: 1_151 })).toBe(true);

    store.close();
    store = new AutonomyStore(databasePath);
    const reacquired = store.acquireLease({
      resource: "issue:issue-1",
      owner: takeover.owner,
      ttlMs: 100,
      now: 1_151,
    });
    expect(reacquired.fence).toBe(3);
    expect(() => store.heartbeatLease({ ...takeover, ttlMs: 100, now: 1_152 })).toThrow(
      LeaseLostError,
    );
    expect(store.releaseLease({ ...takeover, now: 1_152 })).toBe(false);
    expect(store.releaseLease({ ...reacquired, now: 1_152 })).toBe(true);
  });

  it("renews leases with an injected clock and records only new heartbeats", () => {
    let now = 2_000;
    const leases = new LeaseCoordinator(store, () => now);
    let grant = leases.acquireIssue("issue-1", "worker-clock", 100);
    const afterSetup = store.listEvents({ limit: 10_000 }).at(-1)?.seq ?? 0;

    now = 2_040;
    grant = leases.heartbeat(grant, 100);
    now = 2_080;
    grant = leases.heartbeat(grant, 100);

    expect(grant.expiresAt).toBe(2_180);
    expect(
      store
        .listEvents({
          afterSeq: afterSetup,
          aggregateType: "lease",
          aggregateId: grant.resource,
        })
        .map((event) => ({ type: event.type, createdAt: event.createdAt, data: event.data })),
    ).toEqual([
      {
        type: "lease.heartbeat",
        createdAt: 2_040,
        data: { owner: "worker-clock", fence: grant.fence, expiresAt: 2_140 },
      },
      {
        type: "lease.heartbeat",
        createdAt: 2_080,
        data: { owner: "worker-clock", fence: grant.fence, expiresAt: 2_180 },
      },
    ]);
  });

  it("allows only declared attempt transitions", () => {
    const attempt = store.beginAttempt({
      id: "attempt-1",
      issueId: "issue-1",
      headSha: "abc123",
      now: 10,
    });
    expect(attempt).toMatchObject({ number: 1, state: "pending" });
    expect(() =>
      store.transitionAttempt({ attemptId: attempt.id, to: "succeeded", now: 11 }),
    ).toThrow("Invalid attempt transition");

    expect(
      store.transitionAttempt({ attemptId: attempt.id, to: "running", now: 12 }).state,
    ).toBe("running");
    expect(
      store.transitionAttempt({
        attemptId: attempt.id,
        to: "waiting_approval",
        now: 13,
      }).state,
    ).toBe("waiting_approval");
    expect(
      store.transitionAttempt({ attemptId: attempt.id, to: "running", now: 14 }).state,
    ).toBe("running");
    expect(
      store.transitionAttempt({ attemptId: attempt.id, to: "succeeded", now: 15 }).state,
    ).toBe("succeeded");
    expect(() =>
      store.transitionAttempt({ attemptId: attempt.id, to: "running", now: 16 }),
    ).toThrow("Invalid attempt transition");
  });

  it("cannot manually fabricate success from in-doubt state", () => {
    const attempt = store.beginAttempt({
      id: "attempt-in-doubt",
      issueId: "issue-1",
      headSha: "abc123",
      initialState: "verifying",
      now: 10,
    });
    store.transitionAttempt({ attemptId: attempt.id, to: "in_doubt", now: 11 });
    expect(() =>
      store.transitionAttempt({ attemptId: attempt.id, to: "succeeded", now: 12 }),
    ).toThrow("Invalid attempt transition");
  });

  it("fences durable attempt writes with the process-specific issue lease", () => {
    const first = store.acquireLease({
      resource: "issue:issue-1",
      owner: "worker-100-attempt-1",
      ttlMs: 100,
      now: 1_000,
    });
    const attempt = store.beginAttempt({
      id: "attempt-fenced",
      issueId: "issue-1",
      headSha: "abc123",
      initialState: "planning",
      now: 1_000,
    });
    store.updateAttempt({
      attemptId: attempt.id,
      detail: { fence: first.fence },
      lease: first,
      now: 1_050,
    });
    store.acquireLease({
      resource: "issue:issue-1",
      owner: "worker-200-attempt-1",
      ttlMs: 100,
      now: 1_100,
    });
    expect(() =>
      store.transitionAttempt({
        attemptId: attempt.id,
        to: "implementing",
        lease: first,
        now: 1_101,
      }),
    ).toThrow(LeaseLostError);
  });

  it("reserves and reconciles operations idempotently with an outbox", () => {
    const input = {
      id: "operation-1",
      issueId: "issue-1",
      idempotencyKey: "comment:ONE-1:v1",
      kind: "post-comment",
      request: { body: "done" },
      outbox: { topic: "github.comment", payload: { issue: "ONE-1" } },
      now: 20,
    } as const;

    const first = store.reserveOperation(input);
    const duplicate = store.reserveOperation({ ...input, now: 21 });
    expect(first.created).toBe(true);
    expect(duplicate.created).toBe(false);
    expect(duplicate.operation.id).toBe(first.operation.id);
    expect(store.listPendingOutbox()).toHaveLength(1);
    expect(() =>
      store.reserveOperation({ ...input, request: { body: "different" }, now: 22 }),
    ).toThrow("bound to another request");

    const completed = store.reconcileOperation({
      idempotencyKey: input.idempotencyKey,
      state: "succeeded",
      result: { commentId: 42 },
      now: 23,
    });
    const replay = store.reconcileOperation({
      idempotencyKey: input.idempotencyKey,
      state: "succeeded",
      result: { commentId: 42 },
      now: 24,
    });
    expect(completed.state).toBe("succeeded");
    expect(replay).toEqual(completed);
    expect(() =>
      store.reconcileOperation({
        idempotencyKey: input.idempotencyKey,
        state: "failed",
        error: "late failure",
        now: 25,
      }),
    ).toThrow("already reconciled differently");
  });

  it("persists complete issue-claim evidence in attempts and events", () => {
    const lease = store.acquireLease({
      resource: "issue:issue-1",
      owner: "host-a-attempt-1",
      ttlMs: 1_000,
      now: 100,
    });
    const attempt = store.beginAttempt({
      id: "attempt-claim",
      issueId: "issue-1",
      initialState: "pending",
      baseSha: "a".repeat(40),
      headSha: "a".repeat(40),
      now: 100,
    });
    const claim = {
      ref: `refs/heads/one-cli-lease/issue-1-${"b".repeat(64)}`,
      headSha: "a".repeat(40),
      digest: "b".repeat(64),
      owner: lease.owner,
      status: "active" as const,
    };

    store.updateAttempt({ attemptId: attempt.id, claim, lease, now: 101 });

    expect(store.getAttempt(attempt.id)?.claim).toEqual(claim);
    expect(
      store
        .listEvents({ aggregateType: "attempt", aggregateId: attempt.id })
        .find((event) => event.type === "attempt.updated")?.data,
    ).toMatchObject({ claim });
  });

  it("requires every approval binding input and rejects expired approvals", () => {
    const binding: ApprovalBinding = {
      issueId: "issue-1",
      action: "merge",
      issueDigest: "digest-1",
      policyHash: "policy-1",
      headSha: "abc123",
      bindingRef: "base:diff",
    };
    store.recordApproval({
      id: "approval-1",
      binding,
      decision: "approved",
      expiresAt: 2_000,
      now: 1_000,
    });

    expect(store.findValidApproval(binding, 1_999)?.id).toBe("approval-1");
    expect(store.findValidApproval({ ...binding, action: "close" }, 1_999)).toBeUndefined();
    expect(
      store.findValidApproval({ ...binding, issueDigest: "digest-2" }, 1_999),
    ).toBeUndefined();
    expect(
      store.findValidApproval({ ...binding, policyHash: "policy-2" }, 1_999),
    ).toBeUndefined();
    expect(store.findValidApproval({ ...binding, headSha: "def456" }, 1_999)).toBeUndefined();
    expect(
      store.findValidApproval({ ...binding, bindingRef: "base:other-diff" }, 1_999),
    ).toBeUndefined();
    expect(store.findValidApproval(binding, 2_000)).toBeUndefined();
  });

  it("lists monotonic events in order and persists them across reopen", () => {
    const appended = store.appendEvent({
      aggregateType: "issue",
      aggregateId: "issue-1",
      type: "issue.observed",
      data: { revision: 1 },
      createdAt: 30,
    });
    store.appendEvent({
      aggregateType: "issue",
      aggregateId: "issue-1",
      type: "issue.observed",
      data: { revision: 2 },
      createdAt: 31,
    });

    const beforeClose = store.listEvents({ afterSeq: appended.seq - 1 });
    expect(beforeClose.map((event) => event.seq)).toEqual([
      appended.seq,
      appended.seq + 1,
    ]);
    expect(beforeClose.map((event) => event.data)).toEqual([{ revision: 1 }, { revision: 2 }]);

    store.close();
    store = new AutonomyStore(databasePath);
    const afterReopen = store.listEvents({ afterSeq: appended.seq - 1 });
    expect(afterReopen).toEqual(beforeClose);
  });

  it("upserts research baselines, observations, and selectable gap findings", () => {
    const checkpoint = store.upsertResearchCheckpoint({
      sourceId: "qwen-code",
      kind: "release",
      policyHash: "policy-a",
      channelState: "baselined",
      cursor: "cursor-1",
      lastSha: "a".repeat(40),
      lastId: "release-1",
      now: 100,
    });
    expect(checkpoint).toMatchObject({ cursor: "cursor-1", lastId: "release-1" });
    expect(
      store.upsertResearchCheckpoint({
        sourceId: "qwen-code",
        kind: "release",
        policyHash: "policy-b",
        channelState: "baselined",
        cursor: "cursor-2",
        lastSha: "b".repeat(40),
        lastId: "release-2",
        now: 101,
      }),
    ).toMatchObject({ createdAt: 100, updatedAt: 101, policyHash: "policy-b" });

    const observation = store.upsertResearchObservation({
      id: "observation-1",
      sourceId: "qwen-code",
      kind: "release",
      externalId: "release-2",
      sourceUrl: "https://github.com/QwenLM/qwen-code/releases/tag/v2",
      sha: "b".repeat(40),
      evidence: { title: "parallel agents" },
      observedAt: 102,
      now: 102,
    });
    expect(store.listResearchObservations({ sourceId: "qwen-code" })).toEqual([observation]);

    store.upsertGapFinding({
      fingerprint: "f".repeat(64),
      sourceId: "qwen-code",
      observationId: observation.id,
      category: "extensions-parallelism",
      topic: "parallel-agents",
      subcode: "parallel.agents",
      evidence: { local: ["src/agent.ts"] },
      score: 90,
      confidence: "confirmed",
      status: "eligible",
      policyHash: "policy-b",
      expiresAt: 10_000,
      now: 103,
    });
    expect(store.selectGapFindings({ policyHash: "policy-b", now: 104, limit: 1 })).toHaveLength(1);
    expect(store.listGapFindings({ now: 10_000 })).toHaveLength(0);
    expect(store.deleteResearchObservation(observation.id)).toBe(true);
    expect(store.getGapFinding("f".repeat(64))).toBeUndefined();
  });

  it("migrates a version-three database without losing its existing data", () => {
    const legacyPath = path.join(root, "legacy.sqlite");
    const legacy = new DatabaseSync(legacyPath);
    legacy.exec(`
      CREATE TABLE legacy_data(id TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      INSERT INTO legacy_data(id, value) VALUES ('kept', 'baseline');
      PRAGMA user_version = 3;
    `);
    legacy.close();

    const migrated = new AutonomyStore(legacyPath);
    migrated.upsertResearchCheckpoint({
      sourceId: "claude-code",
      kind: "repository",
      policyHash: "policy",
      channelState: "baselined",
      lastSha: "c".repeat(40),
      now: 200,
    });
    migrated.close();

    const inspect = new DatabaseSync(legacyPath);
    expect(
      inspect.prepare("SELECT value FROM legacy_data WHERE id = 'kept'").get(),
    ).toMatchObject({ value: "baseline" });
    expect(
      inspect.prepare("SELECT COUNT(*) AS count FROM research_checkpoints").get(),
    ).toMatchObject({ count: 1 });
    inspect.close();
    expect(fs.existsSync(legacyPath)).toBe(true);
  });

  it("opens current state immutably and treats older state as empty inventory", () => {
    store.close();
    const currentBytes = fs.readFileSync(databasePath);
    const currentMtime = fs.statSync(databasePath).mtimeMs;
    const readOnly = new AutonomyStore(databasePath, { readOnly: true });
    expect(readOnly.listIssues("repo-1")).toHaveLength(1);
    expect(() => readOnly.appendEvent({
      aggregateType: "test",
      aggregateId: "readonly",
      type: "forbidden",
    })).toThrow();
    readOnly.close();
    expect(fs.readFileSync(databasePath)).toEqual(currentBytes);
    expect(fs.statSync(databasePath).mtimeMs).toBe(currentMtime);

    const oldPath = path.join(root, "old.sqlite");
    const old = new DatabaseSync(oldPath);
    old.exec("CREATE TABLE legacy(id INTEGER PRIMARY KEY); PRAGMA user_version = 3");
    old.close();
    const oldBytes = fs.readFileSync(oldPath);
    const inventory = new AutonomyStore(oldPath, { readOnly: true });
    expect(inventory.listIssues()).toEqual([]);
    expect(inventory.listResearchCheckpoints()).toEqual([]);
    inventory.close();
    expect(fs.readFileSync(oldPath)).toEqual(oldBytes);
  });
});
