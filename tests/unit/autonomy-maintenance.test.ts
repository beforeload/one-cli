import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AutonomyConfig } from "../../src/autonomy/config.js";
import {
  collectLocalCapabilityEvidence,
  gapTaxonomyAuthority,
} from "../../src/autonomy/gap.js";
import type { GitHubIssue, GitHubPort } from "../../src/autonomy/github.js";
import { GitHubReadTransientError } from "../../src/autonomy/github-read.js";
import type { CommunitySource, ResearchPort } from "../../src/autonomy/intake.js";
import {
  IntakeWriteInDoubtError,
  type TrustedIntake,
} from "../../src/autonomy/intake.js";
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
    expect(harness.orchestrator.acquireNextIssue).toHaveBeenCalledTimes(1);
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

  it("prefers a ready issue over due global dogfood", async () => {
    const harness = createHarness();
    due(harness.store, "global-dogfood", harness.now());
    harness.orchestrator.acquireNextIssue.mockResolvedValue({
      action: "select",
      state: "issue_selected",
      detail: "selected agent-ready issue",
    });

    await expect(harness.coordinator.tick(signal())).resolves.toMatchObject({
      action: "select",
      state: "issue_selected",
    });
    expect(harness.sandbox.run).not.toHaveBeenCalled();
    expect(
      harness.store
        .listEvents({ aggregateType: "maintenance" })
        .map((event) => event.type),
    ).toContain("maintenance.ready-queue.preempt");
  });

  it("preserves failure evidence and creates a self-discovery issue", async () => {
    const harness = createHarness({ failCommand: "integration" });
    due(harness.store, "global-dogfood", harness.now());

    await expect(harness.coordinator.tick(signal())).resolves.toMatchObject({
      action: "global-dogfood",
      state: "blocked",
    });
    expect(harness.orchestrator.acquireNextIssue).toHaveBeenCalledTimes(1);
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
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    harness.orchestrator.reconcile.mockImplementation(
      async () => await new Promise<undefined>((resolve) => {
        release = () => resolve(undefined);
        markStarted();
      }),
    );
    const first = harness.coordinator.tick(signal());
    const settled = first.then(
      (result) => ({ status: "fulfilled" as const, result }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    try {
      await started;
      await expect(harness.coordinator.tick(signal())).resolves.toMatchObject({
        action: "none",
        state: "waiting",
      });
    } finally {
      release();
      const outcome = await settled;
      if (outcome.status === "rejected") throw outcome.error;
    }
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

  it("queues a scanned gap and promotes it only on the next tick", async () => {
    let harness!: ReturnType<typeof createHarness>;
    const source = communitySource("qwen-code", "https://github.com/QwenLM/qwen-code");
    const research = {
      scan: vi.fn(async () => {
        queueGap(harness.store, harness.config, source, "gap-one", 90);
        return [];
      }),
    };
    harness = createHarness({ sources: [source], research });
    due(harness.store, "community-scan", harness.now());

    await expect(harness.coordinator.tick(signal())).resolves.toMatchObject({
      action: "community-scan",
    });
    expect(harness.intake.promoteCommunityFinding).not.toHaveBeenCalled();
    expect(harness.store.getGapFinding("gap-one")?.status).toBe("eligible");

    await expect(harness.coordinator.tick(signal())).resolves.toMatchObject({
      action: "gap-promotion",
      state: "succeeded",
    });
    expect(harness.intake.promoteCommunityFinding).toHaveBeenCalledTimes(1);
    expect(harness.store.getGapFinding("gap-one")?.status).toBe("promoted");
  });

  it("terminally blocks a semantically inconsistent gap with durable evidence", async () => {
    const source = communitySource("qwen-code", "https://github.com/QwenLM/qwen-code");
    const harness = createHarness({ sources: [source] });
    queueGap(harness.store, harness.config, source, "gap-inconsistent", 90, {
      title: "Parallel agents",
      body: "Concurrent subagent worktrees improve delivery.",
    });

    await expect(harness.coordinator.tick(signal())).resolves.toMatchObject({
      action: "gap-promotion",
      state: "blocked",
    });
    expect(harness.findingNormalizer.normalize).not.toHaveBeenCalled();
    expect(harness.intake.promoteCommunityFinding).not.toHaveBeenCalled();
    expect(harness.store.getGapFinding("gap-inconsistent")).toMatchObject({
      status: "blocked",
      retryAfter: null,
      evidence: {
        promotion: {
          status: "blocked",
          reason: "observation does not support the candidate classification",
        },
      },
    });
  });

  it("returns the next tick to the ready queue after one gap promotion", async () => {
    const source = communitySource("qwen-code", "https://github.com/QwenLM/qwen-code");
    const harness = createHarness({ sources: [source] });
    queueGap(harness.store, harness.config, source, "gap-high", 95);
    queueGap(harness.store, harness.config, source, "gap-next", 90);

    await harness.coordinator.tick(signal());
    expect(harness.store.getGapFinding("gap-high")?.status).toBe("promoted");
    expect(harness.store.getGapFinding("gap-next")?.status).toBe("eligible");
    expect(harness.orchestrator.acquireNextIssue).not.toHaveBeenCalled();

    await harness.coordinator.tick(signal());
    expect(harness.orchestrator.acquireNextIssue).toHaveBeenCalledTimes(1);
    expect(harness.intake.promoteCommunityFinding).toHaveBeenCalledTimes(1);
    expect(harness.store.getGapFinding("gap-next")?.status).toBe("eligible");
  });

  it("marks an intake-reconciled existing execution issue as duplicate", async () => {
    const source = communitySource("qwen-code", "https://github.com/QwenLM/qwen-code");
    const harness = createHarness({ sources: [source], communityPromotionCreated: false });
    queueGap(harness.store, harness.config, source, "gap-duplicate", 90);

    await expect(harness.coordinator.tick(signal())).resolves.toMatchObject({
      action: "gap-promotion",
      state: "succeeded",
    });
    expect(harness.store.getGapFinding("gap-duplicate")?.status).toBe("duplicate");
  });

  it("overrides provider path claims with the trusted taxonomy binding", async () => {
    const source = communitySource("qwen-code", "https://github.com/QwenLM/qwen-code");
    const harness = createHarness({ sources: [source] });
    queueGap(harness.store, harness.config, source, "gap-path-binding", 90);
    harness.findingNormalizer.normalize.mockResolvedValue({
      ...normalizedFields(harness.config),
      scope: "Modify src/unrelated.ts.",
      acceptanceCriteria: "Only src/unrelated.ts needs to pass.",
    });

    await expect(harness.coordinator.tick(signal())).resolves.toMatchObject({
      action: "gap-promotion",
      state: "succeeded",
    });
    const promoted = harness.intake.promoteCommunityFinding.mock.calls[0]?.[0];
    expect(promoted?.normalizedFields.scope).toContain(
      '["src/workspace.ts","tests/unit/workspace.test.ts"]',
    );
    expect(promoted?.normalizedFields.acceptanceCriteria).toContain(
      '["src/workspace.ts","tests/unit/workspace.test.ts"]',
    );
    expect(JSON.stringify(promoted?.normalizedFields)).not.toContain("src/unrelated.ts");
    expect(harness.store.getGapFinding("gap-path-binding")?.evidence).toMatchObject({
      approvedPaths: ["src/workspace.ts", "tests/unit/workspace.test.ts"],
    });
  });

  it("scans every registered source and defers a partial scan", async () => {
    const sources = Array.from({ length: 9 }, (_, index) =>
      communitySource(
        `source-${index}`,
        `https://github.com/acme/source-${index}`,
      ),
    );
    const research = {
      scan: vi.fn(async (source: CommunitySource) => {
        if (String(source.id) === "source-3") throw new Error("private external prose");
        return [];
      }),
    };
    const harness = createHarness({ sources, research });
    due(harness.store, "community-scan", harness.now());

    await expect(harness.coordinator.tick(signal())).resolves.toMatchObject({
      action: "community-scan-pending",
      state: "waiting",
    });
    expect(research.scan.mock.calls.map(([source]) => source.id)).toEqual(
      sources.map((source) => source.id),
    );
    expect(new AutonomyScheduler(harness.store, harness.config).due(harness.now()).communityScan)
      .toBe(harness.now());
    expect(JSON.stringify(harness.store.listEvents())).not.toContain("private external prose");
  });

  it("defers a rate-limited scan without advancing due", async () => {
    const source = communitySource("qwen-code", "https://github.com/QwenLM/qwen-code");
    const research = {
      scan: vi.fn(async () => {
        throw new GitHubReadTransientError("rate limit exceeded", new Error("secret"));
      }),
    };
    const harness = createHarness({ sources: [source], research });
    due(harness.store, "community-scan", harness.now());

    await harness.coordinator.tick(signal());
    expect(new AutonomyScheduler(harness.store, harness.config).due(harness.now()).communityScan)
      .toBe(harness.now());
    expect(
      harness.store
        .listEvents({ aggregateType: "maintenance" })
        .find((event) => event.type === "maintenance.community-scan.partial")?.data,
    ).toMatchObject({ reason: "rate limited" });
  });

  it("preempts a continuously ready queue once when a scan exceeds maximum lateness", async () => {
    const source = communitySource("qwen-code", "https://github.com/QwenLM/qwen-code");
    const research = {
      scan: vi.fn(async () => {
        throw new GitHubReadTransientError("rate limit exceeded", new Error("transient"));
      }),
    };
    const harness = createHarness({ sources: [source], research, now: 10_000_000 });
    harness.orchestrator.acquireNextIssue.mockResolvedValue({
      action: "issue-selected",
      state: "issue_selected",
      detail: "selected continuously ready issue",
    });
    due(harness.store, "community-scan", harness.now() - 60 * 60_000 - 1);

    await expect(harness.coordinator.tick(signal())).resolves.toMatchObject({
      action: "community-scan-pending",
    });
    expect(harness.orchestrator.acquireNextIssue).not.toHaveBeenCalled();
    await expect(harness.coordinator.tick(signal())).resolves.toMatchObject({
      action: "issue-selected",
    });
    expect(harness.orchestrator.acquireNextIssue).toHaveBeenCalledTimes(1);
    await expect(harness.coordinator.tick(signal())).resolves.toMatchObject({
      action: "community-scan-pending",
    });
  });

  it("keeps provider failures retryable and uncertain writes in doubt", async () => {
    const source = communitySource("qwen-code", "https://github.com/QwenLM/qwen-code");
    const providerFailure = createHarness({
      sources: [source],
      findingNormalizerError: new Error("provider timeout"),
    });
    queueGap(providerFailure.store, providerFailure.config, source, "gap-retry", 90);
    await expect(providerFailure.coordinator.tick(signal())).resolves.toMatchObject({
      action: "gap-promotion",
      state: "waiting",
    });
    expect(providerFailure.store.getGapFinding("gap-retry")).toMatchObject({
      status: "retryable",
      retryCount: 1,
    });

    const uncertain = createHarness({
      sources: [source],
      communityPromotionError: new IntakeWriteInDoubtError(
        "intake-uncertain",
        "uncertain write",
      ),
    });
    queueGap(uncertain.store, uncertain.config, source, "gap-uncertain", 90);
    await expect(uncertain.coordinator.tick(signal())).resolves.toMatchObject({
      action: "gap-promotion",
      state: "in_doubt",
    });
    expect(uncertain.store.getGapFinding("gap-uncertain")).toMatchObject({
      status: "in_doubt",
      operationId: "intake-uncertain",
    });
  });

  it("roadmap-only selects roadmap work without promotion, scan, or global dogfood", async () => {
    const original = userIssue(9);
    const source = communitySource("qwen-code", "https://github.com/QwenLM/qwen-code");
    const research = { scan: vi.fn(async () => []) };
    const harness = createHarness({
      issues: [original],
      sources: [source],
      research,
      executionScope: "roadmap-only",
    });
    due(harness.store, "global-dogfood", harness.now());
    due(harness.store, "community-scan", harness.now());
    harness.orchestrator.acquireNextIssue.mockResolvedValue({
      action: "select",
      state: "issue_selected",
      detail: "selected roadmap attempt",
    });

    await expect(harness.coordinator.tick(signal())).resolves.toMatchObject({
      action: "select",
      state: "issue_selected",
    });
    expect(harness.orchestrator.acquireNextIssue).toHaveBeenCalledTimes(1);
    expect(harness.issueNormalizer.normalize).not.toHaveBeenCalled();
    expect(harness.intake.promoteUserIssue).not.toHaveBeenCalled();
    expect(harness.intake.promoteCommunityFinding).not.toHaveBeenCalled();
    expect(research.scan).not.toHaveBeenCalled();
    expect(harness.sandbox.run).not.toHaveBeenCalled();
  });

  it("fails closed without mutation for a legacy roadmap-only active attempt", async () => {
    const harness = createHarness({ executionScope: "roadmap-only" });
    harness.store.putRepo({ id: harness.config.repoKey, path: harness.config.repoRoot, now: 1 });
    harness.store.putIssue({
      id: "github-99",
      repoId: harness.config.repoKey,
      key: "99",
      digest: "d".repeat(64),
      now: 2,
    });
    harness.store.beginAttempt({
      id: "legacy",
      issueId: "github-99",
      headSha: "a".repeat(40),
      initialState: "pending",
      detail: { issueNumber: 99 },
      now: 3,
    });
    const beforeEvents = harness.store.listEvents({ limit: 10_000 }).length;
    await expect(harness.coordinator.tick(signal())).resolves.toMatchObject({
      action: "roadmap-scope",
      state: "blocked",
    });
    expect(harness.store.listEvents({ limit: 10_000 })).toHaveLength(beforeEvents);
    expect(harness.orchestrator.reconcile).not.toHaveBeenCalled();
    expect(harness.orchestrator.advanceActiveIssue).not.toHaveBeenCalled();
  });
});

function createHarness(options: {
  issues?: GitHubIssue[];
  failCommand?: string;
  mode?: AutonomyConfig["mode"];
  sources?: CommunitySource[];
  research?: ResearchPort;
  communityPromotionCreated?: boolean;
  findingNormalizerError?: Error;
  communityPromotionError?: Error;
  now?: number;
  executionScope?: "normal" | "roadmap-only";
} = {}) {
  const store = new AutonomyStore(":memory:");
  stores.push(store);
  const config = testConfig(options.mode ?? "auto-pr", options.sources ?? []);
  const now = () => options.now ?? 100_000;
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
    normalize: vi.fn(async () => {
      if (options.findingNormalizerError) throw options.findingNormalizerError;
      return normalizedFields(config);
    }),
  };
  const intake = {
    promoteUserIssue: vi.fn(async () => promotion(50)),
    promoteCommunityFinding: vi.fn(
      async (_input: Parameters<TrustedIntake["promoteCommunityFinding"]>[0]) => {
      if (options.communityPromotionError) throw options.communityPromotionError;
      return {
        ...promotion(51),
        created: options.communityPromotionCreated ?? true,
      };
      },
    ),
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
    ...(options.research === undefined ? {} : { research: options.research }),
    ...(options.executionScope === undefined
      ? {}
      : { executionScope: options.executionScope }),
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

function communitySource(id: string, repository: string): CommunitySource {
  return {
    id,
    name: id,
    trust: "official-primary",
    repository,
    releases: `${repository}/releases`,
    discussions: `${repository}/discussions`,
    documentation: { url: `${repository}/docs`, kind: "official-documentation" },
    topics: ["safety-platform-testing-docs"],
  } as CommunitySource;
}

function queueGap(
  store: AutonomyStore,
  config: AutonomyConfig,
  source: CommunitySource,
  fingerprint: string,
  score: number,
  observationText: {
    title: string;
    body: string;
  } = {
    title: "Windows platform compatibility",
    body: "Cross-platform support for Windows and macOS.",
  },
): void {
  const externalId = `${fingerprint}-commit`;
  const sourceUrl = `${source.repository}/commit/${"b".repeat(40)}`;
  const observation = store.upsertResearchObservation({
    id: `observation-${fingerprint}`,
    sourceId: source.id,
    kind: "repository",
    externalId,
    sourceUrl,
    sha: "b".repeat(40),
    evidence: { title: "Parallel agents" },
    observedAt: 100_000,
    now: 100_000,
  });
  const classification = {
    category: "safety-platform-testing-docs" as const,
    topic: "platform-compatibility" as const,
    subcode: "platform.compatibility" as const,
  };
  const localEvidence = collectLocalCapabilityEvidence(config.repoRoot, classification);
  const candidate = {
    observation: {
      sourceId: source.id,
      sourceUrl,
      kind: "repository" as const,
      externalId,
      sha: "b".repeat(40),
      title: observationText.title,
      body: observationText.body,
      observedAt: 100_000,
      incremental: true,
    },
    classification,
    externalEvidence: "Official incremental repository evidence.",
    localEvidence,
    confidence: "confirmed" as const,
    score,
    testable: true,
    dependencyStatus: "ready" as const,
    proposedPaths: [...gapTaxonomyAuthority(classification).proposedPaths],
    expiresAt: 100_000 + 30 * 24 * 60 * 60_000,
  };
  store.upsertGapFinding({
    fingerprint,
    sourceId: source.id,
    observationId: observation.id,
    category: classification.category,
    topic: classification.topic,
    subcode: classification.subcode,
    evidence: { candidate },
    score,
    confidence: "confirmed",
    status: "eligible",
    policyHash: config.policyHash,
    expiresAt: candidate.expiresAt,
    now: 100_000,
  });
}

function testConfig(
  mode: AutonomyConfig["mode"],
  sources: CommunitySource[] = [],
): AutonomyConfig {
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
    repoRoot: path.resolve(import.meta.dirname, "../.."),
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
    community: { sources },
    gapPolicy: {
      confidenceThreshold: "likely",
      minimumScore: 70,
      maximumPromotionsPerTick: 1,
      findingTtlDays: 30,
      protectedGovernancePaths: [
        "AUTONOMY.md",
        ".autonomy/**",
        ".github/workflows/**",
        ".github/CODEOWNERS",
      ],
    },
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
