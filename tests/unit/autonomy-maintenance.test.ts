import { afterEach, describe, expect, it, vi } from "vitest";
import type { AutonomyConfig } from "../../src/autonomy/config.js";
import type { GitHubIssue, GitHubPort } from "../../src/autonomy/github.js";
import {
  MaintenanceCoordinator,
  type MaintenanceDependencies,
} from "../../src/autonomy/maintenance.js";
import type { TickResult } from "../../src/autonomy/orchestrator.js";
import type { ProcessResult } from "../../src/autonomy/process.js";
import {
  COMMUNITY_SCAN_INTERVAL_MS,
  GLOBAL_DOGFOOD_INTERVAL_MS,
  AutonomyScheduler,
} from "../../src/autonomy/schedule.js";
import { AutonomyStore } from "../../src/autonomy/store.js";

const stores: AutonomyStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  vi.restoreAllMocks();
});

describe("MaintenanceCoordinator", () => {
  it("reconciles before continuing an active issue", async () => {
    const harness = createHarness();
    addActiveAttempt(harness.store);
    harness.orchestrator.reconcile.mockResolvedValue({
      action: "reconcile",
      state: "post_merge",
      attemptId: "attempt-1",
    });

    await expect(harness.coordinator.tick(signal())).resolves.toMatchObject({
      action: "reconcile",
    });
    expect(harness.orchestrator.advanceActiveIssue).not.toHaveBeenCalled();
    expect(harness.github.listCandidateIssues).not.toHaveBeenCalled();
  });

  it("promotes one accepted user original and never executes it", async () => {
    const original = userIssue(9);
    const harness = createHarness({ issues: [original] });
    harness.issueNormalizer.normalize.mockResolvedValue({
      title: "Normalized child",
      normalizedFields: normalizedFields(harness.config),
    });

    await expect(harness.coordinator.tick(signal())).resolves.toMatchObject({
      action: "user-promotion",
      state: "succeeded",
    });
    expect(harness.issueNormalizer.normalize).toHaveBeenCalledTimes(1);
    expect(harness.intake.promoteUserIssue).toHaveBeenCalledWith(
      expect.objectContaining({ issueNumber: 9 }),
    );
    expect(harness.orchestrator.acquireNextIssue).not.toHaveBeenCalled();

    await harness.coordinator.tick(signal());
    expect(harness.issueNormalizer.normalize).toHaveBeenCalledTimes(1);
  });

  it("runs exact-SHA global dogfood and advances its due timestamp", async () => {
    const harness = createHarness();
    due(harness.store, "global-dogfood", harness.now());

    await expect(harness.coordinator.tick(signal())).resolves.toMatchObject({
      action: "global-dogfood",
      state: "succeeded",
    });
    expect(harness.git.createDetachedWorktree).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      "a".repeat(40),
      expect.any(AbortSignal),
    );
    expect(harness.sandbox.run.mock.calls.map(([name]) => name)).toEqual([
      "install",
      "build",
      "integration",
      "smoke",
    ]);
    expect(new AutonomyScheduler(harness.store, harness.config).due(harness.now()).globalDogfood)
      .toBe(harness.now() + GLOBAL_DOGFOOD_INTERVAL_MS);
  });

  it("preserves failure evidence and creates a self-discovery issue", async () => {
    const harness = createHarness({ failCommand: "integration" });
    due(harness.store, "global-dogfood", harness.now());

    await expect(harness.coordinator.tick(signal())).resolves.toMatchObject({
      action: "global-dogfood",
      state: "blocked",
    });
    expect(harness.intake.promoteSelfDiscovery).toHaveBeenCalledWith(
      expect.objectContaining({
        finding: expect.objectContaining({
          reproduction: expect.stringContaining("integration"),
          minimalScenario: expect.any(String),
          duplicateSearchEvidence: expect.stringContaining("fingerprint"),
        }),
      }),
    );
    expect(
      harness.store
        .listEvents({ aggregateType: "maintenance" })
        .map((event) => event.type),
    ).toContain("maintenance.global-dogfood.failed");
  });

  it("leaves a due community scan pending without ResearchPort", async () => {
    const harness = createHarness();
    due(harness.store, "community-scan", harness.now());

    await expect(harness.coordinator.tick(signal())).resolves.toMatchObject({
      action: "community-scan-pending",
      state: "pending",
    });
    expect(new AutonomyScheduler(harness.store, harness.config).due(harness.now()).communityScan)
      .toBe(harness.now());
  });

  it("prevents overlapping invocations", async () => {
    const harness = createHarness();
    addActiveAttempt(harness.store);
    let release!: () => void;
    harness.orchestrator.reconcile.mockImplementation(
      async () => await new Promise<undefined>((resolve) => {
        release = () => resolve(undefined);
      }),
    );
    const first = harness.coordinator.tick(signal());
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await expect(harness.coordinator.tick(signal())).resolves.toMatchObject({
      action: "none",
      state: "waiting",
    });
    release();
    await first;
  });

  it("keeps observe mode provider-free and mutation-free", async () => {
    const harness = createHarness({ mode: "observe" });
    await expect(harness.coordinator.tick(signal())).resolves.toMatchObject({
      action: "observe",
      state: "idle",
    });
    expect(harness.issueNormalizer.normalize).not.toHaveBeenCalled();
    expect(harness.sandbox.run).not.toHaveBeenCalled();
    expect(harness.store.listEvents({ aggregateType: "maintenance" })).toHaveLength(0);
  });
});

