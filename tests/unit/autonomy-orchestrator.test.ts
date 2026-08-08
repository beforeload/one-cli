import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatProvider } from "../../src/domain.js";
import { loadAutonomyConfig, type AutonomyMode } from "../../src/autonomy/config.js";
import type {
  GitHubCheck,
  GitHubIssue,
  GitHubPort,
  GitHubPullRequest,
} from "../../src/autonomy/github.js";
import { GitHubRefConflictError } from "../../src/autonomy/github.js";
import {
  AutonomyOrchestrator,
  type OrchestratorGitPort,
} from "../../src/autonomy/orchestrator.js";
import { AutonomyStore } from "../../src/autonomy/store.js";
import type { ProcessResult } from "../../src/autonomy/process.js";
import { EXECUTION_MARKER } from "../../src/autonomy/intake.js";
import { makeTempDir, removeTempDir } from "../helpers.js";

describe("AutonomyOrchestrator", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) removeTempDir(root);
  });

  it("selects only an exact-author normalized eligible issue", async () => {
    const home = makeTempDir("orchestrator");
    roots.push(home);
    const loaded = loadAutonomyConfig(path.resolve(import.meta.dirname, "../.."), {
      env: { ONE_CLI_HOME: home },
    });
    const config = { ...loaded, mode: "auto-pr" as const };
    const body = `${EXECUTION_MARKER}\n${config.issuePolicy.normalization.requiredFields
      .map((field) => `## ${field.replace(/[A-Z]/gu, (letter) => ` ${letter}`).replace(/^./u, (letter) => letter.toUpperCase())}\nvalue`)
      .join("\n\n")}`;
    const issue: GitHubIssue = {
      number: 7,
      title: "Safe vertical change",
      body,
      state: "open",
      htmlUrl: "https://example.test/issues/7",
      user: { login: "beforeload" },
      labels: ["agent-ready"],
    };
    const github = {
      listCandidateIssues: async () => [issue],
      findPullRequestByHead: async () => undefined,
      getRef: async () => undefined,
      createRef: async (_repository: unknown, ref: string, sha: string) => ({ ref, sha }),
      deleteRef: async () => undefined,
    } as unknown as GitHubPort;
    const git = {
      ensureBare: async () => ({ id: config.repoKey, barePath: path.join(home, "bare.git") }),
      fetchBase: async () => "a".repeat(40),
      remoteBranchExists: async () => false,
    } as unknown as OrchestratorGitPort;
    const provider = {
      async *stream() {
        yield { type: "text_delta", delta: "unused" } as const;
      },
    } satisfies ChatProvider;
    const store = new AutonomyStore(path.join(home, "state.sqlite"));
    try {
      const orchestrator = new AutonomyOrchestrator({
        config,
        store,
        github,
        git,
        remoteUrl: "https://example.test/repo.git",
        sandboxFactory: () => {
          throw new Error("unused");
        },
        reviewer: { review: async () => ({}) },
        provider,
        runConfig: {
          apiKey: "not-used",
          baseUrl: "https://example.test/v1",
          model: "test",
          home,
          maxRounds: 1,
          maxToolCalls: 1,
          shellTimeoutMs: 1_000,
        },
        id: () => "attempt-1",
      });
      const result = await orchestrator.tick(new AbortController().signal);
      expect(result).toMatchObject({ state: "issue_selected", attemptId: "attempt-1" });
      expect(store.getActiveAttempt()).toMatchObject({
        branch: "issue/7-safe-vertical-change",
        baseSha: "a".repeat(40),
      });
    } finally {
      store.close();
    }
  });

  it.each([
    ["propose", "succeeded", 0, 0],
    ["auto-pr", "delivered", 1, 0],
    ["auto-merge", "succeeded", 1, 1],
  ] as const)(
    "runs the complete %s authority boundary",
    async (mode, terminal, expectedPulls, expectedMerges) => {
      const harness = createHarness(mode, roots);
      try {
        const states = await harness.runUntil(terminal);
        expect(states).toContain("verifying");
        expect(harness.github.createPullCount).toBe(expectedPulls);
        expect(harness.github.mergeCount).toBe(expectedMerges);
        if (mode === "propose") {
          expect(harness.git.commitCount).toBe(0);
          expect(harness.git.pushCount).toBe(0);
        }
        if (mode === "auto-pr") {
          expect(states).toContain("pr_open");
          expect(harness.store.getActiveAttempt()).toBeUndefined();
        }
        if (mode === "auto-merge") {
          expect(states).toContain("post_merge");
          expect(harness.store.listOperations().map((operation) => operation.kind)).toEqual(
            expect.arrayContaining([
              "git.commit",
              "git.push",
              "github.create-pull-request",
              "github.merge-pull-request",
              "github.comment",
              "github.close-issue",
              "github.delete-branch",
            ]),
          );
        }
      } finally {
        harness.store.close();
      }
    },
  );

  it("requires critical approvals before gates and publish", async () => {
    const harness = createHarness("auto-pr", roots, { changedPath: "package.json" });
    try {
      await harness.tick();
      await harness.tick();
      expect((await harness.tick()).state).toBe("waiting_approval");
      expect(harness.sandboxRuns).toHaveLength(0);

      approvePending(harness);
      expect((await harness.tick()).state).toBe("verifying");
      expect((await harness.tick()).state).toBe("waiting_approval");
      expect(harness.sandboxRuns.length).toBeGreaterThan(0);
      expect(harness.git.commitCount).toBe(0);
      expect(harness.store.getActiveAttempt()?.detail).toMatchObject({
        pendingApprovalAction: "publish",
      });
    } finally {
      harness.store.close();
    }
  });

  it("blocks governance changes and releases their issue lease", async () => {
    const harness = createHarness("auto-merge", roots, { changedPath: "AUTONOMY.md" });
    try {
      await harness.tick();
      await harness.tick();
      expect((await harness.tick()).state).toBe("blocked");
      expect(() =>
        harness.store.acquireLease({
          resource: "issue:github-7",
          owner: "maintainer-retry",
          ttlMs: 1_000,
        }),
      ).not.toThrow();
      expect(harness.sandboxRuns).toHaveLength(0);
    } finally {
      harness.store.close();
    }
  });

  it("cancels a blocked attempt through coordinator recovery", async () => {
    const harness = createHarness("auto-merge", roots, { changedPath: "AUTONOMY.md" });
    try {
      await harness.tick();
      await harness.tick();
      expect((await harness.tick()).state).toBe("blocked");
      const attemptId = harness.store.listAttempts()[0]!.id;
      await expect(
        harness.orchestrator.cancelAttempt(
          attemptId,
          "operator cancelled",
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({ state: "cancelled" });
      expect(harness.store.getAttempt(attemptId)).toMatchObject({
        state: "cancelled",
        claim: { status: "released" },
      });
    } finally {
      harness.store.close();
    }
  });

  it("never adopts an exact-head foreign claim during recovery", async () => {
    const harness = createHarness("auto-merge", roots, {
      changedPath: "AUTONOMY.md",
      foreignClaimOnRecovery: true,
    });
    try {
      await harness.tick();
      await harness.tick();
      expect((await harness.tick()).state).toBe("blocked");
      const attemptId = harness.store.listAttempts()[0]!.id;
      await expect(
        harness.orchestrator.retryAttempt(
          attemptId,
          "",
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({ state: "in_doubt" });
      expect(harness.claimDeleteCount).toBe(1);
      expect(harness.store.getAttempt(attemptId)?.claim?.status).toBe("released");
    } finally {
      harness.store.close();
    }
  });

  it("reconciles a lost pull-request response by branch and exact head", async () => {
    const harness = createHarness("auto-pr", roots, { losePullResponse: true });
    try {
      await harness.tick();
      await harness.tick();
      expect((await harness.tick()).state).toBe("in_doubt");
      expect(harness.store.getActiveAttempt()?.prNumber).toBeNull();
      const reconciled = await harness.tick();
      expect(reconciled).toMatchObject({ action: "reconcile", state: "pr_open" });
      expect(harness.store.listOperations().find((operation) => operation.kind.includes("pull"))?.state)
        .toBe("succeeded");
    } finally {
      harness.store.close();
    }
  });

  it("reconciles a lost atomic claim-create response for the same durable attempt", async () => {
    const harness = createHarness("auto-pr", roots, { loseClaimResponse: true });
    try {
      await expect(harness.tick()).resolves.toMatchObject({
        action: "select",
        state: "issue_selected",
      });
      expect(harness.store.getActiveAttempt()?.claim).toMatchObject({
        status: "active",
        headSha: "a".repeat(40),
      });
      expect(
        harness.store
          .listOperations()
          .find((operation) => operation.kind === "github.create-issue-claim")?.state,
      ).toBe("succeeded");
    } finally {
      harness.store.close();
    }
  });

  it("best-effort deletes a created claim when durable claim persistence fails", async () => {
    const harness = createHarness("auto-pr", roots, { claimPersistenceFailure: true });
    try {
      await expect(harness.tick()).resolves.toMatchObject({
        action: "claim",
        state: "in_doubt",
      });
      expect(harness.claimDeleteCount).toBe(1);
      expect(harness.claim).toBeUndefined();
      expect(harness.store.getActiveAttempt()?.state).toBe("in_doubt");
      expect(() =>
        harness.store.acquireLease({
          resource: "issue:github-7",
          owner: "racer",
          ttlMs: 1_000,
          now: 10_000,
        }),
      ).toThrow("held by another owner");
    } finally {
      harness.store.close();
    }
  });

  it("records a stale foreign claim and never auto-steals it", async () => {
    const harness = createHarness("auto-pr", roots, { preexistingClaim: true });
    try {
      await expect(harness.tick()).resolves.toMatchObject({ state: "idle" });
      expect(harness.store.getActiveAttempt()).toBeUndefined();
      expect(harness.claimDeleteCount).toBe(0);
      expect(
        harness.store
          .listEvents({ aggregateType: "issue", aggregateId: "github-7" })
          .find((event) => event.type === "issue-claim.acquisition-blocked")?.data,
      ).toMatchObject({ autoDelete: false });
      const digest = harness.claim!.ref.slice(-64);
      await expect(
        harness.orchestrator.inspectIssueClaim(7, digest, new AbortController().signal),
      ).resolves.toMatchObject({
        localAttemptId: null,
        issueBranchHead: null,
        pullRequestNumber: null,
        removalEligible: true,
        approvalRequired: true,
      });
    } finally {
      harness.store.close();
    }
  });

  it("allows exactly one winner across two independent stores racing one issue", async () => {
    const sharedClaims = new Map<string, string>();
    let arrivals = 0;
    let release!: () => void;
    const bothReady = new Promise<void>((resolve) => {
      release = resolve;
    });
    const barrier = async () => {
      arrivals++;
      if (arrivals === 2) release();
      await bothReady;
    };
    const first = createHarness("auto-pr", roots, {
      sharedClaims,
      claimReadBarrier: barrier,
      idPrefix: "host-a",
    });
    const second = createHarness("auto-pr", roots, {
      sharedClaims,
      claimReadBarrier: barrier,
      idPrefix: "host-b",
    });
    try {
      const results = await Promise.all([first.tick(), second.tick()]);
      expect(results.map((result) => result.state).sort()).toEqual([
        "blocked",
        "issue_selected",
      ]);
      const executable = [first.store, second.store]
        .map((store) => store.getActiveAttempt())
        .filter((attempt) => attempt?.state === "issue_selected");
      expect(executable).toHaveLength(1);
      expect(sharedClaims.size).toBe(1);
    } finally {
      first.store.close();
      second.store.close();
    }
  });

  it("deletes its claim only after the issue branch head is proven", async () => {
    const harness = createHarness("auto-pr", roots);
    try {
      await harness.tick();
      await harness.tick();
      await expect(harness.tick()).resolves.toMatchObject({ state: "pr_open" });
      expect(harness.claimDeleteCount).toBe(1);
      expect(harness.claimDeleteBranchHeads).toEqual(["b".repeat(40)]);
      expect(harness.store.getActiveAttempt()?.claim?.status).toBe("released");
    } finally {
      harness.store.close();
    }
  });

  it("retains the claim when the pushed branch head cannot be proven", async () => {
    const harness = createHarness("auto-pr", roots, { pushHeadMismatch: true });
    try {
      await harness.tick();
      await harness.tick();
      await expect(harness.tick()).resolves.toMatchObject({ state: "in_doubt" });
      expect(harness.claimDeleteCount).toBe(0);
      expect(harness.store.getActiveAttempt()?.claim?.status).toBe("active");
    } finally {
      harness.store.close();
    }
  });

  it("marks uncertain claim deletion in doubt and retains the local lease", async () => {
    const harness = createHarness("auto-pr", roots, { claimDeleteFailure: true });
    try {
      await harness.tick();
      await harness.tick();
      await expect(harness.tick()).resolves.toMatchObject({ state: "in_doubt" });
      expect(harness.store.getActiveAttempt()?.claim?.status).toBe("in_doubt");
      expect(harness.claim).toBeDefined();
      expect(() =>
        harness.store.acquireLease({
          resource: "issue:github-7",
          owner: "racer",
          ttlMs: 1_000,
          now: 10_000,
        }),
      ).toThrow("held by another owner");
    } finally {
      harness.store.close();
    }
  });

  it("deletes its exact claim before cancelling and releasing the local lease", async () => {
    const harness = createHarness("auto-pr", roots);
    try {
      await harness.tick();
      await expect(
        harness.orchestrator.cancelActiveIssue("operator cancelled", new AbortController().signal),
      ).resolves.toMatchObject({ state: "cancelled" });
      expect(harness.claimDeleteCount).toBe(1);
      expect(harness.store.listAttempts()[0]).toMatchObject({
        state: "cancelled",
        claim: { status: "released" },
      });
      expect(() =>
        harness.store.acquireLease({
          resource: "issue:github-7",
          owner: "retry",
          ttlMs: 1_000,
          now: 10_000,
        }),
      ).not.toThrow();
    } finally {
      harness.store.close();
    }
  });

  it("reconciles a lost merge response from external pull state", async () => {
    const harness = createHarness("auto-merge", roots, { loseMergeResponse: true });
    try {
      await harness.tick();
      await harness.tick();
      await harness.tick();
      await harness.tick();
      expect((await harness.tick()).state).toBe("in_doubt");
      expect((await harness.tick()).state).toBe("post_merge");
      expect(
        harness.store.listOperations().find((operation) => operation.kind.includes("merge"))?.state,
      ).toBe("succeeded");
    } finally {
      harness.store.close();
    }
  });

  it("requires new diagnosis evidence before a code retry", async () => {
    const harness = createHarness("propose", roots, { workerFailures: 1 });
    try {
      await harness.tick();
      expect((await harness.tick()).state).toBe("waiting_evidence");
      expect((await harness.tick()).state).toBe("waiting_evidence");
      await expect(
        harness.orchestrator.retryAttempt(
          harness.store.getActiveAttempt()!.id,
          "",
          new AbortController().signal,
        ),
      ).rejects.toThrow("--evidence");
      await expect(
        harness.orchestrator.retryAttempt(
          harness.store.getActiveAttempt()!.id,
          "provider diagnosis confirms corrected credentials",
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({ state: "implementing" });
      expect((await harness.tick()).state).toBe("verifying");
      expect(harness.store.getActiveAttempt()?.detail).toMatchObject({
        failureEvidence: [
          expect.objectContaining({
            fingerprint: expect.any(String),
            evidenceDigest: expect.any(String),
          }),
        ],
      });
    } finally {
      harness.store.close();
    }
  });

  it("does not auto-resume first or second identical code failures", async () => {
    const harness = createHarness("propose", roots, { workerFailures: 2 });
    try {
      await harness.tick();
      expect((await harness.tick()).state).toBe("waiting_evidence");
      const attemptId = harness.store.getActiveAttempt()!.id;
      await harness.orchestrator.retryAttempt(
        attemptId,
        "first diagnosis",
        new AbortController().signal,
      );
      expect((await harness.tick()).state).toBe("waiting_evidence");
      expect((await harness.tick()).state).toBe("waiting_evidence");
      await expect(
        harness.orchestrator.retryAttempt(
          attemptId,
          "first diagnosis",
          new AbortController().signal,
        ),
      ).rejects.toThrow("already used");
      await expect(
        harness.orchestrator.retryAttempt(
          attemptId,
          "new maintainer diagnosis",
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({ state: "implementing" });
    } finally {
      harness.store.close();
    }
  });

  it("releases a recovery claim once a published branch is proven", async () => {
    const harness = createHarness("auto-pr", roots, { githubCheckFailures: 1 });
    try {
      await harness.tick();
      await harness.tick();
      await harness.tick();
      expect((await harness.tick()).state).toBe("waiting_evidence");
      const attemptId = harness.store.getActiveAttempt()!.id;
      await expect(
        harness.orchestrator.retryAttempt(
          attemptId,
          "CI diagnosis",
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({ state: "waiting_ci" });
      expect(harness.claimDeleteCount).toBe(2);
      expect((await harness.tick()).state).toBe("delivered");
      expect(harness.store.getAttempt(attemptId)?.claim?.status).toBe("released");
    } finally {
      harness.store.close();
    }
  });

  it("heartbeats coordinator and issue leases throughout a long worker", async () => {
    let finishWorker!: () => void;
    const holdWorker = new Promise<void>((resolve) => {
      finishWorker = resolve;
    });
    const harness = createHarness("propose", roots, {
      coordinatorTtlMs: 30,
      issueTtlMs: 30,
      holdWorker,
    });
    try {
      await harness.tick();
      const running = harness.tick();
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(() =>
        harness.store.acquireLease({
          resource: `coordinator:${harness.config.repoKey}`,
          owner: "racer",
          ttlMs: 30,
        }),
      ).toThrow("held by another owner");
      finishWorker();
      await expect(running).resolves.toMatchObject({ state: "verifying" });
    } finally {
      harness.store.close();
    }
  });

  it("rejects stale CI evidence before merge", async () => {
    const harness = createHarness("auto-merge", roots, { staleCheck: true });
    try {
      await harness.tick();
      await harness.tick();
      await harness.tick();
      expect((await harness.tick()).state).toBe("in_doubt");
      expect(harness.github.mergeCount).toBe(0);
    } finally {
      harness.store.close();
    }
  });

  it("rejects a pull-request head changed after exact-SHA CI", async () => {
    const harness = createHarness("auto-merge", roots, { changeHeadAfterChecks: true });
    try {
      await harness.tick();
      await harness.tick();
      await harness.tick();
      expect((await harness.tick()).state).toBe("merging");
      expect((await harness.tick()).state).toBe("in_doubt");
      expect(harness.github.mergeCount).toBe(0);
    } finally {
      harness.store.close();
    }
  });

  it("rejects normalized intake without the trusted execution marker", async () => {
    const harness = createHarness("auto-pr", roots, { omitExecutionMarker: true });
    try {
      expect(await harness.tick()).toMatchObject({ state: "idle" });
      expect(harness.store.getActiveAttempt()).toBeUndefined();
    } finally {
      harness.store.close();
    }
  });

  it("stages and promotes the exact merge release after ordered dogfood", async () => {
    const harness = createHarness("auto-merge", roots, { withRelease: true });
    try {
      await harness.runUntil("succeeded");
      expect(harness.sandboxRuns.slice(-4)).toEqual([
        "install",
        "build",
        "integration",
        "smoke",
      ]);
      expect(harness.releaseCalls).toEqual([
        `stage:${"c".repeat(40)}`,
        `canary:${"c".repeat(40)}`,
        `promote:${"c".repeat(40)}:1`,
      ]);
      expect(harness.store.listAttempts()[0]?.detail).toMatchObject({
        releaseEvidence: {
          commitSha: "c".repeat(40),
          manifestSha256: "d".repeat(64),
        },
      });
    } finally {
      harness.store.close();
    }
  });

  it("fails closed before cleanup and lease release when release staging fails", async () => {
    const harness = createHarness("auto-merge", roots, {
      withRelease: true,
      releaseFailure: true,
    });
    try {
      await harness.runUntil("blocked");
      expect(harness.git.removeCount).toBe(0);
      expect(() =>
        harness.store.acquireLease({
          resource: "issue:github-7",
          owner: "racer",
          ttlMs: 1_000,
          now: 10_000,
        }),
      ).toThrow("held by another owner");
      expect(harness.github.issueState).toBe("open");
    } finally {
      harness.store.close();
    }
  });

  it("promotes a normalized self-discovery issue and releases the original lease on dogfood failure", async () => {
    const harness = createHarness("auto-merge", roots, { dogfoodFailure: "smoke" });
    try {
      await harness.runUntil("blocked");
      expect(harness.intakeFindings).toHaveLength(1);
      expect(harness.intakeFindings[0]).toMatchObject({
        reproduction: expect.stringContaining("smoke"),
        minimalScenario: expect.stringContaining("Detached exact-merge worktree"),
        duplicateSearchEvidence: expect.stringContaining("Failure fingerprint"),
      });
      expect(harness.github.issueState).toBe("open");
      expect(() =>
        harness.store.acquireLease({
          resource: "issue:github-7",
          owner: "retry",
          ttlMs: 1_000,
        }),
      ).not.toThrow();
    } finally {
      harness.store.close();
    }
  });
});

interface HarnessOptions {
  changedPath?: string;
  losePullResponse?: boolean;
  loseMergeResponse?: boolean;
  staleCheck?: boolean;
  changeHeadAfterChecks?: boolean;
  workerFailures?: number;
  coordinatorTtlMs?: number;
  issueTtlMs?: number;
  holdWorker?: Promise<void>;
  omitExecutionMarker?: boolean;
  withRelease?: boolean;
  releaseFailure?: boolean;
  dogfoodFailure?: string;
  loseClaimResponse?: boolean;
  preexistingClaim?: boolean;
  pushHeadMismatch?: boolean;
  claimDeleteFailure?: boolean;
  sharedClaims?: Map<string, string>;
  claimReadBarrier?: () => Promise<void>;
  idPrefix?: string;
  claimPersistenceFailure?: boolean;
  foreignClaimOnRecovery?: boolean;
  githubCheckFailures?: number;
}

function createHarness(
  mode: AutonomyMode,
  roots: string[],
  options: HarnessOptions = {},
) {
  const home = makeTempDir("orchestrator-flow");
  roots.push(home);
  const loaded = loadAutonomyConfig(path.resolve(import.meta.dirname, "../.."), {
    env: { ONE_CLI_HOME: home },
  });
  const config = { ...loaded, mode };
  const baseSha = "a".repeat(40);
  const headSha = "b".repeat(40);
  const mergeSha = "c".repeat(40);
  let clock = 10_000;
  const realTime = options.coordinatorTtlMs !== undefined;
  const now = () => (realTime ? Date.now() : clock);
  const body = `${options.omitExecutionMarker ? "" : `${EXECUTION_MARKER}\n`}${config.issuePolicy.normalization.requiredFields
    .map(
      (field) =>
        `## ${field.replace(/[A-Z]/gu, (letter) => ` ${letter}`).replace(/^./u, (letter) => letter.toUpperCase())}\nvalue`,
    )
    .join("\n\n")}`;
  const issue: GitHubIssue = {
    number: 7,
    title: "Safe vertical change",
    body,
    state: "open",
    htmlUrl: "https://example.test/issues/7",
    user: { login: "beforeload" },
    labels: ["agent-ready", "source:self-discovery"],
  };
  const shared: {
    localHead: string;
    remoteHead: string | undefined;
    pull?: GitHubPullRequest;
    defaultHead: string;
  } = { localHead: baseSha, remoteHead: undefined, defaultHead: baseSha };
  let losePull = options.losePullResponse === true;
  let loseMerge = options.loseMergeResponse === true;
  let loseClaim = options.loseClaimResponse === true;
  let claim: { ref: string; sha: string } | undefined;
  let initialClaimRead = true;
  let preexistingClaimServed = false;
  let claimDeleteCount = 0;
  const claimDeleteBranchHeads: Array<string | undefined> = [];
  let checksFetched = false;
  let githubCheckFailures = options.githubCheckFailures ?? 0;
  let createPullCount = 0;
  let mergeCount = 0;
  const github = {
    get createPullCount() {
      return createPullCount;
    },
    get mergeCount() {
      return mergeCount;
    },
    get issueState() {
      return issue.state;
    },
    async listCandidateIssues() {
      return [issue];
    },
    async getIssue() {
      return { ...issue, labels: [...issue.labels] };
    },
    async findPullRequestByHead() {
      return shared.pull;
    },
    async getRef(_repository: unknown, ref: string) {
      if (initialClaimRead) {
        initialClaimRead = false;
        await options.claimReadBarrier?.();
      }
      if (options.preexistingClaim && !preexistingClaimServed && claim === undefined) {
        preexistingClaimServed = true;
        claim = { ref, sha: baseSha };
        options.sharedClaims?.set(ref, baseSha);
      }
      const sharedClaim = options.sharedClaims?.get(ref);
      if (sharedClaim !== undefined) return { ref, sha: sharedClaim };
      if (options.foreignClaimOnRecovery && claimDeleteCount > 0 && claim === undefined) {
        return { ref, sha: baseSha };
      }
      return claim?.ref === ref ? { ...claim } : undefined;
    },
    async createRef(_repository: unknown, ref: string, sha: string) {
      if (options.sharedClaims?.has(ref) || claim) throw new GitHubRefConflictError(ref);
      options.sharedClaims?.set(ref, sha);
      claim = { ref, sha };
      if (loseClaim) {
        loseClaim = false;
        throw new Error("network timed out after ref creation");
      }
      return { ref, sha };
    },
    async deleteRef(_repository: unknown, ref: string) {
      claimDeleteBranchHeads.push(shared.remoteHead);
      if (options.claimDeleteFailure) {
        throw new Error("network timed out during ref deletion");
      }
      options.sharedClaims?.delete(ref);
      if (claim?.ref !== ref) return;
      claimDeleteCount++;
      claim = undefined;
    },
    async createPullRequest() {
      createPullCount++;
      shared.pull = pullRequest(issue, headSha, baseSha);
      if (losePull) {
        losePull = false;
        throw new Error("network timed out after pull request creation");
      }
      return shared.pull;
    },
    async getPullRequest() {
      if (!shared.pull) throw new Error("pull missing");
      if (options.changeHeadAfterChecks && checksFetched) {
        shared.pull = { ...shared.pull, headSha: "e".repeat(40) };
      }
      return shared.pull;
    },
    async getChecksForCommit(_repository: unknown, exactHead: string) {
      checksFetched = true;
      const conclusion: GitHubCheck["conclusion"] =
        githubCheckFailures > 0 ? "failure" : "success";
      if (githubCheckFailures > 0) githubCheckFailures--;
      return [
        {
          id: 1,
          name: "verify",
          headSha: options.staleCheck ? "d".repeat(40) : exactHead,
          status: "completed",
          conclusion,
          detailsUrl: "https://example.test/checks/1",
        },
      ] satisfies GitHubCheck[];
    },
    async mergePullRequest() {
      mergeCount++;
      if (!shared.pull) throw new Error("pull missing");
      shared.pull = { ...shared.pull, merged: true, mergeSha };
      shared.defaultHead = mergeSha;
      if (loseMerge) {
        loseMerge = false;
        throw new Error("network timed out after merge");
      }
      return { merged: true, sha: mergeSha, message: "merged" };
    },
    async getRepositorySafety() {
      return {
        defaultBranch: "main",
        canPush: true,
        branchProtected: true,
        requiredCheckNames: ["verify"],
      };
    },
    async createComment() {
      return { id: 1, body: "delivered", htmlUrl: "https://example.test/comment/1" };
    },
    async updateIssue(
      _repository: unknown,
      _number: number,
      update: { state?: "open" | "closed"; labels?: readonly string[] },
    ) {
      if (update.state) issue.state = update.state;
      if (update.labels) issue.labels = [...update.labels];
      return issue;
    },
    async deleteBranch() {
      shared.remoteHead = undefined;
    },
  } as unknown as GitHubPort & {
    createPullCount: number;
    mergeCount: number;
    issueState: string;
  };

  let commitCount = 0;
  let pushCount = 0;
  let removeCount = 0;
  const git = {
    get commitCount() {
      return commitCount;
    },
    get pushCount() {
      return pushCount;
    },
    get removeCount() {
      return removeCount;
    },
    async ensureBare() {
      return { id: config.repoKey, barePath: path.join(home, "bare.git") };
    },
    async fetchBase() {
      return shared.defaultHead;
    },
    async remoteBranchExists() {
      return shared.remoteHead !== undefined;
    },
    async remoteBranchHead() {
      return shared.remoteHead;
    },
    async isAncestor(_repository: unknown, ancestor: string, descendant: string) {
      return ancestor === mergeSha && descendant === shared.defaultHead;
    },
    async createWorktree() {
      return {
        id: "issue-7",
        repositoryId: config.repoKey,
        path: path.join(home, "worktree"),
      };
    },
    async createDetachedWorktree() {
      return {
        id: "post-7",
        repositoryId: config.repoKey,
        path: path.join(home, "post-worktree"),
      };
    },
    async status() {
      return { clean: shared.localHead !== baseSha, porcelain: "" };
    },
    async stageAll() {},
    async diff() {
      const changedPath = options.changedPath ?? "src/feature.ts";
      return {
        patch: `diff --git a/${changedPath} b/${changedPath}\n--- a/${changedPath}\n+++ b/${changedPath}\n@@ -0,0 +1 @@\n+safe change\n`,
        nameStatus: [{ status: "M", path: changedPath }, { status: "M", path: "tests/feature.test.ts" }],
      };
    },
    async head() {
      return shared.localHead;
    },
    async commit() {
      commitCount++;
      shared.localHead = headSha;
      return headSha;
    },
    async push() {
      pushCount++;
      if (!options.pushHeadMismatch) shared.remoteHead = headSha;
    },
    async removeWorktree() {
      removeCount++;
    },
  } as unknown as OrchestratorGitPort & {
    commitCount: number;
    pushCount: number;
    removeCount: number;
  };

  const sandboxRuns: string[] = [];
  const sandboxFactory = () => ({
    availability: () => ({ available: true }),
    async run(name: string) {
      sandboxRuns.push(name);
      if (name === options.dogfoodFailure && shared.defaultHead === mergeSha) {
        return successfulProcess({ exitCode: 1, stderr: `${name} failed` });
      }
      return successfulProcess();
    },
  });
  const releaseCalls: string[] = [];
  const release = options.withRelease
    ? {
        async stage(input: {
          commitSha: string;
          worktreePath: string;
          binding: import("../../src/autonomy/release.js").ReleaseCandidateBinding;
        }) {
          releaseCalls.push(`stage:${input.commitSha}`);
          if (options.releaseFailure) throw new Error("release stage failed");
          return {
            commitSha: input.commitSha,
            releasePath: path.join(home, "release"),
            manifest: {
              version: 1 as const,
              commitSha: input.commitSha,
              totalBytes: 1,
              files: [],
              manifestSha256: "d".repeat(64),
            },
            binding: input.binding,
          };
        },
        markCanarySuccess(sha: string) {
          releaseCalls.push(`canary:${sha}`);
          return releaseStatus(sha);
        },
        promote(
          sha: string,
          minimum: number,
          _binding: import("../../src/autonomy/release.js").ReleaseCandidateBinding,
        ) {
          releaseCalls.push(`promote:${sha}:${minimum}`);
          return { ...releaseStatus(sha), active: sha, candidate: null };
        },
      }
    : undefined;
  const intakeFindings: Array<Record<string, unknown>> = [];
  const intake = {
    async promoteSelfDiscovery(input: { finding: unknown }) {
      intakeFindings.push(input.finding as Record<string, unknown>);
      return {
        created: true,
        executionIssueNumber: 99,
        idempotencyKey: "self",
        marker: "marker",
      };
    },
  };
  let workerFailures = options.workerFailures ?? 0;
  const worker = async () => {
    if (options.holdWorker) await options.holdWorker;
    if (workerFailures > 0) {
      workerFailures--;
      return {
        result: { ok: false, exitCode: 1 as const, reason: "provider_error" as const, rounds: 1 },
        sessionId: "failed-session",
        events: [],
      };
    }
    return {
      result: { ok: true, exitCode: 0 as const, reason: "completed" as const, rounds: 1 },
      sessionId: "session",
      events: [],
    };
  };
  const store = new AutonomyStore(path.join(home, "state.sqlite"));
  if (options.claimPersistenceFailure) {
    const updateAttempt = store.updateAttempt.bind(store);
    let fail = true;
    store.updateAttempt = ((input: Parameters<AutonomyStore["updateAttempt"]>[0]) => {
      if (fail && input.claim?.status === "active") {
        fail = false;
        throw new Error("injected claim persistence failure");
      }
      return updateAttempt(input);
    }) as AutonomyStore["updateAttempt"];
  }
  let id = 0;
  const orchestrator = new AutonomyOrchestrator({
    config,
    store,
    github,
    git,
    remoteUrl: "https://example.test/repo.git",
    sandboxFactory,
    reviewer: {
      review: async () => ({
        valid: true,
        criticalFindings: [],
        warnings: [],
        summary: "safe",
      }),
    },
    provider: {
      async *stream() {
        yield { type: "text_delta", delta: "unused" } as const;
      },
    },
    runConfig: {
      apiKey: "unused",
      baseUrl: "https://example.test/v1",
      model: "test",
      home,
      maxRounds: 1,
      maxToolCalls: 1,
      shellTimeoutMs: 1_000,
    },
    intake,
    ...(release === undefined ? {} : { release }),
    worker,
    now,
    id: () => `${options.idPrefix ?? "id"}-${++id}`,
    ...(options.coordinatorTtlMs === undefined
      ? {}
      : { coordinatorTtlMs: options.coordinatorTtlMs }),
    ...(options.issueTtlMs === undefined ? {} : { issueTtlMs: options.issueTtlMs }),
  });

  const harness = {
    config,
    store,
    github,
    git,
    sandboxRuns,
    releaseCalls,
    intakeFindings,
    orchestrator,
    get claimDeleteCount() {
      return claimDeleteCount;
    },
    claimDeleteBranchHeads,
    get claim() {
      return claim;
    },
    tick: () => orchestrator.tick(new AbortController().signal),
    advanceTime(milliseconds: number) {
      clock += milliseconds;
    },
    async runUntil(terminal: string) {
      const states: string[] = [];
      for (let index = 0; index < 12; index++) {
        const result = await this.tick();
        states.push(result.state);
        if (result.state === terminal) return states;
      }
      throw new Error(`Did not reach ${terminal}: ${states.join(" -> ")}`);
    },
  };
  return harness;
}

function pullRequest(issue: GitHubIssue, headSha: string, baseSha: string): GitHubPullRequest {
  return {
    ...issue,
    number: 17,
    headSha,
    headRef: "issue/7-safe-vertical-change",
    baseSha,
    baseRef: "main",
    draft: false,
    merged: false,
    mergeSha: null,
  };
}

function successfulProcess(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    durationMs: 1,
    timedOut: false,
    cancelled: false,
    outputLimitExceeded: false,
    ...overrides,
  };
}

function releaseStatus(candidate: string) {
  return {
    active: null,
    previous: null,
    candidate,
    health: { [candidate]: { successes: 1, failures: 0 } },
    generation: 1,
    candidateSuccesses: 1,
    candidateFailures: 0,
    activeFailures: 0,
    activeEarlyExitStreak: 0,
    candidateBinding: null,
  };
}

function approvePending(harness: ReturnType<typeof createHarness>): void {
  const attempt = harness.store.getActiveAttempt();
  if (!attempt) throw new Error("attempt missing");
  const detail = attempt.detail as Record<string, unknown>;
  const issue = harness.store.getIssue(attempt.issueId);
  harness.store.recordApproval({
    id: `approval-${harness.store.listApprovals().length + 1}`,
    binding: {
      issueId: attempt.issueId,
      action: String(detail.pendingApprovalAction),
      issueDigest: issue!.digest,
      policyHash: harness.config.policyHash,
      headSha: attempt.headSha,
      bindingRef: String(detail.pendingApprovalBindingRef),
    },
    decision: "approved",
    expiresAt: Date.now() + 60_000,
  });
}
