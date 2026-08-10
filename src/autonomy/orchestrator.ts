import crypto, { randomUUID } from "node:crypto";
import path from "node:path";
import type { RunConfig } from "../config.js";
import type { ChatProvider } from "../domain.js";
import type { AutonomyConfig } from "./config.js";
import type { Attempt, IssueClaimEvidence, JsonValue, LeaseGrant } from "./domain.js";
import type {
  GitDiff,
  GitRepository,
  GitStatus,
  GitWorktree,
  PushOptions,
} from "./git.js";
import { issueClaimRef } from "./git.js";
import type {
  GitHubIssue,
  GitHubPort,
  GitHubPullRequest,
  GitHubRepositoryRef,
} from "./github.js";
import {
  GitHubRefConflictError,
  isExecutionEligible,
  normalizedIssueFields,
} from "./github.js";
import {
  COLD_START_ROADMAP_LABEL,
  COMMUNITY_SOURCE_LABEL,
  hasApprovedPathBindingMarker,
  isTrustedExecutionIssue,
  parseApprovedPathBinding,
  type TrustedIntake,
} from "./intake.js";
import { LeaseCoordinator, LeaseConflictError, LeaseLostError } from "./lease.js";
import type { ProcessResult } from "./process.js";
import type {
  ReleaseCandidateBinding,
  ReleaseManager,
  ReleaseStatus,
  StagedRelease,
} from "./release.js";
import { deterministicReview, independentReview, type ReviewerPort } from "./review.js";
import type { SandboxAvailability, SandboxPort } from "./sandbox.js";
import type { AutonomyStore } from "./store.js";
import { runAutonomyWorker, type WorkerResult } from "./worker.js";
import {
  createRoadmapScopeBinding,
  requireRoadmapScopeBinding,
  type ExpectedRoadmapBinding,
} from "./roadmap-enforcement.js";

const COORDINATOR_TTL_MS = 5 * 60_000;
const ISSUE_TTL_MS = 24 * 60 * 60_000;

export interface OrchestratorGitPort {
  ensureBare(id: string, remote: string, signal?: AbortSignal): Promise<GitRepository>;
  fetchBase(
    repository: GitRepository,
    remote: string,
    baseBranch: string,
    signal?: AbortSignal,
  ): Promise<string>;
  remoteBranchExists(
    repository: GitRepository,
    remote: string,
    branch: string,
    signal?: AbortSignal,
  ): Promise<boolean>;
  remoteBranchHead(
    repository: GitRepository,
    remote: string,
    branch: string,
    signal?: AbortSignal,
  ): Promise<string | undefined>;
  isAncestor(
    repository: GitRepository,
    ancestor: string,
    descendant: string,
    signal?: AbortSignal,
  ): Promise<boolean>;
  createWorktree(
    repository: GitRepository,
    id: string,
    options: { branch: string; startPoint: string; signal?: AbortSignal },
  ): Promise<GitWorktree>;
  createDetachedWorktree(
    repository: GitRepository,
    id: string,
    startPoint: string,
    signal?: AbortSignal,
  ): Promise<GitWorktree>;
  status(worktree: GitWorktree, signal?: AbortSignal): Promise<GitStatus>;
  stageAll(worktree: GitWorktree, signal?: AbortSignal): Promise<void>;
  diff(
    worktree: GitWorktree,
    options?: { staged?: boolean; baseRef?: string; maxBytes?: number; signal?: AbortSignal },
  ): Promise<GitDiff>;
  head(worktree: GitWorktree, signal?: AbortSignal): Promise<string>;
  commit(worktree: GitWorktree, message: string, signal?: AbortSignal): Promise<string>;
  push(worktree: GitWorktree, options: PushOptions): Promise<void>;
  removeWorktree(
    repository: GitRepository,
    worktree: GitWorktree,
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface OrchestratorDependencies {
  config: AutonomyConfig;
  store: AutonomyStore;
  github: GitHubPort;
  git: OrchestratorGitPort;
  remoteUrl: string;
  sandboxFactory(worktreePath: string): SandboxPort;
  reviewer: ReviewerPort;
  provider: ChatProvider;
  runConfig: RunConfig;
  intake?: Pick<TrustedIntake, "promoteSelfDiscovery">;
  release?: Pick<ReleaseManager, "stage" | "markCanarySuccess" | "promote">;
  worker?: typeof runAutonomyWorker;
  now?: () => number;
  id?: () => string;
  coordinatorTtlMs?: number;
  issueTtlMs?: number;
  executionScope?: "normal" | "roadmap-only";
  expectedRoadmapBinding?: ExpectedRoadmapBinding;
}

export interface TickResult {
  action: string;
  state: string;
  attemptId?: string;
  detail?: string;
}

export interface IssueClaimInspection {
  issueNumber: number;
  digest: string;
  claimRef: string;
  claimHeadSha: string | null;
  localAttemptId: string | null;
  localOwner: string | null;
  issueBranch: string;
  issueBranchHead: string | null;
  pullRequestNumber: number | null;
  removalEligible: boolean;
  approvalRequired: true;
  reason: string;
}

export class ProductDecisionRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProductDecisionRequiredError";
  }
}

export class TransientAutonomyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransientAutonomyError";
  }
}

export class AutonomyOrchestrator {
  private readonly now: () => number;
  private readonly id: () => string;
  private readonly leases: LeaseCoordinator;
  private readonly repositoryRef: GitHubRepositoryRef;

  constructor(private readonly dependencies: OrchestratorDependencies) {
    this.now = dependencies.now ?? Date.now;
    this.id = dependencies.id ?? randomUUID;
    this.leases = new LeaseCoordinator(dependencies.store, this.now);
    this.repositoryRef = {
      owner: dependencies.config.product.repository.owner,
      repo: dependencies.config.product.repository.name,
    };
  }

  async tick(signal: AbortSignal): Promise<TickResult> {
    const owner = `coordinator-${process.pid}-${this.id()}`;
    let coordinator: LeaseGrant;
    try {
      coordinator = this.leases.acquireCoordinator(
        this.dependencies.config.repoKey,
        owner,
        this.dependencies.coordinatorTtlMs ?? COORDINATOR_TTL_MS,
      );
    } catch (error) {
      if (error instanceof LeaseConflictError) return { action: "none", state: "waiting", detail: error.message };
      throw error;
    }

    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    let heartbeatFailure: unknown;
    const heartbeatMs = Math.max(
      10,
      Math.min(1_000, Math.floor((this.dependencies.coordinatorTtlMs ?? COORDINATOR_TTL_MS) / 3)),
    );
    const heartbeat = setInterval(() => {
      try {
        coordinator = this.leases.heartbeat(
          coordinator,
          this.dependencies.coordinatorTtlMs ?? COORDINATOR_TTL_MS,
        );
        const active = this.dependencies.store.getActiveAttempt();
        if (active) this.refreshIssueLease(active);
      } catch (error) {
        heartbeatFailure = error;
        controller.abort(error);
      }
    }, heartbeatMs);
    try {
      const active = await this.continueActiveIssue(controller.signal);
      const result = active ?? await this.acquireNextIssue(controller.signal);
      if (heartbeatFailure) throw heartbeatFailure;
      return result;
    } finally {
      clearInterval(heartbeat);
      signal.removeEventListener("abort", abort);
      this.leases.release(coordinator);
    }
  }

  async reconcile(signal: AbortSignal): Promise<TickResult | undefined> {
    const attempt = this.dependencies.store.getActiveAttempt();
    if (!attempt) return undefined;
    this.assertExecutionScope(attempt);
    let current = attempt;
    if (current.state === "pending") {
      return await this.acquireRemoteClaim(current, signal, true);
    }
    current = await this.reconcileClaimRelease(current, signal);
    if (current.state === "in_doubt") {
      const operations = this.dependencies.store.listOperations(current.id);
      const commit = operations.find(
        (operation) => operation.kind === "git.commit" && operation.state === "reserved",
      );
      if (commit && typeof detailObject(current).worktreePath === "string") {
        const worktree = this.worktree(current);
        const [head, status] = await Promise.all([
          this.dependencies.git.head(worktree, signal),
          this.dependencies.git.status(worktree, signal),
        ]);
        if (head !== current.baseSha && status.clean) {
          this.dependencies.store.reconcileOperation({
            idempotencyKey: commit.idempotencyKey,
            state: "succeeded",
            result: { headSha: head },
          });
          current = this.updateAttempt(current, { headSha: head });
        }
      }
      const push = operations.find(
        (operation) => operation.kind === "git.push" && operation.state === "reserved",
      );
      if (push && current.branch) {
        const repository = await this.repository(signal);
        const remoteHead = await this.dependencies.git.remoteBranchHead(
          repository,
          "origin",
          current.branch,
          signal,
        );
        if (remoteHead === current.headSha) {
          this.dependencies.store.reconcileOperation({
            idempotencyKey: push.idempotencyKey,
            state: "succeeded",
            result: { headSha: remoteHead },
          });
        }
      }
    }
    if (current.prNumber === null && current.branch) {
      const discovered = await this.dependencies.github.findPullRequestByHead(
        this.repositoryRef,
        current.branch,
        signal,
      );
      if (discovered && discovered.headSha === current.headSha) {
        current = this.updateAttempt(current, { prNumber: discovered.number });
        const operation = this.dependencies.store
          .listOperations(current.id)
          .find(
            (candidate) =>
              candidate.kind === "github.create-pull-request" &&
              candidate.state === "reserved",
          );
        if (operation) {
          this.dependencies.store.reconcileOperation({
            idempotencyKey: operation.idempotencyKey,
            state: "succeeded",
            result: jsonValue(discovered),
          });
        }
      }
    }
    if (current.prNumber === null) {
      const localWrites = this.dependencies.store
        .listOperations(current.id)
        .filter((operation) => operation.kind === "git.commit" || operation.kind === "git.push");
      if (
        current.state === "in_doubt" &&
        (current.claim === null || current.claim.status === "released") &&
        localWrites.length > 0 &&
        localWrites.every((operation) => operation.state === "succeeded")
      ) {
        this.safeTransition(current, "verifying", { reconciled: true });
        return { action: "reconcile", state: "verifying", attemptId: current.id };
      }
      return undefined;
    }
    const pull = await this.dependencies.github.getPullRequest(
      this.repositoryRef,
      current.prNumber,
      signal,
    );
    if (!pull.merged && pull.headSha !== current.headSha) {
      this.safeTransition(current, "in_doubt", {
        reason: "pull request head differs from durable expected head",
        observedHeadSha: pull.headSha,
      });
      return { action: "reconcile", state: "in_doubt", attemptId: current.id };
    }
    if (pull.merged && current.state !== "post_merge") {
      if (pull.mergeSha === null) {
        this.safeTransition(current, "in_doubt", { reason: "merged pull request has no merge SHA" });
        return { action: "reconcile", state: "in_doubt", attemptId: current.id };
      }
      current = this.updateAttempt(current, {
        detail: mergeDetail(current, { mergeSha: pull.mergeSha }),
      });
      const operation = this.dependencies.store
        .listOperations(current.id)
        .find(
          (candidate) =>
            candidate.kind === "github.merge-pull-request" &&
            candidate.state === "reserved",
        );
      if (operation) {
        this.dependencies.store.reconcileOperation({
          idempotencyKey: operation.idempotencyKey,
          state: "succeeded",
          result: { merged: true, sha: pull.mergeSha, message: "reconciled" },
        });
      }
      this.safeTransition(current, "post_merge", { reconciled: true });
      return { action: "reconcile", state: "post_merge", attemptId: current.id };
    }
    if (current.state === "in_doubt" && !pull.merged) {
      this.safeTransition(current, "pr_open", { reconciled: true });
      return { action: "reconcile", state: "pr_open", attemptId: current.id };
    }
    return undefined;
  }

