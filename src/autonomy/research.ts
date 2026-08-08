import crypto from "node:crypto";
import type { AutonomyConfig } from "./config.js";
import type { JsonValue, ResearchCheckpoint, ResearchKind } from "./domain.js";
import {
  GapObservationSchema,
  classifyGapObservation,
  collectLocalCapabilityEvidence,
  evaluateDirectEligibility,
  findingExpiry,
  gapTaxonomyAuthority,
  scoreGap,
  stableGapFingerprint,
  type GapCandidate,
  type GapObservation,
} from "./gap.js";
import {
  sanitizeUntrustedText,
  type CommunityFinding,
  type CommunitySource,
  type ResearchPort,
} from "./intake.js";
import type {
  GitHubCommitDelta,
  GitHubDiscussionRead,
  GitHubReadBudget,
  GitHubReleaseRead,
  GitHubRepositoryState,
} from "./github-read.js";
import { GitHubReadClient } from "./github-read.js";
import type { AutonomyStore } from "./store.js";

export interface GitHubResearchPortOptions {
  store: AutonomyStore;
  github: GitHubReadClient;
  config: Pick<
    AutonomyConfig,
    "repoRoot" | "policyHash" | "researchPolicyHash" | "community" | "gapPolicy"
  >;
  now?: () => number;
  maxCandidatesPerScan?: number;
}

interface PendingObservation {
  observation: GapObservation;
  evidence: Record<string, string | number | boolean | readonly string[]>;
}

/**
 * Read-only GitHub research. Every external value is bounded and sanitized by
 * GitHubReadClient, then classified by the closed local gap taxonomy.
 */
export class GitHubResearchPort implements ResearchPort {
  private readonly now: () => number;
  private readonly maxCandidatesPerScan: number;

  constructor(private readonly options: GitHubResearchPortOptions) {
    this.now = options.now ?? Date.now;
    this.maxCandidatesPerScan = positiveInteger(
      options.maxCandidatesPerScan ?? options.config.gapPolicy.maximumPromotionsPerTick,
      "research candidate limit",
    );
  }