function createHarness(options: {
  issues?: GitHubIssue[];
  failCommand?: string;
  mode?: AutonomyConfig["mode"];
} = {}) {
  const store = new AutonomyStore(":memory:");
  stores.push(store);
  const config = testConfig(options.mode ?? "auto-pr");
  const now = () => 100_000;
  const github = {
    listCandidateIssues: vi.fn(async (_repository, labels: readonly string[]) =>
      labels.includes("source:user") ? options.issues ?? [] : []),
  } as unknown as GitHubPort & { listCandidateIssues: ReturnType<typeof vi.fn> };
  const orchestrator = {
    reconcile: vi.fn(async (): Promise<TickResult | undefined> => undefined),
    advanceActiveIssue: vi.fn(async () => ({
      action: "continue",
      state: "planning",
      attemptId: "attempt-1",
    })),
    acquireNextIssue: vi.fn(async () => ({
      action: "select",
      state: "idle",
      detail: "No eligible execution issue",
    })),
    observe: vi.fn(async () => ({
      action: "observe",
      state: "idle",
      detail: "Read-only inventory",
    })),
  };
  const issueNormalizer = {
    normalize: vi.fn(async () => ({
      title: "Normalized",
      normalizedFields: normalizedFields(config),
    })),
  };
  const findingNormalizer = {
    normalize: vi.fn(async () => normalizedFields(config)),
  };
  const intake = {
    promoteUserIssue: vi.fn(async () => promotion(50)),
    promoteCommunityFinding: vi.fn(async () => promotion(51)),
    promoteSelfDiscovery: vi.fn(async () => promotion(52)),
  };
  const git = {
    ensureBare: vi.fn(async () => ({ id: config.repoKey, barePath: "/bare" })),
    fetchBase: vi.fn(async () => "a".repeat(40)),
    createDetachedWorktree: vi.fn(async () => ({
      id: "dogfood",
      repositoryId: config.repoKey,
      path: "/worktree",
    })),
    removeWorktree: vi.fn(async () => undefined),
  };
  const sandbox = {
    availability: vi.fn(() => ({ available: true })),
    run: vi.fn(async (name: string) =>
      result(name === options.failCommand ? 1 : 0, name === options.failCommand ? "failed" : "")),
  };
  const dependencies = {
    config,
    store,
    github,
    git,
    remoteUrl: "https://example.test/acme/widget.git",
    sandboxFactory: () => sandbox,
    orchestrator,
    intake,
    issueNormalizer,
    findingNormalizer,
    now,
    id: (() => {
      let value = 0;
      return () => `id-${++value}`;
    })(),
  } satisfies MaintenanceDependencies;
  return {
    config,
    store,
    now,
    github,
    orchestrator,
    issueNormalizer,
    findingNormalizer,
    intake,
    git,
    sandbox,
    coordinator: new MaintenanceCoordinator(dependencies),
  };
}