  /**
   * Reconciles and advances one active attempt without acquiring the repository
   * coordinator lease. MaintenanceCoordinator owns that outer lease.
   */
  async continueActiveIssue(signal: AbortSignal): Promise<TickResult | undefined> {
    try {
      const reconciled = await this.reconcile(signal);
      if (reconciled) return reconciled;
      return await this.advanceActiveIssue(signal);
    } catch (error) {
      const handled = await this.handleBoundedError(error, signal);
      if (handled) return handled;
      throw error;
    }
  }

  /** Advances one active issue after the caller has reconciled it. */
  async advanceActiveIssue(signal: AbortSignal): Promise<TickResult | undefined> {
    const attempt = this.dependencies.store.getActiveAttempt();
    if (!attempt) return undefined;
    this.assertExecutionScope(attempt);
    this.refreshIssueLease(attempt);
    try {
      return await this.advance(
        this.dependencies.store.getAttempt(attempt.id) ?? attempt,
        signal,
      );
    } catch (error) {
      const handled = await this.handleBoundedError(error, signal);
      if (handled) return handled;
      throw error;
    }
  }

  /**
   * Acquires at most one existing trusted execution issue. The caller must own
   * the repository coordinator lease.
   */
  async acquireNextIssue(signal: AbortSignal): Promise<TickResult> {
    try {
      return await this.selectIssue(signal);
    } catch (error) {
      const handled = await this.handleBoundedError(error, signal);
      if (handled) return handled;
      throw error;
    }
  }

  /**
   * Read-only evidence for a future approval-gated stale-claim remover. This
   * deliberately never deletes a ref or infers staleness from elapsed time.
   */
  async inspectIssueClaim(
    issueNumberValue: number,
    digest: string,
    signal: AbortSignal,
  ): Promise<IssueClaimInspection> {
    const issue = await this.dependencies.github.getIssue(
      this.repositoryRef,
      issueNumberValue,
      signal,
    );
    const claimRef = issueClaimRef(issueNumberValue, digest);
    const branch = issueBranch(issue);
    const repository = await this.repository(signal);
    const [claim, branchHead, pull] = await Promise.all([
      this.dependencies.github.getRef(this.repositoryRef, claimRef, signal),
      this.dependencies.git.remoteBranchHead(repository, "origin", branch, signal),
      this.dependencies.github.findPullRequestByHead(this.repositoryRef, branch, signal),
    ]);
    const local = this.dependencies.store
      .listAttempts(`github-${issueNumberValue}`)
      .find(
        (attempt) =>
          attempt.claim?.ref === claimRef &&
          attempt.claim.digest === digest &&
          attempt.claim.headSha === claim?.sha,
      );
    const noPublicationEvidence = branchHead === undefined && pull === undefined;
    const removalEligible = claim !== undefined && local === undefined && noPublicationEvidence;
    return {
      issueNumber: issueNumberValue,
      digest,
      claimRef,
      claimHeadSha: claim?.sha ?? null,
      localAttemptId: local?.id ?? null,
      localOwner: local?.claim?.owner ?? null,
      issueBranch: branch,
      issueBranchHead: branchHead ?? null,
      pullRequestNumber: pull?.number ?? null,
      removalEligible,
      approvalRequired: true,
      reason:
        claim === undefined
          ? "claim ref does not exist"
          : local !== undefined
            ? "claim is exactly bound to durable local attempt evidence"
            : noPublicationEvidence
              ? "unknown claim has no issue branch or pull request; explicit approval is still required"
              : "issue branch or pull request is global exclusion evidence",
    };
  }

  async cancelActiveIssue(reason: string, signal: AbortSignal): Promise<TickResult | undefined> {
    if (!reason.trim()) throw new Error("Cancellation reason must not be empty");
    let attempt = this.dependencies.store.getActiveAttempt();
    if (!attempt) return undefined;
    if (attempt.state === "pending") {
      const claimResult = await this.acquireRemoteClaim(attempt, signal, true);
      if (claimResult.state === "in_doubt") return claimResult;
      attempt = this.dependencies.store.getActiveAttempt();
      if (!attempt) return claimResult;
    }
    const released = await this.releaseClaimBeforeTerminal(
      attempt,
      signal,
      "attempt-cancelled",
    );
    if (!released) return { action: "cancel", state: "in_doubt", attemptId: attempt.id };
    const cancelled = this.safeTransition(released, "cancelled", { reason });
    this.releaseIssueLease(cancelled);
    return { action: "cancel", state: "cancelled", attemptId: cancelled.id };
  }

  async retryAttempt(
    attemptId: string,
    evidence: string,
    signal: AbortSignal,
  ): Promise<TickResult> {
    return await this.withCoordinatorLease(async () => {
      let attempt = this.requiredAttempt(attemptId);
      if (
        attempt.state !== "waiting" &&
        attempt.state !== "waiting_evidence" &&
        attempt.state !== "blocked"
      ) {
        throw new Error("Only waiting, waiting_evidence, or blocked attempts can be retried");
      }
      const lastFailure = asRecord(detailObject(attempt).lastFailure);
      const fingerprint =
        typeof lastFailure.fingerprint === "string" ? lastFailure.fingerprint : undefined;
      let boundedEvidence = evidence.trim().replace(/\s+/gu, " ").slice(0, 4_096);
      if (fingerprint && !boundedEvidence) {
        const localIssue = this.dependencies.store.getIssue(attempt.issueId);
        const remoteIssue = await this.dependencies.github.getIssue(
          this.repositoryRef,
          issueNumber(attempt),
          signal,
        );
        const revisedDigest = issueDigest(remoteIssue);
        if (localIssue && revisedDigest !== localIssue.digest) {
          const released = await this.releaseClaimBeforeTerminal(
            attempt,
            signal,
            "maintainer-revision",
          );
          if (!released) {
            return { action: "retry", state: "in_doubt", attemptId: attempt.id };
          }
          this.dependencies.store.putIssue({
            id: localIssue.id,
            repoId: localIssue.repoId,
            key: localIssue.key,
            digest: revisedDigest,
            title: remoteIssue.title,
            ...(localIssue.detail === null ? {} : { detail: localIssue.detail }),
            now: this.now(),
          });
          attempt = released;
          boundedEvidence = `maintainer revision changed issue digest ${localIssue.digest} to ${revisedDigest}`;
        }
      }
      if (fingerprint && !boundedEvidence) {
        throw new Error("Code-failure retry requires new --evidence");
      }
      const priorEvidence = Array.isArray(detailObject(attempt).failureEvidence)
        ? [...(detailObject(attempt).failureEvidence as readonly JsonValue[])]
        : [];
      if (fingerprint) {
        const evidenceDigest = crypto
          .createHash("sha256")
          .update(`${fingerprint}\0${boundedEvidence}`)
          .digest("hex");
        if (
          priorEvidence.some(
            (item) => asRecord(item).evidenceDigest === evidenceDigest,
          )
        ) {
          throw new Error("Retry evidence was already used for this failure fingerprint");
        }
        priorEvidence.push({
          fingerprint,
          evidence: boundedEvidence,
          evidenceDigest,
          recordedAt: this.now(),
        });
      }
      attempt = await this.reacquireClaimForRecovery(
        attempt,
        signal,
        priorEvidence,
      );
      if (attempt.state === "in_doubt") {
        return { action: "retry", state: "in_doubt", attemptId: attempt.id };
      }
      if (attempt.branch) {
        const repository = await this.repository(signal);
        const publishedHead = await this.dependencies.git.remoteBranchHead(
          repository,
          "origin",
          attempt.branch,
          signal,
        );
        if (publishedHead === attempt.headSha) {
          const released = await this.releaseClaimBeforeTerminal(
            attempt,
            signal,
            "recovery-publication-proven",
          );
          if (!released) {
            return { action: "retry", state: "in_doubt", attemptId: attempt.id };
          }
          attempt = released;
        }
      }
      const resume = detailObject(attempt).resumeState;
      const target =
        typeof resume === "string" &&
        [
          "planning",
          "implementing",
          "verifying",
          "pr_open",
          "waiting_ci",
          "merging",
          "post_merge",
        ].includes(resume)
          ? (resume as Attempt["state"])
          : "planning";
      const retried = this.safeTransition(attempt, target, {
        manualRetry: true,
        evidenceRecorded: Boolean(fingerprint),
      });
      return { action: "retry", state: retried.state, attemptId: retried.id };
    });
  }

  async cancelAttempt(
    attemptId: string,
    reason: string,
    signal: AbortSignal,
  ): Promise<TickResult> {
    return await this.withCoordinatorLease(async () => {
      const attempt = this.ensureRecoveryLease(this.requiredAttempt(attemptId));
      if (["succeeded", "failed", "cancelled", "delivered"].includes(attempt.state)) {
        throw new Error("Attempt is already terminal");
      }
      const released = await this.releaseClaimBeforeTerminal(attempt, signal, "attempt-cancelled");
      if (!released) return { action: "cancel", state: "in_doubt", attemptId };
      const cancelled = this.safeTransition(released, "cancelled", { reason, manual: true });
      this.releaseIssueLease(cancelled);
      return { action: "cancel", state: "cancelled", attemptId };
    });
  }

  async resolveAttemptInDoubt(
    attemptId: string,
    target: "failed" | "cancelled",
    signal: AbortSignal,
  ): Promise<TickResult> {
    return await this.withCoordinatorLease(async () => {
      const attempt = this.ensureRecoveryLease(this.requiredAttempt(attemptId));
      if (attempt.state !== "in_doubt") throw new Error("Attempt is not in_doubt");
      const released = await this.releaseClaimBeforeTerminal(
        attempt,
        signal,
        `attempt-manually-${target}`,
      );
      if (!released) return { action: "resolve-in-doubt", state: "in_doubt", attemptId };
      const terminal = this.safeTransition(released, target, { manuallyResolved: true });
      this.releaseIssueLease(terminal);
      return { action: "resolve-in-doubt", state: terminal.state, attemptId };
    });
  }

  /** Read-only inventory used by observe mode. */
  async observe(signal: AbortSignal): Promise<TickResult> {
    const candidates = await this.dependencies.github.listCandidateIssues(
      this.repositoryRef,
      this.candidateLabels(),
      signal,
    );
    return {
      action: "observe",
      state: "idle",
      detail: `Inventoried ${candidates.length} agent-ready issue(s); no repository code was executed`,
    };
  }