  async scan(source: CommunitySource, signal?: AbortSignal): Promise<readonly CommunityFinding[]> {
    this.assertRegisteredSource(source);
    throwIfAborted(signal);
    const budget = this.options.github.createBudget();
    const policyHash = this.options.config.researchPolicyHash;
    const state = await this.options.github.getRepositoryState(
      source.id,
      source.repository,
      budget,
      signal,
    );
    throwIfAborted(signal);
    const checkpoints = {
      repository: this.options.store.getResearchCheckpoint(source.id, "repository"),
      release: this.options.store.getResearchCheckpoint(source.id, "release"),
      discussion: this.options.store.getResearchCheckpoint(source.id, "discussion"),
    };
    const releaseStartPage = checkpoints.release?.boundaryId
      ? (checkpoints.release.page ?? 1)
      : 1;
    const releases = await this.options.github.listRecentReleases(
      source.id,
      state,
      source.releases,
      budget,
      signal,
      releaseStartPage,
    );
    throwIfAborted(signal);
    const discussionStartCursor = checkpoints.discussion?.boundaryId
      ? checkpoints.discussion.cursor
      : null;
    const discussions = await this.options.github.listRecentDiscussions(
      source.id,
      state,
      source.discussions,
      budget,
      signal,
      discussionStartCursor,
    );
    throwIfAborted(signal);
    if (Object.values(checkpoints).every((checkpoint) => checkpoint === undefined)) {
      this.recordBaseline(source, state, releases, discussions, policyHash);
      return [];
    }

    const pending: PendingObservation[] = [];
    const now = this.now();
    const checkpointUpdates: Array<{
      sourceId: string;
      kind: ResearchKind;
      policyHash: string;
      channelState: ResearchCheckpoint["channelState"];
      cursor?: string | null;
      page?: number | null;
      lastSha?: string | null;
      lastId?: string | null;
      lastAt?: number | null;
      boundarySha?: string | null;
      boundaryId?: string | null;
      boundaryAt?: number | null;
      now?: number;
    }> = [];

    const repositoryCheckpoint = checkpoints.repository;
    if (!repositoryCheckpoint) {
      checkpointUpdates.push({
        sourceId: source.id,
        kind: "repository",
        policyHash,
        channelState: "baselined",
        lastSha: state.sha,
        now,
      });
    } else if (
      repositoryCheckpoint.lastSha &&
      (repositoryCheckpoint.boundarySha || repositoryCheckpoint.lastSha !== state.sha)
    ) {
      const targetSha = repositoryCheckpoint.boundarySha ?? state.sha;
      const comparison = await this.options.github.compare(
        source.id,
        { ...state, sha: targetSha },
        repositoryCheckpoint.lastSha,
        budget,
        signal,
        repositoryCheckpoint.page ?? 1,
      );
      for (const commit of comparison.commits) {
        pending.push(this.commitObservation(source, commit, comparison.files, comparison.truncated));
      }
      const comparisonComplete =
        !comparison.truncated ||
        comparison.commits.some((commit) => commit.sha === targetSha);
      checkpointUpdates.push(
        !comparisonComplete
          ? {
              sourceId: source.id,
              kind: "repository",
              policyHash,
              channelState: "baselined",
              lastSha: repositoryCheckpoint.lastSha,
              boundarySha: targetSha,
              page: comparison.nextPage ?? (repositoryCheckpoint.page ?? 1) + 1,
              now,
            }
          : {
              sourceId: source.id,
              kind: "repository",
              policyHash,
              channelState: "baselined",
              lastSha: targetSha,
              now,
            },
      );
    } else {
      checkpointUpdates.push({
        sourceId: source.id,
        kind: "repository",
        policyHash,
        channelState: "baselined",
        lastSha: repositoryCheckpoint.lastSha ?? state.sha,
        now,
      });
    }
    throwIfAborted(signal);

    const releaseCheckpoint = checkpoints.release;
    if (!releaseCheckpoint) {
      checkpointUpdates.push({
        sourceId: source.id,
        kind: "release",
        policyHash,
        channelState: releases.available ? "baselined" : "unavailable",
        lastId: releases.available ? (releases.items[0]?.id ?? null) : null,
        now,
      });
    } else if (!releases.available) {
      checkpointUpdates.push(copyCheckpoint(releaseCheckpoint, policyHash, now));
    } else if (releaseCheckpoint.channelState === "unavailable") {
      checkpointUpdates.push({
        sourceId: source.id,
        kind: "release",
        policyHash,
        channelState: "baselined",
        lastId: releases.items[0]?.id ?? null,
        now,
      });
    } else {
      const boundaryId =
        releaseCheckpoint.boundaryId ?? releases.items[0]?.id ?? releaseCheckpoint.lastId;
      const unseen = itemsBeforeBoundary(releases.items, releaseCheckpoint.lastId);
      for (const release of unseen.items) {
        pending.push(this.releaseObservation(source, release, releases.truncated));
      }
      checkpointUpdates.push(
        unseen.reachedBoundary || !releases.truncated
          ? {
              sourceId: source.id,
              kind: "release",
              policyHash,
              channelState: "baselined",
              lastId: boundaryId,
              now,
            }
          : {
              sourceId: source.id,
              kind: "release",
              policyHash,
              channelState: "baselined",
              lastId: releaseCheckpoint.lastId,
              boundaryId,
              page: releases.nextPage ?? releaseStartPage + 1,
              now,
            },
      );
    }

    const discussionCheckpoint = checkpoints.discussion;
    if (!discussionCheckpoint) {
      checkpointUpdates.push({
        sourceId: source.id,
        kind: "discussion",
        policyHash,
        channelState: discussions.available ? "baselined" : "unavailable",
        lastAt: discussions.items[0]?.observedAt ?? 0,
        lastId: discussions.available ? (discussions.items[0]?.id ?? null) : null,
        now,
      });
    } else if (!discussions.available) {
      checkpointUpdates.push(copyCheckpoint(discussionCheckpoint, policyHash, now));
    } else if (discussionCheckpoint.channelState === "unavailable") {
      checkpointUpdates.push({
        sourceId: source.id,
        kind: "discussion",
        policyHash,
        channelState: "baselined",
        cursor: null,
        lastAt: discussions.items[0]?.observedAt ?? 0,
        lastId: discussions.items[0]?.id ?? null,
        now,
      });
    } else {
      const previousTime = discussionCheckpoint.boundaryId
        ? (discussionCheckpoint.lastAt ?? 0)
        : (discussionCheckpoint.lastAt ?? parseCursorTimestamp(discussionCheckpoint.cursor));
      const boundaryId =
        discussionCheckpoint.boundaryId ??
        discussions.items[0]?.id ??
        discussionCheckpoint.lastId;
      const boundaryAt =
        discussionCheckpoint.boundaryAt ??
        discussions.items[0]?.observedAt ??
        previousTime;
      let reachedBoundary = false;
      for (const discussion of discussions.items) {
        if (
          discussion.id === discussionCheckpoint.lastId &&
          discussion.observedAt <= previousTime
        ) {
          reachedBoundary = true;
          break;
        }
        if (discussion.observedAt < previousTime) {
          reachedBoundary = true;
          break;
        }
        pending.push(this.discussionObservation(source, discussion, discussions.truncated));
      }
      checkpointUpdates.push(
        reachedBoundary || !discussions.truncated
          ? {
              sourceId: source.id,
              kind: "discussion",
              policyHash,
              channelState: "baselined",
              cursor: null,
              lastId: boundaryId,
              lastAt: boundaryAt,
              now,
            }
          : {
              sourceId: source.id,
              kind: "discussion",
              policyHash,
              channelState: "baselined",
              cursor: discussions.nextCursor ?? discussionStartCursor,
              lastId: discussionCheckpoint.lastId,
              lastAt: previousTime,
              boundaryId,
              boundaryAt,
              now,
            },
      );
    }

    const findings: CommunityFinding[] = [];
    const emitted = new Set<string>();
    for (const pendingObservation of pending) {
      throwIfAborted(signal);
      const finding = this.persistAndEvaluate(source, pendingObservation);
      if (
        finding &&
        !emitted.has(finding.fingerprint) &&
        findings.length < this.maxCandidatesPerScan
      ) {
        emitted.add(finding.fingerprint);
        findings.push(finding.value);
      }
    }

    this.options.store.upsertResearchCheckpoints(checkpointUpdates);
    return findings;
  }