function addActiveAttempt(store: AutonomyStore): void {
  store.putRepo({ id: "acme-widget", path: "/workspace" });
  store.putIssue({
    id: "github-1",
    repoId: "acme-widget",
    key: "1",
    digest: "digest",
    title: "Active",
  });
  const lease = store.acquireLease({
    resource: "issue:github-1",
    owner: "test",
    ttlMs: 1_000_000,
    now: 100_000,
  });
  store.beginAttempt({
    id: "attempt-1",
    issueId: "github-1",
    initialState: "planning",
    branch: "issue/1-active",
    baseSha: "a".repeat(40),
    headSha: "a".repeat(40),
    detail: {
      issueLease: {
        resource: lease.resource,
        owner: lease.owner,
        fence: lease.fence,
        expiresAt: lease.expiresAt,
      },
    },
    now: 100_000,
  });
}

function due(store: AutonomyStore, kind: "global-dogfood" | "community-scan", at: number): void {
  store.appendEvent({
    aggregateType: "autonomy-schedule",
    aggregateId: "acme-widget",
    type: `schedule.${kind}.due`,
    data: { dueAt: at },
    createdAt: at,
  });
}

function userIssue(number: number): GitHubIssue {
  return {
    number,
    title: "Accepted report",
    body: [
      "## Problem",
      "Visible failure",
      "## Minimal reproduction",
      "Trigger it",
      "## Expected behavior",
      "It succeeds",
    ].join("\n"),
    state: "open",
    htmlUrl: `https://example.test/issues/${number}`,
    user: { login: "reporter" },
    labels: ["source:user", "maintainer-accepted"],
  };
}

function testConfig(mode: AutonomyConfig["mode"]): AutonomyConfig {
  const requiredFields = [
    "sourceType",
    "sourceLinkOrEvidence",
    "problemStatement",
    "userValue",
    "scope",
    "nonGoals",
    "acceptanceCriteria",
    "testPlan",
    "dogfoodPlan",
    "riskAndSecurityNotes",
    "duplicateSearchEvidence",
    "parentChildRelationship",
    "dependencyOrder",
  ];
  return {
    repoRoot: "/workspace",
    repoKey: "acme-widget",
    stateRoot: "/state",
    policyHash: "policy",
    mode,
    product: {
      repository: {
        owner: "acme",
        name: "widget",
        defaultBranch: "main",
        mergeStrategy: "squash",
      },
    },
    issuePolicy: { normalization: { requiredFields } },
    community: { sources: [] },
    commands: Object.fromEntries(
      ["install", "build", "integration", "smoke"].map((name) => [
        name,
        { name, executable: "npm", args: [], network: name === "install" },
      ]),
    ),
  } as unknown as AutonomyConfig;
}

function normalizedFields(config: AutonomyConfig): Record<string, string> {
  return Object.fromEntries(
    config.issuePolicy.normalization.requiredFields.map((field) => [field, "normalized"]),
  );
}

function promotion(issueNumber: number) {
  return {
    created: true,
    executionIssueNumber: issueNumber,
    idempotencyKey: `promotion-${issueNumber}`,
    marker: `marker-${issueNumber}`,
  };
}

function result(exitCode: number, stderr: string): ProcessResult {
  return {
    exitCode,
    signal: null,
    stdout: "",
    stderr,
    durationMs: 1,
    timedOut: false,
    cancelled: false,
    outputLimitExceeded: false,
  };
}

function signal(): AbortSignal {
  return new AbortController().signal;
}