  private async selectIssue(signal: AbortSignal): Promise<TickResult> {
    if (this.dependencies.config.mode === "observe") {
      return await this.observe(signal);
    }
    const repository = await this.repository(signal);
    const baseSha = await this.dependencies.git.fetchBase(
      repository,
      "origin",
      this.dependencies.config.product.repository.defaultBranch,
      signal,
    );
    const candidates = await this.dependencies.github.listCandidateIssues(
      this.repositoryRef,
      this.candidateLabels(),
      signal,
    );
    for (const issue of [...candidates].sort((a, b) => a.number - b.number)) {
      if (
        issue.labels.includes("parent") ||
        (this.dependencies.executionScope === "roadmap-only" &&
          !issue.labels.includes(COLD_START_ROADMAP_LABEL))
      ) {
        continue;
      }
      const branch = issueBranch(issue);
      const issueFields = normalizedIssueFields(
        issue,
        this.dependencies.config.issuePolicy.normalization.requiredFields,
      );
      const communityBound = issue.labels.includes(COMMUNITY_SOURCE_LABEL);
      const coldStartBound = issue.labels.includes(COLD_START_ROADMAP_LABEL);
      const hasPathMarker = issueFields ? hasApprovedPathBindingMarker(issueFields) : false;
      const approvedPaths = issueFields && hasPathMarker
        ? parseApprovedPathBinding(issueFields)
        : undefined;
      const [branchExists, pull] = await Promise.all([
        this.dependencies.git.remoteBranchExists(repository, "origin", branch, signal),
        this.dependencies.github.findPullRequestByHead(this.repositoryRef, branch, signal),
      ]);
      if (
        !isTrustedExecutionIssue(
          issue,
          this.dependencies.config.issuePolicy.authorization.apiAuthorExactMatch,
        ) ||
        issueFields === undefined ||
        ((communityBound || coldStartBound || hasPathMarker) && approvedPaths === undefined) ||
        !isExecutionEligible({
          issue,
          exactAuthor: this.dependencies.config.issuePolicy.authorization.apiAuthorExactMatch,
          requiredFields: this.dependencies.config.issuePolicy.normalization.requiredFields,
          branchExists,
          pullRequestExists: pull !== undefined,
        })
      ) {
        continue;
      }
      const digest = issueDigest(issue);
      const roadmapScopeBinding = coldStartBound
        ? createRoadmapScopeBinding({
            issue,
            issueDigest: digest,
            fields: issueFields,
            approvedPaths: approvedPaths ?? [],
            expected: this.expectedRoadmapBinding(),
          })
        : undefined;
      const issueId = `github-${issue.number}`;
      const claimRef = issueClaimRef(issue.number, digest);
      this.dependencies.store.putRepo({
        id: this.dependencies.config.repoKey,
        path: this.dependencies.config.repoRoot,
      });
      this.dependencies.store.putIssue({
        id: issueId,
        repoId: this.dependencies.config.repoKey,
        key: String(issue.number),
        digest,
        title: issue.title,
        detail: { url: issue.htmlUrl, labels: issue.labels },
      });
      const existingClaim = await this.dependencies.github.getRef(
        this.repositoryRef,
        claimRef,
        signal,
      );
      if (existingClaim) {
        this.dependencies.store.appendEvent({
          aggregateType: "issue",
          aggregateId: issueId,
          type: "issue-claim.acquisition-blocked",
          data: {
            claimRef,
            claimHeadSha: existingClaim.sha,
            digest,
            reason: "pre-existing GitHub claim is not bound to this host's durable attempt",
            autoDelete: false,
          },
          createdAt: this.now(),
        });
        continue;
      }
      const attemptId = this.id();
      const issueOwner = `issue-${process.pid}-${attemptId}-${this.id()}`;
      const issueLease = this.leases.acquireIssue(
        issueId,
        issueOwner,
        this.dependencies.issueTtlMs ?? ISSUE_TTL_MS,
      );
      const pending = this.dependencies.store.beginAttempt({
        id: attemptId,
        issueId,
        initialState: "pending",
        branch,
        baseSha,
        headSha: baseSha,
        detail: {
          issueNumber: issue.number,
          issueLease: leaseJson(issueLease),
          claimRequest: {
            ref: claimRef,
            headSha: baseSha,
            digest,
            owner: issueOwner,
          },
          issueFields,
          ...(approvedPaths === undefined ? {} : { approvedPaths: [...approvedPaths] }),
          ...(roadmapScopeBinding === undefined
            ? {}
            : { roadmapScopeBinding: jsonValue(roadmapScopeBinding) }),
        },
      });
      return await this.acquireRemoteClaim(pending, signal, false);
    }
    return { action: "select", state: "idle", detail: "No eligible execution issue" };
  }

  private async acquireRemoteClaim(
    attempt: Attempt,
    signal: AbortSignal,
    resume: boolean,
  ): Promise<TickResult> {
    const request = requestedClaim(attempt);
    if (attempt.claim?.status === "active") {
      const operation = this.dependencies.store
        .listOperations(attempt.id)
        .find((candidate) => candidate.kind === "github.create-issue-claim");
      if (operation?.state === "reserved") {
        this.dependencies.store.reconcileOperation({
          idempotencyKey: operation.idempotencyKey,
          state: "succeeded",
          result: { ref: attempt.claim.ref, sha: attempt.claim.headSha },
          now: this.now(),
        });
      }
      const selected = this.safeTransition(attempt, "issue_selected", {
        claim: claimJson(attempt.claim),
        reconciled: true,
      });
      return { action: "select", state: selected.state, attemptId: selected.id };
    }
    const idempotencyKey = `claim-create:${request.ref}:${request.owner}`;
    const reservation = this.dependencies.store.reserveOperation({
      id: this.id(),
      idempotencyKey,
      kind: "github.create-issue-claim",
      request: claimJson({ ...request, status: "active" }),
      issueId: attempt.issueId,
      attemptId: attempt.id,
      now: this.now(),
    });

    let observed: { ref: string; sha: string } | undefined;
    if (resume && !reservation.created) {
      const existing = await this.dependencies.github.getRef(
        this.repositoryRef,
        request.ref,
        signal,
      );
      if (existing?.sha === request.headSha) observed = existing;
      else if (existing) {
        this.safeTransition(attempt, "in_doubt", {
          operation: "resume-issue-claim",
          expectedHeadSha: request.headSha,
          observedHeadSha: existing.sha,
        });
        return { action: "claim", state: "in_doubt", attemptId: attempt.id };
      }
    }
    try {
      observed ??= await this.dependencies.github.createRef(
        this.repositoryRef,
        request.ref,
        request.headSha,
        signal,
      );
    } catch (error) {
      if (error instanceof GitHubRefConflictError) {
        const existing = await this.dependencies.github.getRef(
          this.repositoryRef,
          request.ref,
          signal,
        );
        this.dependencies.store.reconcileOperation({
          idempotencyKey,
          state: "failed",
          error: `claim conflict${existing ? ` at ${existing.sha}` : ""}`,
          now: this.now(),
        });
        return await this.blockAttempt(
          attempt,
          "claim",
          {
            reason: "GitHub issue claim is owned by another or stale attempt",
            claimRef: request.ref,
            expectedHeadSha: request.headSha,
            observedHeadSha: existing?.sha ?? null,
            autoDelete: false,
          },
          signal,
        );
      }
      // A transport can lose the successful create response. Exact ref/head
      // reconciliation is permitted only for this already-durable pending attempt.
      try {
        const existing = await this.dependencies.github.getRef(
          this.repositoryRef,
          request.ref,
          signal,
        );
        if (!existing || existing.sha !== request.headSha) {
          this.safeTransition(attempt, "in_doubt", {
            operation: "create-issue-claim",
            error: errorMessage(error),
            observedHeadSha: existing?.sha ?? null,
          });
          return { action: "claim", state: "in_doubt", attemptId: attempt.id };
        }
        observed = existing;
      } catch (reconcileError) {
        this.safeTransition(attempt, "in_doubt", {
          operation: "create-issue-claim",
          error: errorMessage(error),
          reconcileError: errorMessage(reconcileError),
        });
        return { action: "claim", state: "in_doubt", attemptId: attempt.id };
      }
    }

    const claim: IssueClaimEvidence = {
      ref: observed.ref,
      headSha: observed.sha,
      digest: request.digest,
      owner: request.owner,
      status: "active",
    };
    try {
      let current = this.updateAttempt(attempt, {
        claim,
        detail: mergeDetail(attempt, { claim: claimJson(claim) }),
      });
      this.dependencies.store.reconcileOperation({
        idempotencyKey,
        state: "succeeded",
        result: { ref: claim.ref, sha: claim.headSha, owner: claim.owner },
        now: this.now(),
      });
      current = this.transitionAttempt(current, "issue_selected", {
        claim: claimJson(claim),
      });
      return { action: "select", state: "issue_selected", attemptId: current.id };
    } catch (persistenceError) {
      let cleanup: "deleted" | "uncertain" = "uncertain";
      try {
        await this.dependencies.github.deleteRef(this.repositoryRef, request.ref, signal);
        cleanup = "deleted";
      } catch {
        // The durable pending request and local lease are retained for manual reconciliation.
      }
      try {
        const durable = this.dependencies.store.getAttempt(attempt.id) ?? attempt;
        if (durable.claim) {
          this.dependencies.store.updateAttempt({
            attemptId: durable.id,
            claim: {
              ...durable.claim,
              status: cleanup === "deleted" ? "released" : "in_doubt",
            },
            lease: this.issueLease(durable),
            now: this.now(),
          });
        }
        this.dependencies.store.transitionAttempt({
          attemptId: durable.id,
          to: "in_doubt",
          data: {
            operation: "persist-issue-claim",
            error: errorMessage(persistenceError),
            cleanup,
            claimRequest: claimJson({ ...request, status: "in_doubt" }),
          },
          lease: this.issueLease(durable),
          now: this.now(),
        });
      } catch {
        // The pending attempt itself is durable fail-closed and remains non-executable.
      }
      return {
        action: "claim",
        state: "in_doubt",
        attemptId: attempt.id,
        detail: `Claim persistence failed; remote cleanup ${cleanup}`,
      };
    }
  }

  private async reconcileClaimRelease(
    attempt: Attempt,
    signal: AbortSignal,
  ): Promise<Attempt> {
    if (attempt.claim === null || attempt.claim.status === "released") return attempt;
    const operation = this.dependencies.store
      .listOperations(attempt.id)
      .find((candidate) => candidate.kind === "github.delete-issue-claim");
    if (!operation) return attempt;
    if (operation.state === "reserved") {
      const existing = await this.dependencies.github.getRef(
        this.repositoryRef,
        attempt.claim.ref,
        signal,
      );
      if (existing) return attempt;
      this.dependencies.store.reconcileOperation({
        idempotencyKey: operation.idempotencyKey,
        state: "succeeded",
        result: { deleted: true, ref: attempt.claim.ref },
        now: this.now(),
      });
    } else if (operation.state === "failed") {
      return attempt;
    }
    return this.updateAttempt(attempt, {
      claim: { ...attempt.claim, status: "released" },
      detail: mergeDetail(attempt, {
        claim: claimJson({ ...attempt.claim, status: "released" }),
      }),
    });
  }