  private recordBaseline(
    source: CommunitySource,
    state: GitHubRepositoryState,
    releases: {
      available: boolean;
      items: readonly GitHubReleaseRead[];
    },
    discussions: {
      available: boolean;
      items: readonly GitHubDiscussionRead[];
    },
    policyHash: string,
  ): void {
    const now = this.now();
    this.options.store.upsertResearchCheckpoints([
      {
        sourceId: source.id,
        kind: "repository",
        policyHash,
        channelState: "baselined",
        lastSha: state.sha,
        now,
      },
      {
        sourceId: source.id,
        kind: "release",
        policyHash,
        channelState: releases.available ? "baselined" : "unavailable",
        lastId: releases.available ? (releases.items[0]?.id ?? null) : null,
        now,
      },
      {
        sourceId: source.id,
        kind: "discussion",
        policyHash,
        channelState: discussions.available ? "baselined" : "unavailable",
        lastAt: discussions.available ? (discussions.items[0]?.observedAt ?? 0) : 0,
        lastId: discussions.available ? (discussions.items[0]?.id ?? null) : null,
        now,
      },
    ]);
  }

  private commitObservation(
    source: CommunitySource,
    commit: GitHubCommitDelta,
    files: readonly string[],
    truncated: boolean,
  ): PendingObservation {
    const fallback = `Official repository commit ${commit.sha.slice(0, 12)}`;
    const message = requiredText(commit.message || fallback, fallback, 4_096);
    const title = requiredText(message.split("\n")[0] ?? "", fallback, 160);
    const pathEvidence =
      files.length === 0 ? "No changed path metadata returned." : `Changed paths: ${files.join(", ")}`;
    const body = requiredText(`${message}\n\n${pathEvidence}`, fallback, 4_096);
    return this.pendingObservation(
      {
        sourceId: source.id,
        sourceUrl: commit.sourceUrl,
        kind: "repository",
        externalId: commit.sha,
        sha: commit.sha,
        title,
        body,
        observedAt: commit.committedAt,
        incremental: true,
      },
      { title, body, files, truncated },
    );
  }