  private async handleBoundedError(
    error: unknown,
    signal: AbortSignal,
  ): Promise<TickResult | undefined> {
    const active = this.dependencies.store.getActiveAttempt();
    if (error instanceof ProductDecisionRequiredError && active) {
      return await this.blockAttempt(active, "decision", { reason: error.message }, signal);
    }
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof TransientAutonomyError || isTransient(message)) {
      if (active && active.state !== "in_doubt") {
        return this.transitionToWaiting(active, active.state, { transient: message });
      }
      return {
        action: "wait",
        state: "waiting",
        ...(active ? { attemptId: active.id } : {}),
        detail: message,
      };
    }
    return undefined;
  }

  private async advance(attempt: Attempt, signal: AbortSignal): Promise<TickResult> {
    switch (attempt.state) {
      case "issue_selected":
      case "planning":
      case "implementing":
        return await this.implement(attempt, signal);
      case "verifying":
        return await this.verify(attempt, signal);
      case "pr_open":
      case "waiting_ci":
        return await this.checkCi(attempt, signal);
      case "waiting_approval":
        return await this.checkApproval(attempt, signal);
      case "merging":
        return await this.merge(attempt, signal);
      case "post_merge":
        return await this.postMerge(attempt, signal);
      case "waiting":
        return this.resumeWaiting(attempt);
      case "waiting_evidence":
        return {
          action: "wait",
          state: "waiting_evidence",
          attemptId: attempt.id,
          detail: "New diagnosis evidence is required",
        };
      case "blocked":
      case "in_doubt":
      case "pending":
      case "running":
      case "succeeded":
      case "delivered":
      case "failed":
      case "cancelled":
        return { action: "none", state: attempt.state, attemptId: attempt.id };
    }
  }

  private async implement(attempt: Attempt, signal: AbortSignal): Promise<TickResult> {
    await this.revalidateIssue(attempt, signal);
    const repository = await this.repository(signal);
    let current = attempt;
    if (current.state === "issue_selected") {
      current = this.transitionAttempt(current, "planning");
    }
    const worktreeId = `issue-${issueNumber(current)}`;
    let worktree: GitWorktree;
    const detail = detailObject(current);
    if (typeof detail.worktreePath === "string") {
      worktree = {
        id: worktreeId,
        repositoryId: repository.id,
        path: detail.worktreePath,
      };
    } else {
      worktree = await this.dependencies.git.createWorktree(repository, worktreeId, {
        branch: requiredBranch(current),
        startPoint: current.baseSha,
        signal,
      });
      current = this.updateAttempt(current, {
        detail: mergeDetail(current, { worktreePath: worktree.path }),
      });
    }
    if (current.state !== "implementing") {
      current = this.transitionAttempt(current, "implementing");
    }
    const controller = new AbortController();
    const wallMs =
      (this.dependencies.config.product.limits.maxWallTimeMinutes ??
        this.dependencies.config.product.limits.tickMinutes) *
      60_000;
    const timeout = setTimeout(() => controller.abort(new Error("Worker wall-time budget exceeded")), wallMs);
    const onAbort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    let worker: WorkerResult;
    const approvedPaths = optionalStringArray(detailObject(current).approvedPaths);
    try {
      worker = await (this.dependencies.worker ?? runAutonomyWorker)({
        worktreePath: worktree.path,
        issueEnvelope: {
          issueNumber: issueNumber(current),
          title: this.dependencies.store.getIssue(current.issueId)?.title ?? "",
          fields: detailObject(current).issueFields ?? {},
          ...(approvedPaths === undefined ? {} : { approvedPaths }),
        },
        ...(approvedPaths === undefined ? {} : { approvedPaths }),
        provider: this.dependencies.provider,
        runConfig: {
          ...this.dependencies.runConfig,
          maxRounds:
            this.dependencies.config.product.limits.maxRounds ??
            this.dependencies.runConfig.maxRounds,
          maxToolCalls:
            this.dependencies.config.product.limits.maxToolCalls ??
            this.dependencies.runConfig.maxToolCalls,
        },
        sessionHome: path.join(this.dependencies.config.stateRoot, "worker"),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
    }
    current = this.updateAttempt(current, {
      sessionId: worker.sessionId,
      detail: mergeDetail(current, { workerReason: worker.result.reason }),
    });
    if (!worker.result.ok) {
      return await this.handleFailure(
        current,
        "worker",
        worker.result.exitCode,
        worker.result.reason,
        signal,
      );
    }
    this.transitionAttempt(current, "verifying");
    return { action: "implement", state: "verifying", attemptId: current.id };
  }

  private async verify(attempt: Attempt, signal: AbortSignal): Promise<TickResult> {
    const worktree = this.worktree(attempt);
    await this.dependencies.git.stageAll(worktree, signal);
    const diff = await this.dependencies.git.diff(worktree, {
      staged: true,
      baseRef: attempt.baseSha,
      maxBytes: this.maxChangedBytes(),
      signal,
    });
    if (diff.nameStatus.length === 0) {
      return await this.handleFailure(attempt, "diff", 0, "worker produced no changes", signal);
    }
    const paths = [
      ...new Set(
        diff.nameStatus.flatMap((entry) =>
          entry.originalPath === undefined
            ? [entry.path]
            : [entry.originalPath, entry.path],
        ),
      ),
    ];
    if (paths.length > this.maxChangedFiles()) {
      return await this.blockAttempt(
        attempt,
        "review",
        { reason: "changed-file budget exceeded" },
        signal,
      );
    }
    const approvedPaths = optionalStringArray(detailObject(attempt).approvedPaths);
    if (
      approvedPaths !== undefined &&
      paths.some((changedPath) => !approvedPaths.includes(changedPath))
    ) {
      return await this.blockAttempt(
        attempt,
        "review",
        {
          reason: "changed path is outside the trusted approved-path binding",
          approvedPaths,
          changedPaths: paths,
        },
        signal,
      );
    }
    const diffHash = crypto.createHash("sha256").update(diff.patch).digest("hex");
    const deterministic = deterministicReview(diff.patch, paths, {
      protectedPaths: this.dependencies.config.qualityGates.governance.protectedPaths,
      maxDiffBytes: this.maxChangedBytes(),
    });
    if (deterministic.blocked) {
      return await this.blockAttempt(
        attempt,
        "review",
        { deterministicReview: deterministic as unknown as JsonValue },
        signal,
      );
    }
    let modelReview;
    try {
      modelReview = await independentReview(this.dependencies.reviewer, {
        issue: JSON.stringify(detailObject(attempt).issueFields ?? {}),
        patch: diff.patch,
        changedPaths: paths,
        signal,
      });
    } catch (error) {
      return await this.blockAttempt(
        attempt,
        "review",
        {
          reason: "invalid independent review",
          error: error instanceof Error ? error.message : String(error),
        },
        signal,
      );
    }
    if (modelReview.criticalFindings.length > 0) {
      return await this.blockAttempt(
        attempt,
        "review",
        { modelReview: jsonValue(modelReview) },
        signal,
      );
    }
    const criticalApprovalRequired = deterministic.findings.some(
      (finding) =>
        finding.code === "dependency-change" || finding.code === "critical-system-change",
    );
    let current = this.updateAttempt(attempt, {
      detail: mergeDetail(attempt, {
        deterministicReview: jsonValue(deterministic),
        modelReview: jsonValue(modelReview),
        approvalRequired: criticalApprovalRequired,
        changedPaths: paths,
        diffHash,
        reviewedBaseSha: attempt.baseSha,
      }),
    });
    if (criticalApprovalRequired && !this.hasApproval(current, "execute-gates", diffHash)) {
      return this.waitForApproval(current, "execute-gates", diffHash);
    }

    const sandbox = this.dependencies.sandboxFactory(worktree.path);
    const availability = sandbox.availability();
    if (!availability.available) {
      return await this.blockUnavailable(current, availability, signal);
    }
    for (const gate of this.dependencies.config.qualityGates.localCommands) {
      const result = await sandbox.run(gate.name, signal);
      if (!processSucceeded(result)) {
        if (isTransient(result.stderr)) {
          return this.transitionToWaiting(current, "verifying", {
            gate: gate.name,
            error: result.stderr,
          });
        }
        return await this.handleFailure(
          current,
          `gate:${gate.name}`,
          result.exitCode,
          result.stderr || result.spawnError || "gate failed",
          signal,
        );
      }
    }

    if (this.dependencies.config.mode === "propose") {
      const released = await this.releaseClaimBeforeTerminal(current, signal, "proposal-completed");
      if (!released) {
        return { action: "propose", state: "in_doubt", attemptId: current.id };
      }
      current = released;
      this.safeTransition(current, "succeeded", {
        proposed: true,
        diffHash,
        worktreePath: worktree.path,
      });
      this.releaseIssueLease(current);
      return {
        action: "propose",
        state: "succeeded",
        attemptId: current.id,
        detail: `Reviewed proposal preserved at ${worktree.path}; nothing committed or published`,
      };
    }

    if (criticalApprovalRequired && !this.hasApproval(current, "publish", diffHash)) {
      return this.waitForApproval(current, "publish", diffHash);
    }
    await this.revalidateIssue(current, signal);

    const repository = await this.repository(signal);
    const issueTitle =
      this.dependencies.store.getIssue(current.issueId)?.title ?? "autonomy issue";
    const commitMessage = `feat: implement #${issueNumber(current)} ${issueTitle
      .replace(/\s+/gu, " ")
      .trim()}`.slice(0, 240);
    let head: string;
    try {
      const commitResult = await this.externalWrite(
        current,
        `commit:${current.id}:${diffHash}`,
        "git.commit",
        { baseSha: current.baseSha, diffHash, message: commitMessage },
        async () => ({ headSha: await this.dependencies.git.commit(worktree, commitMessage, signal) }),
        async () => {
          const observed = await this.dependencies.git.head(worktree, signal);
          const status = await this.dependencies.git.status(worktree, signal);
          return observed !== current.baseSha && status.clean ? { headSha: observed } : undefined;
        },
      );
      head = requiredJsonString(commitResult, "headSha");
      current = this.updateAttempt(current, { headSha: head });
      await this.externalWrite(
        current,
        `push:${requiredBranch(current)}:${head}`,
        "git.push",
        { branch: requiredBranch(current), headSha: head },
        async () => {
          await this.dependencies.git.push(worktree, {
            remote: "origin",
            branch: requiredBranch(current),
            setUpstream: true,
            signal,
          });
          return { headSha: head };
        },
        async () => {
          const remoteHead = await this.dependencies.git.remoteBranchHead(
            repository,
            "origin",
            requiredBranch(current),
            signal,
          );
          return remoteHead === head ? { headSha: remoteHead } : undefined;
        },
      );
      const publishedHead = await this.dependencies.git.remoteBranchHead(
        repository,
        "origin",
        requiredBranch(current),
        signal,
      );
      if (publishedHead !== head) {
        this.safeTransition(current, "in_doubt", {
          reason: "issue branch push is not proven at the expected head",
          expectedHeadSha: head,
          observedHeadSha: publishedHead ?? null,
        });
        return { action: "publish", state: "in_doubt", attemptId: current.id };
      }
      current = await this.releaseOwnClaim(current, signal, "issue-branch-published");
    } catch (error) {
      const pendingClaimDelete = this.dependencies.store
        .listOperations(current.id)
        .some(
          (operation) =>
            operation.kind === "github.delete-issue-claim" && operation.state === "reserved",
        );
      if (pendingClaimDelete && current.claim?.status === "active") {
        current = this.updateAttempt(current, {
          claim: { ...current.claim, status: "in_doubt" },
          detail: mergeDetail(current, {
            claim: claimJson({ ...current.claim, status: "in_doubt" }),
          }),
        });
      }
      current = this.updateAttempt(current, {
        detail: mergeDetail(current, {
          writeError: error instanceof Error ? error.message : String(error),
        }),
      });
      this.safeTransition(current, "in_doubt", { operation: "commit-or-push" });
      return { action: "publish", state: "in_doubt", attemptId: current.id };
    }

    let pull = await this.dependencies.github.findPullRequestByHead(
      this.repositoryRef,
      requiredBranch(current),
      signal,
    );
    if (!pull) {
      try {
        const result = await this.externalWrite(
          current,
          `pull-request:${requiredBranch(current)}:${head}`,
          "github.create-pull-request",
          { branch: requiredBranch(current), headSha: head },
          async () =>
            jsonValue(
              await this.dependencies.github.createPullRequest(
                this.repositoryRef,
                {
                  title: `#${issueNumber(current)} ${issueTitle}`,
                  body: `Implements #${issueNumber(current)}\n\nHead: ${head}\nPolicy: ${this.dependencies.config.policyHash}`,
                  head: requiredBranch(current),
                  base: this.dependencies.config.product.repository.defaultBranch,
                  draft: false,
                },
                signal,
              ),
            ),
          async () => {
            const found = await this.dependencies.github.findPullRequestByHead(
              this.repositoryRef,
              requiredBranch(current),
              signal,
            );
            return found && found.headSha === head ? jsonValue(found) : undefined;
          },
        );
        pull = result as unknown as GitHubPullRequest;
      } catch (error) {
        this.safeTransition(current, "in_doubt", {
          operation: "create-pull-request",
          error: error instanceof Error ? error.message : String(error),
        });
        return { action: "open-pr", state: "in_doubt", attemptId: current.id };
      }
    }
    if (pull.headSha !== head) {
      this.safeTransition(current, "in_doubt", { reason: "created pull request head mismatch" });
      return { action: "open-pr", state: "in_doubt", attemptId: current.id };
    }
    current = this.updateAttempt(current, { prNumber: pull.number });
    this.transitionAttempt(current, "pr_open");
    return { action: "open-pr", state: "pr_open", attemptId: current.id };
  }

  private async checkCi(attempt: Attempt, signal: AbortSignal): Promise<TickResult> {
    const checks = await this.dependencies.github.getChecksForCommit(
      this.repositoryRef,
      attempt.headSha,
      signal,
    );
    this.issueLease(attempt);
    const required = this.dependencies.config.qualityGates.githubChecks.required;
    if (checks.some((check) => check.headSha !== attempt.headSha)) {
      this.safeTransition(attempt, "in_doubt", { reason: "CI evidence was returned for a stale head" });
      return { action: "poll-ci", state: "in_doubt", attemptId: attempt.id };
    }
    const selected = required.map((name) => {
      const matches = checks.filter((check) => check.name === name);
      if (matches.length > 1) {
        throw new ProductDecisionRequiredError(`Duplicate required check name: ${name}`);
      }
      return matches[0];
    });
    for (const check of checks) {
      this.dependencies.store.recordCheck({
        id: `github-${check.id}`,
        attemptId: attempt.id,
        name: check.name,
        status:
          check.status !== "completed"
            ? "running"
            : check.conclusion === "success"
              ? "passed"
              : "failed",
        detail: jsonValue(check),
      });
    }
    if (
      selected.some(
        (check) =>
          check === undefined ||
          check.status !== "completed" ||
          check.conclusion === null,
      )
    ) {
      if (attempt.state !== "waiting_ci") this.safeTransition(attempt, "waiting_ci", { required });
      return { action: "poll-ci", state: "waiting_ci", attemptId: attempt.id };
    }
    if (selected.some((check) => check!.conclusion !== "success")) {
      return await this.handleFailure(
        attempt,
        "github-checks",
        1,
        "required GitHub check failed",
        signal,
      );
    }
    const current = this.updateAttempt(attempt, {
      detail: mergeDetail(attempt, {
        checksPassedForHead: attempt.headSha,
        checkEvidence: jsonValue(selected),
      }),
    });
    if (this.dependencies.config.mode === "auto-pr") {
      this.safeTransition(current, "delivered", {
        prNumber: current.prNumber,
        headSha: current.headSha,
        mergeAuthorized: false,
      });
      this.releaseIssueLease(current);
      return { action: "deliver-pr", state: "delivered", attemptId: current.id };
    }
    if (detailObject(current).approvalRequired === true) {
      const bindingRef = this.approvalBindingRef(current, current.headSha);
      const waiting = this.updateAttempt(current, {
        detail: mergeDetail(current, {
          pendingApprovalAction: "merge",
          pendingApprovalBindingRef: bindingRef,
          approvalResumeState: "merging",
        }),
      });
      this.safeTransition(waiting, "waiting_approval", { headSha: current.headSha, bindingRef });
      return { action: "approval", state: "waiting_approval", attemptId: current.id };
    }
    this.safeTransition(current, "merging", { checksPassed: true });
    return { action: "poll-ci", state: "merging", attemptId: current.id };
  }

  private async checkApproval(attempt: Attempt, signal: AbortSignal): Promise<TickResult> {
    await this.revalidateIssue(attempt, signal);
    const detail = detailObject(attempt);
    const pendingAction =
      typeof detail.pendingApprovalAction === "string" ? detail.pendingApprovalAction : "merge";
    const bindingRef =
      typeof detail.pendingApprovalBindingRef === "string"
        ? detail.pendingApprovalBindingRef
        : attempt.headSha;
    const issue = this.dependencies.store.getIssue(attempt.issueId);
    const approval = this.dependencies.store.findValidApproval(
      {
        issueId: attempt.issueId,
        action: pendingAction,
        issueDigest: issue?.digest ?? "",
        policyHash: this.dependencies.config.policyHash,
        headSha: attempt.headSha,
        bindingRef,
      },
      this.now(),
    );
    if (!approval) return { action: "approval", state: "waiting_approval", attemptId: attempt.id };
    const resume =
      typeof detail.approvalResumeState === "string"
        ? (detail.approvalResumeState as Attempt["state"])
        : "merging";
    this.safeTransition(attempt, resume, { approvalId: approval.id, action: pendingAction });
    return { action: "approval", state: resume, attemptId: attempt.id };
  }

  private async merge(attempt: Attempt, signal: AbortSignal): Promise<TickResult> {
    if (attempt.prNumber === null) throw new Error("Attempt has no pull request");
    await this.revalidateIssue(attempt, signal);
    if (detailObject(attempt).checksPassedForHead !== attempt.headSha) {
      this.safeTransition(attempt, "in_doubt", { reason: "checks are not bound to expected head" });
      return { action: "merge", state: "in_doubt", attemptId: attempt.id };
    }
    const pull = await this.dependencies.github.getPullRequest(
      this.repositoryRef,
      attempt.prNumber,
      signal,
    );
    if (pull.headSha !== attempt.headSha || pull.baseRef !== this.dependencies.config.product.repository.defaultBranch) {
      this.safeTransition(attempt, "in_doubt", { reason: "pull request head or base changed before merge" });
      return { action: "merge", state: "in_doubt", attemptId: attempt.id };
    }
    const repository = await this.repository(signal);
    const freshBase = await this.dependencies.git.fetchBase(
      repository,
      "origin",
      this.dependencies.config.product.repository.defaultBranch,
      signal,
    );
    if (pull.baseSha !== freshBase) {
      return this.transitionToWaiting(attempt, "merging", {
        reason: "pull request base is stale",
        pullBaseSha: pull.baseSha,
        freshBase,
      });
    }
    const status = await this.dependencies.git.status(this.worktree(attempt), signal);
    if (!status.clean) {
      this.safeTransition(attempt, "in_doubt", { reason: "worktree became dirty before merge" });
      return { action: "merge", state: "in_doubt", attemptId: attempt.id };
    }
    const safety = await this.dependencies.github.getRepositorySafety(
      this.repositoryRef,
      this.dependencies.config.product.repository.defaultBranch,
      signal,
    );
    if (!safety.branchProtected || !safety.canPush) {
      throw new ProductDecisionRequiredError(
        "Default branch is unprotected or the GitHub identity lacks merge authority",
      );
    }
    try {
      const writeResult = await this.externalWrite(
        attempt,
        `merge:${attempt.prNumber}:${attempt.headSha}`,
        "github.merge-pull-request",
        { prNumber: attempt.prNumber, headSha: attempt.headSha },
        async () =>
          jsonValue(
            await this.dependencies.github.mergePullRequest(
              this.repositoryRef,
              attempt.prNumber!,
              attempt.headSha,
              this.dependencies.config.product.repository.mergeStrategy,
              signal,
            ),
          ),
        async () => {
          const observed = await this.dependencies.github.getPullRequest(
            this.repositoryRef,
            attempt.prNumber!,
            signal,
          );
          return observed.merged && observed.mergeSha
            ? { merged: true, sha: observed.mergeSha, message: "reconciled" }
            : undefined;
        },
      );
      const result = writeResult as unknown as { merged: boolean; sha: string | null; message: string };
      if (!result.merged || result.sha === null) {
        return this.transitionToWaiting(attempt, "merging", { mergeMessage: result.message });
      }
      const current = this.updateAttempt(attempt, {
        detail: mergeDetail(attempt, { mergeSha: result.sha }),
      });
      this.safeTransition(current, "post_merge", { mergeSha: result.sha });
      return { action: "merge", state: "post_merge", attemptId: current.id };
    } catch (error) {
      this.safeTransition(attempt, "in_doubt", {
        operation: "merge",
        error: error instanceof Error ? error.message : String(error),
      });
      return { action: "merge", state: "in_doubt", attemptId: attempt.id };
    }
  }

  private async postMerge(attempt: Attempt, signal: AbortSignal): Promise<TickResult> {
    const mergeSha = detailObject(attempt).mergeSha;
    if (typeof mergeSha !== "string") {
      this.safeTransition(attempt, "in_doubt", { reason: "missing merge SHA" });
      return { action: "post-merge", state: "in_doubt", attemptId: attempt.id };
    }
    const repository = await this.repository(signal);
    const fetched = await this.dependencies.git.fetchBase(
      repository,
      "origin",
      this.dependencies.config.product.repository.defaultBranch,
      signal,
    );
    if (
      fetched !== mergeSha &&
      !(await this.dependencies.git.isAncestor(repository, mergeSha, fetched, signal))
    ) {
      return this.transitionToWaiting(attempt, "post_merge", {
        reason: "default branch does not contain merge SHA",
      });
    }
    let current = attempt;
    let postWorktree: GitWorktree;
    const existing = detailObject(current).postWorktreePath;
    if (typeof existing === "string") {
      postWorktree = {
        id: `post-${issueNumber(current)}`,
        repositoryId: repository.id,
        path: existing,
      };
    } else {
      postWorktree = await this.dependencies.git.createDetachedWorktree(
        repository,
        `post-${issueNumber(current)}`,
        mergeSha,
        signal,
      );
      current = this.updateAttempt(current, {
        detail: mergeDetail(current, { postWorktreePath: postWorktree.path }),
      });
    }
    const sandbox = this.dependencies.sandboxFactory(postWorktree.path);
    const availability = sandbox.availability();
    if (!availability.available) {
      return await this.postMergeDogfoodFailure(
        current,
        mergeSha,
        "sandbox",
        null,
        availability.reason ?? "sandbox unavailable",
        [],
        signal,
      );
    }
    const dogfoodEvidence: Array<{ command: string; result: JsonValue }> = [];
    const commands = ["install", "build"];
    const changedPaths = stringArray(detailObject(current).changedPaths);
    if (requiresTargetedDogfood(changedPaths)) commands.push("integration");
    commands.push("smoke");
    for (const command of commands) {
      const result = await sandbox.run(command, signal);
      dogfoodEvidence.push({ command, result: jsonValue(result) });
      if (!processSucceeded(result)) {
        return await this.postMergeDogfoodFailure(
          current,
          mergeSha,
          command,
          result.exitCode,
          result.stderr || result.spawnError || `post-merge ${command} failed`,
          dogfoodEvidence,
          signal,
        );
      }
    }

    if (this.dependencies.release) {
      try {
        const binding = this.releaseBinding(current, mergeSha);
        const staged = await this.dependencies.release.stage({
          worktreePath: postWorktree.path,
          commitSha: mergeSha,
          binding,
          signal,
        });
        current = this.updateAttempt(current, {
          detail: mergeDetail(current, {
            postMergeDogfood: jsonValue(dogfoodEvidence),
            releaseEvidence: releaseEvidence(staged),
          }),
        });
        const canary = this.dependencies.release.markCanarySuccess(mergeSha);
        current = this.updateAttempt(current, {
          detail: mergeDetail(current, {
            releaseEvidence: releaseEvidence(staged, canary),
          }),
        });
        let promoted: ReleaseStatus | undefined;
        if (this.dependencies.config.mode === "auto-merge") {
          if (
            detailObject(current).approvalRequired === true &&
            !this.hasApproval(current, "merge", current.headSha)
          ) {
            throw new Error("Required merge approval is no longer valid for release promotion");
          }
          promoted = this.dependencies.release.promote(mergeSha, 1, binding);
          current = this.updateAttempt(current, {
            detail: mergeDetail(current, {
              releaseEvidence: releaseEvidence(staged, canary, promoted),
            }),
          });
        }
      } catch (error) {
        current = this.updateAttempt(current, {
          detail: mergeDetail(current, {
            postMergeDogfood: jsonValue(dogfoodEvidence),
            releaseFailure: error instanceof Error ? error.message : String(error),
          }),
        });
        this.safeTransition(current, "blocked", {
          reason: "release staging or promotion failed; cleanup and lease release withheld",
        });
        return { action: "release", state: "blocked", attemptId: current.id };
      }
    } else {
      current = this.updateAttempt(current, {
        detail: mergeDetail(current, { postMergeDogfood: jsonValue(dogfoodEvidence) }),
      });
    }
    const issueNo = issueNumber(current);
    const deliveryMarker = `<!-- one-cli:delivery:${current.id}:${mergeSha} -->`;
    try {
      await this.externalWrite(
        current,
        `delivery-comment:${issueNo}:${mergeSha}`,
        "github.comment",
        { issueNo, mergeSha },
        async () => {
          const comment = await this.dependencies.github.createComment(
            this.repositoryRef,
            issueNo,
            `${deliveryMarker}\nDelivered by PR #${current.prNumber ?? "unknown"} at ${mergeSha}.\n\nPost-merge install, build, targeted dogfood (when applicable), and smoke passed.`,
            signal,
          );
          return { commentId: comment.id };
        },
        async () => {
          const comment = await this.dependencies.github.findIssueComment(
            this.repositoryRef,
            issueNo,
            deliveryMarker,
            signal,
          );
          return comment ? { commentId: comment.id } : undefined;
        },
      );
      await this.externalWrite(
        current,
        `close-issue:${issueNo}:${mergeSha}`,
        "github.close-issue",
        { issueNo, mergeSha },
        async () => {
          const issue = await this.dependencies.github.getIssue(this.repositoryRef, issueNo, signal);
          await this.dependencies.github.updateIssue(
            this.repositoryRef,
            issueNo,
            { state: "closed", labels: issue.labels.filter((label) => label !== "agent-ready") },
            signal,
          );
          return { closed: true };
        },
        async () => {
          const issue = await this.dependencies.github.getIssue(this.repositoryRef, issueNo, signal);
          return issue.state === "closed" ? { closed: true } : undefined;
        },
      );
      await this.externalWrite(
        current,
        `delete-branch:${requiredBranch(current)}:${mergeSha}`,
        "github.delete-branch",
        { branch: requiredBranch(current), mergeSha },
        async () => {
          await this.dependencies.github.deleteBranch(
            this.repositoryRef,
            requiredBranch(current),
            signal,
          );
          return { deleted: true };
        },
        async () => {
          const exists = await this.dependencies.git.remoteBranchExists(
            repository,
            "origin",
            requiredBranch(current),
            signal,
          );
          return exists ? undefined : { deleted: true };
        },
      );
    } catch (error) {
      this.safeTransition(current, "in_doubt", {
        operation: "post-merge-github-writes",
        error: error instanceof Error ? error.message : String(error),
      });
      return { action: "post-merge", state: "in_doubt", attemptId: current.id };
    }
    await this.dependencies.git.removeWorktree(repository, postWorktree, signal);
    await this.dependencies.git.removeWorktree(repository, this.worktree(current), signal);
    this.safeTransition(current, "succeeded", { postMergeVerified: true });
    this.releaseIssueLease(current);
    return { action: "post-merge", state: "succeeded", attemptId: current.id };
  }

  private async postMergeDogfoodFailure(
    attempt: Attempt,
    mergeSha: string,
    command: string,
    exitCode: number | null,
    error: string,
    evidence: readonly { command: string; result: JsonValue }[],
    signal: AbortSignal,
  ): Promise<TickResult> {
    const normalized = error.trim().replace(/\s+/gu, " ").slice(0, 2_000);
    const fingerprint = crypto
      .createHash("sha256")
      .update(`${mergeSha}\0${command}\0${exitCode ?? "null"}\0${normalized}`)
      .digest("hex");
    let current = this.updateAttempt(attempt, {
      detail: mergeDetail(attempt, {
        postMergeDogfood: jsonValue(evidence),
        postMergeFailure: { mergeSha, command, exitCode, normalized, fingerprint },
      }),
    });
    let promotedIssueNumber: number | undefined;
    let promotionError: string | undefined;
    if (this.dependencies.intake) {
      try {
        const promoted = await this.dependencies.intake.promoteSelfDiscovery({
          finding: {
            title: `Post-merge dogfood failure at ${mergeSha.slice(0, 12)}`,
            problemStatement: `The exact merged artifact failed the ${command} post-merge gate.`,
            reproduction: `Check out ${mergeSha} in a detached worktree, install dependencies, build, then run ${command}. Exit code: ${exitCode ?? "unavailable"}. Error: ${normalized}`,
            minimalScenario: `Detached exact-merge worktree at ${mergeSha}; command sequence: install, build${requiresTargetedDogfood(stringArray(detailObject(current).changedPaths)) ? ", integration" : ""}, smoke.`,
            duplicateSearchEvidence: `Failure fingerprint ${fingerprint}; trusted intake deduplicates the normalized marker against existing execution issues.`,
          },
          normalizedFields: stringFields(detailObject(current).issueFields),
          signal,
        });
        promotedIssueNumber = promoted.executionIssueNumber;
      } catch (error) {
        promotionError = error instanceof Error ? error.message : String(error);
      }
    }
    current = this.updateAttempt(current, {
      detail: mergeDetail(current, {
        postMergeFailure: {
          mergeSha,
          command,
          exitCode,
          normalized,
          fingerprint,
          ...(promotedIssueNumber === undefined ? {} : { promotedIssueNumber }),
          ...(promotionError === undefined ? {} : { promotionError }),
        },
      }),
    });
    return await this.blockAttempt(
      current,
      "post-merge-dogfood",
      {
        reason: "post-merge dogfood failed; original issue remains open",
        fingerprint,
        ...(promotedIssueNumber === undefined ? {} : { promotedIssueNumber }),
      },
      signal,
    );
  }

  private async handleFailure(
    attempt: Attempt,
    operation: string,
    exitCode: number | null,
    error: string,
    signal?: AbortSignal,
  ): Promise<TickResult> {
    const normalized = error.trim().replace(/\s+/gu, " ").slice(0, 2_000);
    const failureIssueDigest =
      this.dependencies.store.getIssue(attempt.issueId)?.digest ?? "missing-issue";
    const fingerprint = crypto
      .createHash("sha256")
      .update(`${failureIssueDigest}\0${operation}\0${exitCode ?? "null"}\0${normalized}`)
      .digest("hex");
    const detail = detailObject(attempt);
    const failures = asRecord(detail.failures);
    const count = typeof failures[fingerprint] === "number" ? (failures[fingerprint] as number) + 1 : 1;
    failures[fingerprint] = count;
    const current = this.updateAttempt(attempt, {
      detail: mergeDetail(attempt, {
        failures,
        lastFailure: {
          operation,
          exitCode,
          normalized,
          issueDigest: failureIssueDigest,
          fingerprint,
          count,
        },
        failureEvidence: Array.isArray(detail.failureEvidence)
          ? detail.failureEvidence
          : [],
        waitingEvidence: true,
        resumeState: failureResumeState(attempt, operation),
      }),
    });
    if (count >= this.dependencies.config.issuePolicy.failureIsolation.identicalCodeFailureLimit) {
      const issueNo = issueNumber(current);
      try {
        const issue = await this.dependencies.github.getIssue(this.repositoryRef, issueNo, signal);
        await this.dependencies.github.updateIssue(this.repositoryRef, issueNo, {
          labels: [
            ...new Set([
              ...issue.labels.filter((label) => label !== "agent-ready"),
              this.dependencies.config.issuePolicy.failureIsolation.thirdFailureLabel,
            ]),
          ],
        }, signal);
      } catch {
        this.safeTransition(current, "in_doubt", { operation: "quarantine-label" });
        return { action: operation, state: "in_doubt", attemptId: current.id };
      }
      const released = await this.releaseClaimBeforeTerminal(
        current,
        signal ?? new AbortController().signal,
        "attempt-failed",
      );
      if (!released) return { action: operation, state: "in_doubt", attemptId: current.id };
      this.safeTransition(released, "failed", { fingerprint, count });
      this.releaseIssueLease(released);
      return { action: operation, state: "failed", attemptId: released.id };
    }
    const waiting = this.safeTransition(current, "waiting_evidence", {
      fingerprint,
      count,
      reason: "new diagnosis evidence is required before retry",
    });
    return {
      action: operation,
      state: "waiting_evidence",
      attemptId: waiting.id,
      detail: "New diagnosis evidence is required before retry",
    };
  }

  private async withCoordinatorLease<T>(work: () => Promise<T>): Promise<T> {
    const coordinator = this.leases.acquireCoordinator(
      this.dependencies.config.repoKey,
      `recovery-${process.pid}-${this.id()}`,
      this.dependencies.coordinatorTtlMs ?? COORDINATOR_TTL_MS,
    );
    try {
      return await work();
    } finally {
      this.leases.release(coordinator);
    }
  }

  private requiredAttempt(attemptId: string): Attempt {
    const attempt = this.dependencies.store.getAttempt(attemptId);
    if (!attempt) throw new Error(`Unknown attempt "${attemptId}"`);
    return attempt;
  }

  private async reacquireClaimForRecovery(
    attempt: Attempt,
    signal: AbortSignal,
    failureEvidence: readonly JsonValue[],
  ): Promise<Attempt> {
    const priorClaim = attempt.claim;
    if (priorClaim === null || priorClaim.status === "released") {
      const priorLease = parseLease(detailObject(attempt).issueLease);
      if (priorLease) {
        try {
          this.dependencies.store.assertLease(priorLease, this.now());
          this.dependencies.store.releaseLease(priorLease);
        } catch {
          // An expired grant needs no release; fenced acquisition below decides ownership.
        }
      }
      const rotated = this.leases.acquireIssue(
        attempt.issueId,
        `recovery-${process.pid}-${attempt.id}-${this.id()}`,
        this.dependencies.issueTtlMs ?? ISSUE_TTL_MS,
      );
      attempt = this.dependencies.store.updateAttempt({
        attemptId: attempt.id,
        detail: mergeDetail(attempt, { issueLease: leaseJson(rotated) }),
        lease: rotated,
        now: this.now(),
      });
    } else {
      attempt = this.ensureRecoveryLease(attempt);
    }
    const lease = parseLease(detailObject(attempt).issueLease)!;
    const issue = this.dependencies.store.getIssue(attempt.issueId);
    if (!issue) throw new Error("Attempt issue is missing");
    const ref = issueClaimRef(issueNumber(attempt), issue.digest);
    const request = {
      ref,
      headSha: attempt.baseSha,
      digest: issue.digest,
      owner: lease.owner,
    };
    let current = this.dependencies.store.updateAttempt({
      attemptId: attempt.id,
      detail: mergeDetail(attempt, {
        issueLease: leaseJson(lease),
        claimRequest: request,
        failureEvidence,
        waitingEvidence: false,
      }),
      lease,
      now: this.now(),
    });
    const key = `recovery-claim:${current.id}:${lease.fence}`;
    this.dependencies.store.reserveOperation({
      id: this.id(),
      idempotencyKey: key,
      kind: "github.create-issue-claim",
      request: { ...request, recovery: true },
      issueId: current.issueId,
      attemptId: current.id,
      now: this.now(),
    });
    try {
      let observed = await this.dependencies.github.getRef(this.repositoryRef, ref, signal);
      if (observed && observed.sha !== attempt.baseSha) {
        current = this.dependencies.store.transitionAttempt({
          attemptId: current.id,
          to: "in_doubt",
          data: { reason: "recovery claim head mismatch", observedHeadSha: observed.sha },
          lease,
          now: this.now(),
        });
        return current;
      }
      if (
        observed &&
        !(
          priorClaim &&
          (priorClaim.status === "active" || priorClaim.status === "in_doubt") &&
          priorClaim.ref === ref &&
          priorClaim.headSha === observed.sha &&
          priorClaim.digest === issue.digest &&
          priorClaim.owner === lease.owner
        )
      ) {
        current = this.dependencies.store.transitionAttempt({
          attemptId: current.id,
          to: "in_doubt",
          data: { reason: "pre-existing recovery claim is not owned by this attempt" },
          lease,
          now: this.now(),
        });
        return current;
      }
      if (!observed) {
        try {
          observed = await this.dependencies.github.createRef(
            this.repositoryRef,
            ref,
            attempt.baseSha,
            signal,
          );
        } catch (error) {
          if (error instanceof GitHubRefConflictError) throw error;
          observed = await this.dependencies.github.getRef(this.repositoryRef, ref, signal);
          if (!observed || observed.sha !== attempt.baseSha) throw new Error("claim outcome uncertain");
        }
      }
      const claim: IssueClaimEvidence = { ...request, status: "active" };
      current = this.dependencies.store.updateAttempt({
        attemptId: current.id,
        claim,
        detail: mergeDetail(current, { claim: claimJson(claim) }),
        lease,
        now: this.now(),
      });
      this.dependencies.store.reconcileOperation({
        idempotencyKey: key,
        state: "succeeded",
        result: { ref, sha: observed.sha, owner: lease.owner },
        now: this.now(),
      });
      return current;
    } catch (error) {
      if (error instanceof GitHubRefConflictError) {
        if (current.state !== "in_doubt") {
          current = this.dependencies.store.transitionAttempt({
            attemptId: current.id,
            to: "in_doubt",
            data: {
              operation: "recovery-claim",
              reason: "GitHub recovery claim is pre-existing and not owned by this attempt",
            },
            lease,
            now: this.now(),
          });
        }
        return current;
      }
      current = this.dependencies.store.updateAttempt({
        attemptId: current.id,
        claim: {
          ref,
          headSha: attempt.baseSha,
          digest: issue.digest,
          owner: lease.owner,
          status: "in_doubt",
        },
        lease,
        now: this.now(),
      });
      if (current.state !== "in_doubt") {
        current = this.dependencies.store.transitionAttempt({
          attemptId: current.id,
          to: "in_doubt",
          data: { operation: "recovery-claim", error: errorMessage(error) },
          lease,
          now: this.now(),
        });
      }
      return current;
    }
  }

  private ensureRecoveryLease(attempt: Attempt): Attempt {
    const existing = parseLease(detailObject(attempt).issueLease);
    try {
      if (!existing) throw new LeaseLostError(`issue:${attempt.issueId}`);
      this.dependencies.store.assertLease(existing, this.now());
      return attempt;
    } catch {
      const lease = this.leases.acquireIssue(
        attempt.issueId,
        attempt.claim?.owner ?? `recovery-${process.pid}-${attempt.id}-${this.id()}`,
        this.dependencies.issueTtlMs ?? ISSUE_TTL_MS,
      );
      return this.dependencies.store.updateAttempt({
        attemptId: attempt.id,
        detail: mergeDetail(attempt, { issueLease: leaseJson(lease) }),
        lease,
        now: this.now(),
      });
    }
  }

  private releaseBinding(attempt: Attempt, releaseSha: string): ReleaseCandidateBinding {
    const issue = this.dependencies.store.getIssue(attempt.issueId);
    if (!issue) throw new Error("Release attempt issue is missing");
    let approval: ReleaseCandidateBinding["approval"];
    if (detailObject(attempt).approvalRequired === true) {
      const bindingRef = this.approvalBindingRef(attempt, attempt.headSha);
      const durable = this.dependencies.store.findValidApproval(
        {
          issueId: attempt.issueId,
          action: "merge",
          issueDigest: issue.digest,
          policyHash: this.dependencies.config.policyHash,
          headSha: attempt.headSha,
          bindingRef,
        },
        this.now(),
      );
      if (!durable) throw new Error("Required release approval is missing or stale");
      approval = { approvalId: durable.id, action: "merge", bindingRef };
    }
    return {
      attemptId: attempt.id,
      issueDigest: issue.digest,
      policyHash: this.dependencies.config.policyHash,
      headSha: releaseSha,
      ...(approval ? { approval } : {}),
    };
  }

  private refreshIssueLease(attempt: Attempt): void {
    const lease = parseLease(detailObject(attempt).issueLease);
    if (!lease) throw new Error("Active attempt is missing its fenced issue lease");
    const renewed = this.leases.heartbeat(
      lease,
      this.dependencies.issueTtlMs ?? ISSUE_TTL_MS,
    );
    this.dependencies.store.updateAttempt({
      attemptId: attempt.id,
      detail: mergeDetail(attempt, { issueLease: leaseJson(renewed) }),
      lease: renewed,
      now: this.now(),
    });
  }

  private async externalWrite(
    attempt: Attempt,
    idempotencyKey: string,
    kind: string,
    request: JsonValue,
    write: () => Promise<JsonValue>,
    reconcile: () => Promise<JsonValue | undefined>,
  ): Promise<JsonValue> {
    this.issueLease(attempt);
    const reservation = this.dependencies.store.reserveOperation({
      id: this.id(),
      idempotencyKey,
      kind,
      request,
      issueId: attempt.issueId,
      attemptId: attempt.id,
    });
    if (!reservation.created) {
      if (reservation.operation.state === "succeeded") return reservation.operation.result ?? null;
      if (reservation.operation.state === "failed") {
        throw new Error(`External operation "${idempotencyKey}" previously failed`);
      }
      const observed = await reconcile();
      if (observed !== undefined) {
        this.issueLease(attempt);
        this.dependencies.store.reconcileOperation({
          idempotencyKey,
          state: "succeeded",
          result: observed,
        });
        return observed;
      }
    }
    try {
      const result = await write();
      this.issueLease(attempt);
      this.dependencies.store.reconcileOperation({
        idempotencyKey,
        state: "succeeded",
        result,
      });
      return result;
    } catch (error) {
      // Keep the reservation in doubt: the next tick must reconcile external state.
      throw error;
    }
  }

  private async releaseOwnClaim(
    attempt: Attempt,
    signal: AbortSignal,
    reason: string,
  ): Promise<Attempt> {
    let current = this.dependencies.store.getAttempt(attempt.id) ?? attempt;
    const claim = current.claim;
    if (claim === null || claim.status === "released") return current;
    if (claim.status !== "active" && claim.status !== "in_doubt") {
      throw new Error("Issue claim is not releasable");
    }
    this.assertOwnClaim(current, claim);
    await this.externalWrite(
      current,
      `claim-delete:${claim.ref}:${claim.owner}`,
      "github.delete-issue-claim",
      claimJson({ ...claim, status: "active" }),
      async () => {
        const existing = await this.dependencies.github.getRef(
          this.repositoryRef,
          claim.ref,
          signal,
        );
        if (existing && existing.sha !== claim.headSha) {
          throw new Error("Refusing to delete an issue claim whose head changed");
        }
        if (existing) {
          await this.dependencies.github.deleteRef(this.repositoryRef, claim.ref, signal);
        }
        return { deleted: true, ref: claim.ref };
      },
      async () => {
        const existing = await this.dependencies.github.getRef(
          this.repositoryRef,
          claim.ref,
          signal,
        );
        return existing === undefined ? { deleted: true, ref: claim.ref } : undefined;
      },
    );
    current = this.updateAttempt(current, {
      claim: { ...claim, status: "released" },
      detail: mergeDetail(current, {
        claim: claimJson({ ...claim, status: "released" }),
        claimReleaseReason: reason,
      }),
    });
    return current;
  }

  private async releaseClaimBeforeTerminal(
    attempt: Attempt,
    signal: AbortSignal,
    reason: string,
  ): Promise<Attempt | undefined> {
    try {
      return await this.releaseOwnClaim(attempt, signal, reason);
    } catch (error) {
      let current = this.dependencies.store.getAttempt(attempt.id) ?? attempt;
      if (current.claim) {
        try {
          current = this.updateAttempt(current, {
            claim: { ...current.claim, status: "in_doubt" },
            detail: mergeDetail(current, {
              claim: claimJson({ ...current.claim, status: "in_doubt" }),
              claimDeleteError: errorMessage(error),
            }),
          });
        } catch {
          // The reserved delete operation remains durable evidence.
        }
      }
      this.safeTransition(current, "in_doubt", {
        operation: "delete-issue-claim",
        error: errorMessage(error),
      });
      return undefined;
    }
  }

  private assertOwnClaim(attempt: Attempt, claim: IssueClaimEvidence): void {
    const issue = this.dependencies.store.getIssue(attempt.issueId);
    const lease = parseLease(detailObject(attempt).issueLease);
    if (
      !issue ||
      !lease ||
      claim.ref !== issueClaimRef(issueNumber(attempt), issue.digest) ||
      claim.digest !== issue.digest ||
      claim.headSha !== attempt.baseSha ||
      claim.owner !== lease.owner
    ) {
      throw new Error("Issue claim is not exactly bound to durable attempt data");
    }
  }

  private releaseIssueLease(attempt: Attempt): void {
    const lease = parseLease(detailObject(attempt).issueLease);
    if (lease) this.leases.release(lease);
  }

  private safeTransition(attempt: Attempt, to: Attempt["state"], data: JsonValue): Attempt {
    const current = this.dependencies.store.getAttempt(attempt.id) ?? attempt;
    if (current.state === to) return current;
    return this.transitionAttempt(current, to, data);
  }

  private transitionAttempt(
    attempt: Attempt,
    to: Attempt["state"],
    data?: JsonValue,
  ): Attempt {
    return this.dependencies.store.transitionAttempt({
      attemptId: attempt.id,
      to,
      ...(data === undefined ? {} : { data }),
      lease: this.issueLease(attempt),
      now: this.now(),
    });
  }

  private updateAttempt(
    attempt: Attempt,
    update: Omit<Parameters<AutonomyStore["updateAttempt"]>[0], "attemptId" | "lease">,
  ): Attempt {
    return this.dependencies.store.updateAttempt({
      attemptId: attempt.id,
      ...update,
      lease: this.issueLease(attempt),
      now: this.now(),
    });
  }

  private issueLease(attempt: Attempt): LeaseGrant {
    const current = this.dependencies.store.getAttempt(attempt.id) ?? attempt;
    const lease = parseLease(detailObject(current).issueLease);
    if (!lease) throw new LeaseLostError(`issue:${attempt.issueId}`);
    this.dependencies.store.assertLease(lease, this.now());
    return lease;
  }

  private transitionToWaiting(
    attempt: Attempt,
    resumeState: Attempt["state"],
    detail: Record<string, JsonValue>,
  ): TickResult {
    const currentDetail = detailObject(attempt);
    const waitingCount =
      typeof currentDetail.waitingCount === "number" ? currentDetail.waitingCount + 1 : 1;
    const delayMs = Math.min(5 * 60_000, 1_000 * 2 ** Math.min(waitingCount - 1, 8));
    const current = this.updateAttempt(attempt, {
      detail: mergeDetail(attempt, {
        ...detail,
        resumeState,
        waitingCount,
        notBefore: this.now() + delayMs,
      }),
    });
    this.safeTransition(current, "waiting", detail);
    const reason = typeof detail.reason === "string" ? detail.reason : undefined;
    return {
      action: "wait",
      state: "waiting",
      attemptId: current.id,
      ...(reason === undefined ? {} : { detail: reason }),
    };
  }

  private resumeWaiting(attempt: Attempt): TickResult {
    const detail = detailObject(attempt);
    const notBefore = typeof detail.notBefore === "number" ? detail.notBefore : 0;
    if (this.now() < notBefore) {
      return {
        action: "wait",
        state: "waiting",
        attemptId: attempt.id,
        detail: `Retry not before ${notBefore}`,
      };
    }
    const resume =
      typeof detail.resumeState === "string"
        ? (detail.resumeState as Attempt["state"])
        : "planning";
    const resumed = this.safeTransition(attempt, resume, { resumedAt: this.now() });
    return { action: "retry", state: resumed.state, attemptId: attempt.id };
  }

  private approvalBindingRef(attempt: Attempt, evidence: string): string {
    return `${attempt.baseSha}:${evidence}`;
  }

  private hasApproval(attempt: Attempt, action: string, evidence: string): boolean {
    const issue = this.dependencies.store.getIssue(attempt.issueId);
    if (!issue) return false;
    return Boolean(
      this.dependencies.store.findValidApproval(
        {
          issueId: attempt.issueId,
          action,
          issueDigest: issue.digest,
          policyHash: this.dependencies.config.policyHash,
          headSha: attempt.headSha,
          bindingRef: this.approvalBindingRef(attempt, evidence),
        },
        this.now(),
      ),
    );
  }

  private waitForApproval(attempt: Attempt, action: string, evidence: string): TickResult {
    const bindingRef = this.approvalBindingRef(attempt, evidence);
    const current = this.updateAttempt(attempt, {
      detail: mergeDetail(attempt, {
        pendingApprovalAction: action,
        pendingApprovalBindingRef: bindingRef,
        approvalResumeState: "verifying",
      }),
    });
    this.safeTransition(current, "waiting_approval", { action, bindingRef });
    return { action: "approval", state: "waiting_approval", attemptId: current.id };
  }

  private async revalidateIssue(attempt: Attempt, signal: AbortSignal): Promise<GitHubIssue> {
    const issue = await this.dependencies.github.getIssue(
      this.repositoryRef,
      issueNumber(attempt),
      signal,
    );
    const fields = normalizedIssueFields(
      issue,
      this.dependencies.config.issuePolicy.normalization.requiredFields,
    );
    const approvedPaths = fields ? parseApprovedPathBinding(fields) : undefined;
    const hasPathMarker = fields ? hasApprovedPathBindingMarker(fields) : false;
    const storedApprovedPaths = optionalStringArray(detailObject(attempt).approvedPaths);
    const quarantine = new Set([
      "agent-failed",
      "quarantined",
      this.dependencies.config.issuePolicy.failureIsolation.thirdFailureLabel,
    ]);
    if (
      issue.state !== "open" ||
      issue.user?.login !== this.dependencies.config.issuePolicy.authorization.apiAuthorExactMatch ||
      !issue.labels.includes("agent-ready") ||
      issue.labels.some((label) => quarantine.has(label)) ||
      fields === undefined ||
      ((issue.labels.includes(COMMUNITY_SOURCE_LABEL) ||
        issue.labels.includes(COLD_START_ROADMAP_LABEL) ||
        hasPathMarker) &&
        (approvedPaths === undefined ||
          storedApprovedPaths === undefined ||
          !sameStrings(approvedPaths, storedApprovedPaths))) ||
      !isTrustedExecutionIssue(
        issue,
        this.dependencies.config.issuePolicy.authorization.apiAuthorExactMatch,
      )
    ) {
      throw new ProductDecisionRequiredError(
        "Execution issue no longer has exact author/open/agent-ready/normalized eligibility",
      );
    }
    const stored = this.dependencies.store.getIssue(attempt.issueId);
    if (!stored || stored.digest !== issueDigest(issue)) {
      throw new ProductDecisionRequiredError("Execution issue immutable digest changed");
    }
    return issue;
  }

  private async repository(signal: AbortSignal): Promise<GitRepository> {
    return await this.dependencies.git.ensureBare(
      this.dependencies.config.repoKey,
      this.dependencies.remoteUrl,
      signal,
    );
  }

  private worktree(attempt: Attempt): GitWorktree {
    const worktreePath = detailObject(attempt).worktreePath;
    if (typeof worktreePath !== "string") throw new Error("Attempt has no isolated worktree");
    return {
      id: `issue-${issueNumber(attempt)}`,
      repositoryId: this.dependencies.config.repoKey,
      path: worktreePath,
    };
  }

  private async blockUnavailable(
    attempt: Attempt,
    availability: SandboxAvailability,
    signal: AbortSignal,
  ): Promise<TickResult> {
    return await this.blockAttempt(
      attempt,
      "sandbox",
      { reason: availability.reason ?? "sandbox unavailable" },
      signal,
    );
  }

  private async blockAttempt(
    attempt: Attempt,
    action: string,
    detail: Record<string, JsonValue>,
    signal: AbortSignal,
  ): Promise<TickResult> {
    const released = await this.releaseClaimBeforeTerminal(
      attempt,
      signal,
      `attempt-blocked:${action}`,
    );
    if (!released) return { action, state: "in_doubt", attemptId: attempt.id };
    const blocked = this.safeTransition(released, "blocked", detail);
    this.releaseIssueLease(blocked);
    return { action, state: "blocked", attemptId: attempt.id };
  }

  private maxChangedFiles(): number {
    return this.dependencies.config.product.limits.maxChangedFiles ?? 100;
  }

  private maxChangedBytes(): number {
    return this.dependencies.config.product.limits.maxChangedBytes ?? 2 * 1024 * 1024;
  }

  private candidateLabels(): readonly string[] {
    return this.dependencies.executionScope === "roadmap-only"
      ? ["agent-ready", COLD_START_ROADMAP_LABEL]
      : ["agent-ready"];
  }

  private assertExecutionScope(attempt: Attempt): void {
    if (this.dependencies.executionScope === "roadmap-only") {
      requireRoadmapScopeBinding(attempt, this.expectedRoadmapBinding());
    }
  }

  private expectedRoadmapBinding(): ExpectedRoadmapBinding {
    const binding = this.dependencies.expectedRoadmapBinding;
    if (!binding) {
      throw new Error("Roadmap-only execution requires an exact host issue and marker binding");
    }
    return binding;
  }
}

function issueBranch(issue: GitHubIssue): string {
  const slug = issue.title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 48);
  return `issue/${issue.number}-${slug || "change"}`;
}

function issueDigest(issue: GitHubIssue): string {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        number: issue.number,
        title: issue.title,
        body: issue.body,
        author: issue.user?.login ?? null,
        state: issue.state,
        labels: [...issue.labels].sort(),
      }),
    )
    .digest("hex");
}

function failureResumeState(attempt: Attempt, operation: string): Attempt["state"] {
  if (operation === "worker") return "implementing";
  if (operation.startsWith("gate:") || operation === "diff") return "verifying";
  if (operation === "github-checks") return "waiting_ci";
  if (operation === "post-merge-smoke") return "post_merge";
  return attempt.state === "waiting" ? "planning" : attempt.state;
}

function requiresTargetedDogfood(paths: readonly string[]): boolean {
  return paths.some(
    (candidate) =>
      candidate === "src/cli.ts" ||
      candidate.startsWith("src/") ||
      candidate.startsWith("tests/") ||
      candidate.startsWith("src/autonomy/"),
  );
}

function stringArray(value: JsonValue | undefined): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function optionalStringArray(value: JsonValue | undefined): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  return value.every((item) => typeof item === "string") ? [...value] : undefined;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((candidate, index) => candidate === right[index])
  );
}

function stringFields(value: JsonValue | undefined): Readonly<Record<string, string>> {
  const fields: Record<string, string> = {};
  for (const [key, nested] of Object.entries(asRecord(value))) {
    if (typeof nested === "string") fields[key] = nested;
  }
  return fields;
}