  private releaseObservation(
    source: CommunitySource,
    release: GitHubReleaseRead,
    truncated: boolean,
  ): PendingObservation {
    const fallback = `Official release ${release.tag || release.id}`;
    const title = requiredText(release.title, fallback, 160);
    const body = requiredText(release.body || title, title, 4_096);
    return this.pendingObservation(
      {
        sourceId: source.id,
        sourceUrl: release.sourceUrl,
        kind: "release",
        externalId: release.id,
        title,
        body,
        observedAt: release.publishedAt,
        incremental: true,
      },
      { title, body, tag: release.tag, truncated },
    );
  }

  private discussionObservation(
    source: CommunitySource,
    discussion: GitHubDiscussionRead,
    truncated: boolean,
  ): PendingObservation {
    const title = requiredText(
      discussion.title,
      `Official discussion #${discussion.number}`,
      160,
    );
    const body = requiredText(discussion.body || title, title, 4_096);
    const externalId = `${discussion.id}@${discussion.observedAt}`;
    return this.pendingObservation(
      {
        sourceId: source.id,
        sourceUrl: discussion.sourceUrl,
        kind: "discussion",
        externalId,
        title,
        body,
        observedAt: discussion.observedAt,
        incremental: true,
      },
      { title, body, discussionNumber: discussion.number, truncated },
    );
  }

  private pendingObservation(
    observation: GapObservation,
    evidence: PendingObservation["evidence"],
  ): PendingObservation {
    return { observation: GapObservationSchema.parse(observation), evidence };
  }

  private persistAndEvaluate(
    source: CommunitySource,
    pending: PendingObservation,
  ): { fingerprint: string; value: CommunityFinding } | undefined {
    const observationId = researchObservationId(
      source.id,
      pending.observation.kind,
      pending.observation.externalId,
    );
    if (
      !this.options.store.getResearchObservation(
        source.id,
        pending.observation.kind,
        pending.observation.externalId,
      )
    ) {
      this.options.store.upsertResearchObservation({
        id: observationId,
        sourceId: source.id,
        kind: pending.observation.kind,
        externalId: pending.observation.externalId,
        sourceUrl: pending.observation.sourceUrl,
        sha: pending.observation.sha ?? null,
        evidence: pending.evidence,
        observedAt: pending.observation.observedAt,
        now: this.now(),
      });
    }

    let classification: ReturnType<typeof classifyGapObservation>;
    try {
      classification = classifyGapObservation(pending.observation);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "Observation does not match the closed gap taxonomy"
      ) {
        return undefined;
      }
      throw error;
    }
    const localEvidence = collectLocalCapabilityEvidence(
      this.options.config.repoRoot,
      classification,
    );
    const authority = gapTaxonomyAuthority(classification);
    const localGapEvidence = ["absent", "partial"].includes(localEvidence.status);
    const confidence =
      pending.observation.kind !== "discussion" && localGapEvidence
        ? "confirmed"
        : "speculative";
    const score = scoreGap({
      incremental: true,
      allowlistedSource: source.topics.includes(classification.category),
      localEvidence,
      confidence,
      testable: authority.testable,
      dependencyReady: authority.dependencyStatus === "ready",
    });
    const candidate: GapCandidate = {
      observation: pending.observation,
      classification,
      externalEvidence: requiredText(
        `${pending.observation.title}\n${pending.observation.body}`,
        pending.observation.title,
        4_096,
      ),
      localEvidence,
      confidence,
      score,
      testable: authority.testable,
      dependencyStatus: authority.dependencyStatus,
      proposedPaths: [...authority.proposedPaths],
      expiresAt: findingExpiry(pending.observation.observedAt, this.options.config.gapPolicy),
    };
    const eligibility = evaluateDirectEligibility({
      candidate,
      registry: this.options.config.community,
      policy: this.options.config.gapPolicy,
      now: this.now(),
    });
    const fingerprint = stableGapFingerprint({
      sourceId: source.id,
      sourceUrl: pending.observation.sourceUrl,
      externalId: pending.observation.externalId,
      classification,
      need: pending.observation.body,
    });
    const existing = this.options.store.getGapFinding(fingerprint);
    if (!existing) {
      this.options.store.upsertGapFinding({
        fingerprint,
        sourceId: source.id,
        observationId,
        category: classification.category,
        topic: classification.topic,
        subcode: classification.subcode,
        evidence: toJson({
          candidate,
          eligibilityReasons: [...eligibility.reasons],
        }),
        score,
        confidence,
        status: eligibility.status,
        policyHash: this.options.config.policyHash,
        expiresAt: candidate.expiresAt,
        now: this.now(),
      });
    }
    if (existing || !eligibility.directEligible) return undefined;
    return {
      fingerprint,
      value: {
        sourceId: source.id,
        sourceUrl: pending.observation.sourceUrl,
        observedVersionOrDate:
          pending.observation.sha ??
          new Date(pending.observation.observedAt).toISOString(),
        title: pending.observation.title,
        originalCommunityNeed: pending.observation.body,
        productComparison: localEvidence.summary,
        duplicateSearchEvidence:
          `New incremental ${pending.observation.kind} evidence with stable id ` +
          `${pending.observation.externalId}; checkpoint, observation, and gap fingerprint were checked.`,
        approvedPaths: [...authority.proposedPaths],
        inScope: true,
        testableImprovement: authority.testable,
      },
    };
  }

  private assertRegisteredSource(source: CommunitySource): void {
    const registered = this.options.config.community.sources.find(
      (candidate) => candidate.id === source.id,
    );
    if (
      !registered ||
      registered.repository !== source.repository ||
      registered.releases !== source.releases ||
      registered.discussions !== source.discussions
    ) {
      throw new Error(`Research source ${source.id} is not the registered source`);
    }
  }
}