function releaseEvidence(
  staged: StagedRelease,
  canary?: ReleaseStatus,
  promoted?: ReleaseStatus,
): JsonValue {
  return jsonValue({
    commitSha: staged.commitSha,
    manifestSha256: staged.manifest.manifestSha256,
    totalBytes: staged.manifest.totalBytes,
    fileCount: staged.manifest.files.length,
    binding: staged.binding,
    ...(canary === undefined ? {} : { canary }),
    ...(promoted === undefined ? {} : { promoted }),
  });
}

function issueNumber(attempt: Attempt): number {
  const value = detailObject(attempt).issueNumber;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Attempt has no valid issue number");
  }
  return value;
}

function requiredBranch(attempt: Attempt): string {
  if (!attempt.branch) throw new Error("Attempt has no branch");
  return attempt.branch;
}

function detailObject(attempt: Attempt): Record<string, JsonValue> {
  return asRecord(attempt.detail);
}

function asRecord(value: unknown): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return { ...(value as Record<string, JsonValue>) };
}

function mergeDetail(attempt: Attempt, update: Record<string, JsonValue>): JsonValue {
  return { ...detailObject(attempt), ...update };
}

function processSucceeded(result: ProcessResult): boolean {
  return (
    result.exitCode === 0 &&
    result.spawnError === undefined &&
    !result.timedOut &&
    !result.cancelled &&
    !result.outputLimitExceeded
  );
}

function isTransient(message: string): boolean {
  return /\b(?:network|timed? ?out|rate.?limit|temporar|ECONN|EAI_AGAIN|503|502|CI queue)\b/iu.test(
    message,
  );
}

function leaseJson(lease: LeaseGrant): JsonValue {
  return {
    resource: lease.resource,
    owner: lease.owner,
    fence: lease.fence,
    expiresAt: lease.expiresAt,
  };
}

function parseLease(value: JsonValue | undefined): LeaseGrant | undefined {
  const object = asRecord(value);
  return typeof object.resource === "string" &&
    typeof object.owner === "string" &&
    typeof object.fence === "number" &&
    typeof object.expiresAt === "number"
    ? {
        resource: object.resource,
        owner: object.owner,
        fence: object.fence,
        expiresAt: object.expiresAt,
      }
    : undefined;
}

function requestedClaim(attempt: Attempt): Omit<IssueClaimEvidence, "status"> {
  const request = asRecord(detailObject(attempt).claimRequest);
  const ref = request.ref;
  const headSha = request.headSha;
  const digest = request.digest;
  const owner = request.owner;
  const issue = /^github-([1-9][0-9]*)$/u.exec(attempt.issueId);
  if (
    typeof ref !== "string" ||
    typeof headSha !== "string" ||
    typeof digest !== "string" ||
    typeof owner !== "string" ||
    issue === null ||
    ref !== issueClaimRef(Number(issue[1]!), digest) ||
    headSha !== attempt.baseSha ||
    parseLease(detailObject(attempt).issueLease)?.owner !== owner
  ) {
    throw new Error("Pending attempt has invalid durable issue-claim evidence");
  }
  return { ref, headSha, digest, owner };
}

function claimJson(claim: IssueClaimEvidence): Record<string, JsonValue> {
  return {
    ref: claim.ref,
    headSha: claim.headSha,
    digest: claim.digest,
    owner: claim.owner,
    status: claim.status,
  };
}

function jsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}

function requiredJsonString(value: JsonValue, key: string): string {
  const object = asRecord(value);
  const result = object[key];
  if (typeof result !== "string" || !result) {
    throw new Error(`Journaled operation result is missing ${key}`);
  }
  return result;
}