function itemsBeforeBoundary<T extends { id: string }>(
  items: readonly T[],
  previousId: string | null,
): { items: readonly T[]; reachedBoundary: boolean } {
  if (previousId === null) return { items, reachedBoundary: false };
  const index = items.findIndex((item) => item.id === previousId);
  return index < 0
    ? { items, reachedBoundary: false }
    : { items: items.slice(0, index), reachedBoundary: true };
}

function copyCheckpoint(
  checkpoint: ResearchCheckpoint,
  policyHash: string,
  now: number,
): {
  sourceId: string;
  kind: ResearchKind;
  policyHash: string;
  channelState: ResearchCheckpoint["channelState"];
  cursor: string | null;
  page: number | null;
  lastSha: string | null;
  lastId: string | null;
  lastAt: number | null;
  boundarySha: string | null;
  boundaryId: string | null;
  boundaryAt: number | null;
  now: number;
} {
  return {
    sourceId: checkpoint.sourceId,
    kind: checkpoint.kind,
    policyHash,
    channelState: checkpoint.channelState,
    cursor: checkpoint.cursor,
    page: checkpoint.page,
    lastSha: checkpoint.lastSha,
    lastId: checkpoint.lastId,
    lastAt: checkpoint.lastAt,
    boundarySha: checkpoint.boundarySha,
    boundaryId: checkpoint.boundaryId,
    boundaryAt: checkpoint.boundaryAt,
    now,
  };
}

function researchObservationId(sourceId: string, kind: ResearchKind, externalId: string): string {
  return `research-${crypto
    .createHash("sha256")
    .update(`${sourceId}\0${kind}\0${externalId}`)
    .digest("hex")
    .slice(0, 32)}`;
}

function parseCursorTimestamp(value: string | null): number {
  if (value === null) return 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function requiredText(value: string, fallback: string, maxLength: number): string {
  return sanitizeUntrustedText(value, maxLength) || fallback.slice(0, maxLength);
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be positive`);
  return value;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}

function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
