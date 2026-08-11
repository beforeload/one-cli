import type { GitHubPort, HostIssue, PullEvidence } from "./github.js";
import type { HostJournal, JournalEvent } from "./host.js";
import type {
  AutonomyStatus,
  ExpectedRoadmapBinding,
  OneCliClient,
  TickOutput,
} from "./one-cli.js";
import type { Roadmap } from "./roadmap.js";
import { assertRoadmapParent, parentBody } from "./roadmap.js";
import { HarnessRecovery } from "./recovery.js";
import { seedRoadmap } from "./seed.js";
import type { SeedOperationStore } from "./seed-state.js";

const FAIL_CLOSED_STATES = new Set(["in_doubt", "blocked"]);
const SHA = /^[0-9a-f]{40,64}$/u;

export interface RoadmapHandoff {
  parentNumber: number;
  finalChildIssueNumber: number;
  finalPullNumber: number;
  finalMergeSha: string;
  activeReleaseSha: string;
}

export interface HarnessTickResult {
  action: string;
  state: "succeeded" | "idle" | "blocked" | "parked" | "quarantined";
  phase: "roadmap" | "normal";
  detail: string;
  lane?: "roadmap" | "normal" | "recovery";
  nextAttemptAt?: number;
}

export class ColdStartSupervisor {
  private readonly recovery: HarnessRecovery;

  constructor(
    private readonly dependencies: {
      roadmap: Roadmap;
      github: GitHubPort;
      oneCli: OneCliClient;
      journal: HostJournal;
      recoveryKey?: Uint8Array;
      seedOperations: SeedOperationStore;
    },
  ) {
    this.recovery = new HarnessRecovery({
      ...dependencies,
      recoveryKey: dependencies.recoveryKey ?? new Uint8Array(),
    });
  }

  async tick(signal?: AbortSignal): Promise<HarnessTickResult> {
    let initialIssues: Awaited<ReturnType<ColdStartSupervisor["loadIssues"]>>;
    try {
      initialIssues = await this.loadIssues(signal);
    } catch (error) {
      return this.block("roadmap-set", error instanceof Error ? error.message : String(error));
    }
    const invariantParent = initialIssues.parent;
    if (!invariantParent) {
      return this.block("parent-invariant", "Roadmap parent is missing");
    }
    try {
      assertRoadmapParent(invariantParent, this.dependencies.roadmap);
    } catch (error) {
      return this.block("parent-invariant", error instanceof Error ? error.message : String(error));
    }
    const doctor = await this.dependencies.oneCli.doctor(signal);
    if (!doctor.ok) {
      return this.block(
        "doctor",
        doctor.checks.filter((check) => !check.ok).map((check) => check.name).join(", "),
      );
    }
    const environmentBlockers = await this.recovery.listActiveEnvironmentBlockers(signal);
    if (environmentBlockers.length > 1) {
      return this.block(
        "environment-blocker",
        "Multiple open agent-ready environment blockers are present",
      );
    }
    if (environmentBlockers[0]) {
      const blocker = environmentBlockers[0];
      const tick = await this.dependencies.oneCli.once("normal", undefined, signal);
      this.dependencies.journal.append("harness.environment-blocker-tick", {
        blockerIssueNumber: blocker.number,
        action: tick.action,
        state: tick.state,
        detail: tick.detail ?? null,
      });
      return this.tickResult(tick, "normal");
    }
    const initialNext = initialIssues.children.find(({ issue }) => issue.state === "open");
    const initialBinding = initialNext
      ? roadmapBinding(initialNext.child.seedMarker, initialNext.issue.number)
      : undefined;
    let status = await this.dependencies.oneCli.status("roadmap-only", initialBinding, signal);
    const recoveryScope = initialNext ? "roadmap-only" : "normal";
    const recovery = await this.recovery.recoverWaitingAttempt(
      status,
      recoveryScope,
      recoveryScope === "roadmap-only" ? initialBinding : undefined,
      signal,
      initialNext
        ? {
            issue: initialNext.issue,
            child: initialNext.child,
            parentNumber: invariantParent.number,
          }
        : undefined,
    );
    if (recovery) return recovery;
    if (initialNext) {
      const decomposed = await this.recovery.decomposeBlockedRoadmapEnvironment(
        status,
        initialNext.issue,
        initialNext.child,
        invariantParent.number,
        signal,
      );
      if (decomposed) return decomposed;
      const remediation = await this.recovery.remediateExhaustedRoadmapFailure(
        status,
        initialNext.issue,
        initialNext.child,
        invariantParent.number,
        signal,
      );
      if (remediation) return remediation;
    }
    const preflight = blockedStatus(status);
    if (preflight) return this.block("status", preflight);
    const preEvidence = await this.roadmapEvidence(status, signal);
    if (preEvidence.invalidReason) return this.block("evidence", preEvidence.invalidReason);
    if (
      invariantParent.state === "closed" &&
      preEvidence.delivered.length !== this.dependencies.roadmap.children.length
    ) {
      return this.block(
        "parent-invariant",
        "Closed roadmap parent is not backed by all eight delivered children",
      );
    }

    const nextBeforeReconcile = this.dependencies.roadmap.children[preEvidence.delivered.length];
    const nextIssueBeforeReconcile = nextBeforeReconcile
      ? initialIssues.children.find(({ child }) => child.id === nextBeforeReconcile.id)?.issue
      : undefined;
    if (nextBeforeReconcile && !nextIssueBeforeReconcile) {
      return this.block("roadmap-set", `Expected roadmap child ${nextBeforeReconcile.id} is missing`);
    }
    const expectedBeforeReconcile = nextBeforeReconcile && nextIssueBeforeReconcile
      ? roadmapBinding(nextBeforeReconcile.seedMarker, nextIssueBeforeReconcile.number)
      : undefined;
    if (!expectedBeforeReconcile) {
      return await this.finishDeliveredRoadmap(invariantParent, preEvidence, signal);
    }
    const reconciliation = await this.dependencies.oneCli.reconcile(
      "roadmap-only",
      expectedBeforeReconcile,
      signal,
    );
    if (FAIL_CLOSED_STATES.has(reconciliation.state)) {
      return this.block("reconcile", `${reconciliation.state}: ${reconciliation.detail ?? ""}`);
    }
    if (reconciliation.state !== "unchanged") {
      return this.tickResult(reconciliation, "roadmap");
    }
    status = await this.dependencies.oneCli.status(
      "roadmap-only",
      expectedBeforeReconcile,
      signal,
    );
    const afterReconcile = blockedStatus(status);
    if (afterReconcile) return this.block("status", afterReconcile);

    const evidence = await this.roadmapEvidence(status, signal);
    if (evidence.invalidReason) return this.block("evidence", evidence.invalidReason);

    const next = this.dependencies.roadmap.children[evidence.delivered.length];
    const seeded = await seedRoadmap({
      roadmap: this.dependencies.roadmap,
      github: this.dependencies.github,
      apply: true,
      maxMutations: 1,
      activeChildId: next?.id ?? null,
      preserveClosedParent: next === undefined,
      operations: this.dependencies.seedOperations,
      ...(signal ? { signal } : {}),
    });
    if (seeded.actions.length > 0) {
      const action = seeded.actions[0]!;
      this.dependencies.journal.append("harness.seed-reconciled", {
        kind: action.kind,
        target: action.target,
        issueNumber: action.issueNumber ?? null,
      });
      return {
        action: "seed-reconcile",
        state: "succeeded",
        phase: "roadmap",
        detail: `${action.kind} ${action.target}`,
      };
    }

    const issues = await this.loadIssues(signal);
    const parent = issues.parent;
    if (!parent) return this.block("seed", "Roadmap parent is missing after reconciliation");
    if (!next) return await this.finishDeliveredRoadmap(parent, evidence, signal);

    const openReady = issues.children.filter(
      ({ issue }) => issue.state === "open" && issue.labels.includes("agent-ready"),
    );
    if (
      openReady.length !== 1 ||
      openReady[0]?.child.id !== next.id ||
      openReady[0].issue.labels.includes("parent")
    ) {
      return this.block(
        "ready-invariant",
        "Exactly the next undelivered open child must carry agent-ready",
      );
    }
    const expected = roadmapBinding(next.seedMarker, openReady[0]!.issue.number);
    const tick = await this.dependencies.oneCli.once("roadmap-only", expected, signal);
    return this.tickResult(tick, "roadmap");
  }

  private async finishDeliveredRoadmap(
    parent: HostIssue,
    evidence: { delivered: Array<{ issue: HostIssue; pull: PullEvidence }> },
    signal?: AbortSignal,
  ): Promise<HarnessTickResult> {
    const finalDelivery = evidence.delivered.at(-1);
    const finalMergeSha = finalDelivery?.pull.mergeSha;
    if (!finalDelivery || !finalMergeSha) {
      return this.block("handoff", "Final roadmap delivery evidence is incomplete");
    }
    const expected: RoadmapHandoff = {
      parentNumber: parent.number,
      finalChildIssueNumber: finalDelivery.issue.number,
      finalPullNumber: finalDelivery.pull.number,
      finalMergeSha,
      activeReleaseSha: finalMergeSha,
    };
    let handoff: RoadmapHandoff | undefined;
    let reservation: RoadmapHandoff | undefined;
    try {
      handoff = readRoadmapHandoff(this.dependencies.journal);
      reservation = readRoadmapHandoffReservation(this.dependencies.journal);
    } catch (error) {
      return this.block(
        "handoff",
        error instanceof Error ? error.message : String(error),
        "normal",
      );
    }
    const activeRelease = this.dependencies.oneCli.activeRelease();
    if (handoff) {
      if (!sameHandoff(handoff, expected)) {
        return this.block(
          "handoff",
          "Durable roadmap handoff evidence does not match current parent and final delivery",
          "normal",
        );
      }
      if (parent.state !== "closed") {
        return this.block(
          "handoff",
          "Durable roadmap handoff exists while its parent remains open",
          "normal",
        );
      }
      if (activeRelease.bootstrap || !activeRelease.sha) {
        return this.block("release", "Normal mode requires an immutable active release", "normal");
      }
      if (activeRelease.sha !== handoff.activeReleaseSha) {
        try {
          await this.dependencies.github.assertCommitDescendsFrom(
            handoff.activeReleaseSha,
            activeRelease.sha,
            signal,
          );
        } catch (error) {
          return this.block(
            "release-lineage",
            error instanceof Error ? error.message : String(error),
            "normal",
          );
        }
      }
      const normal = await this.dependencies.oneCli.once("normal", undefined, signal);
      return this.tickResult(normal, "normal");
    }
    if (activeRelease.bootstrap || activeRelease.sha !== finalMergeSha) {
      return this.block(
        "release",
        "Active immutable release must match the final delivered roadmap merge SHA at handoff",
      );
    }
    if (reservation && !sameHandoff(reservation, expected)) {
      return this.block(
        "handoff",
        "Durable roadmap handoff reservation does not match current parent and final delivery",
        "normal",
      );
    }
    if (!reservation) {
      if (parent.state === "closed") {
        return this.block(
          "handoff",
          "Closed roadmap parent is missing an exact durable handoff reservation",
          "normal",
        );
      }
      this.dependencies.journal.append("roadmap.handoff.reserved", { ...expected });
      reservation = expected;
    }
    let closedParent = false;
    if (parent.state === "open") {
      const summary = evidence.delivered
        .map((item) => `- #${item.issue.number} via PR #${item.pull.number} at ${item.pull.mergeSha}`)
        .join("\n");
      await this.dependencies.github.updateIssue(
        parent.number,
        {
          state: "closed",
          labels: [...this.dependencies.roadmap.parent.labels],
          body: `${parentBody(this.dependencies.roadmap)}\n\n## Delivery evidence\n${summary}`,
        },
        signal,
      );
      closedParent = true;
    }
    const deliveryAlreadyRecorded = this.dependencies.journal
      .read(Number.MAX_SAFE_INTEGER)
      .some((event) =>
      event.type === "harness.roadmap-delivered" &&
      event.data.parentNumber === parent.number
    );
    if (!deliveryAlreadyRecorded) {
      this.dependencies.journal.append("harness.roadmap-delivered", {
        parentNumber: parent.number,
        children: evidence.delivered.length,
      });
    }
    this.dependencies.journal.append("roadmap.handoff.completed", { ...reservation });
    if (!closedParent && deliveryAlreadyRecorded) {
      return this.block(
        "handoff",
        "Recovered an interrupted completed parent handoff; normal execution resumes next tick",
        "normal",
      );
    }
    return {
      action: closedParent ? "close-parent" : "complete-handoff",
      state: "succeeded",
      phase: "roadmap",
      detail: closedParent
        ? `Closed roadmap parent #${parent.number} with delivery evidence`
        : `Reconciled closed roadmap parent #${parent.number} into completed handoff`,
    };
  }

  private async roadmapEvidence(
    status: AutonomyStatus,
    signal?: AbortSignal,
  ): Promise<{
    delivered: Array<{ issue: HostIssue; pull: PullEvidence }>;
    invalidReason?: string;
  }> {
    const issues = await this.loadIssues(signal);
    const delivered: Array<{ issue: HostIssue; pull: PullEvidence }> = [];
    for (const [index, entry] of issues.children.entries()) {
      if (entry.child.id !== this.dependencies.roadmap.children[index]?.id) {
        return entry.issue.state === "closed"
          ? { delivered, invalidReason: "Roadmap children closed out of dependency order" }
          : { delivered };
      }
      if (entry.issue.state === "open") break;
      const pull = await this.dependencies.github.findMergedPullForIssue(
        entry.issue.number,
        signal,
      );
      const attempt = status.attempts.find(
        (candidate) => candidate.issueId === `github-${entry.issue.number}`,
      );
      if (
        !pull ||
        attempt?.state !== "succeeded" ||
        attempt.prNumber !== pull.number ||
        attempt.detail?.postMergeVerified !== true ||
        !Array.isArray(attempt.detail.postMergeDogfood) ||
        attempt.detail.postMergeDogfood.length === 0 ||
        !attempt.detail.releaseEvidence
      ) {
        return {
          delivered,
          invalidReason:
            `Closed child #${entry.issue.number} lacks merged PR, local success, ` +
            "post-merge dogfood, or release evidence",
        };
      }
      delivered.push({ issue: entry.issue, pull });
    }
    if (issues.children.slice(delivered.length).some(({ issue }) => issue.state === "closed")) {
      return { delivered, invalidReason: "Roadmap children closed out of dependency order" };
    }
    return { delivered };
  }

  private async loadIssues(signal?: AbortSignal): Promise<{
    parent?: HostIssue;
    children: Array<{ child: Roadmap["children"][number]; issue: HostIssue }>;
  }> {
    const [roadmapLabeled, markerIssues] = await Promise.all([
      this.dependencies.github.listRoadmapIssues(signal),
      this.dependencies.github.listSeedMarkerIssues(signal),
    ]);
    const inventory = new Map<number, HostIssue>();
    for (const issue of [...roadmapLabeled, ...markerIssues]) inventory.set(issue.number, issue);
    const accepted = new Set([
      this.dependencies.roadmap.parent.seedMarker,
      ...this.dependencies.roadmap.children.map((child) => child.seedMarker),
    ]);
    for (const issue of inventory.values()) {
      const markers = seedMarkers(issue.body);
      if (
        markers.length !== 1 ||
        !accepted.has(markers[0]!) ||
        (issue.labels.includes("cold-start-roadmap") &&
          markers[0] === this.dependencies.roadmap.parent.seedMarker)
      ) {
        throw new Error(
          `Unknown or ambiguous cold-start roadmap issue #${issue.number} is outside the manifest`,
        );
      }
    }
    const parentMatches = [...inventory.values()].filter((issue) =>
      issue.body.includes(this.dependencies.roadmap.parent.seedMarker)
    );
    if (parentMatches.length > 1) throw new Error("Roadmap parent marker is duplicated");
    const parent = parentMatches[0];
    const children: Array<{
      child: Roadmap["children"][number];
      issue: HostIssue;
    }> = [];
    for (const child of this.dependencies.roadmap.children) {
      const matches = [...inventory.values()].filter((issue) =>
        issue.body.includes(child.seedMarker)
      );
      if (matches.length > 1) throw new Error(`Roadmap marker is duplicated: ${child.seedMarker}`);
      if (matches[0]) children.push({ child, issue: matches[0] });
    }
    return { ...(parent ? { parent } : {}), children };
  }

  private tickResult(
    tick: TickOutput,
    phase: HarnessTickResult["phase"],
  ): HarnessTickResult {
    if (tick.state === "waiting_evidence") {
      this.dependencies.journal.append("harness.recovery-pending", {
        phase,
        action: tick.action,
        attemptId: tick.attemptId ?? null,
      });
      return {
        action: tick.action,
        state: "parked",
        phase,
        lane: "recovery",
        detail: tick.detail ?? "Machine recovery evidence will be collected on the next tick",
      };
    }
    if (tick.state === "failed") {
      this.dependencies.journal.append("harness.recovery-exhausted", {
        phase,
        action: tick.action,
        attemptId: tick.attemptId ?? null,
      });
      return {
        action: tick.action,
        state: "quarantined",
        phase,
        lane: "recovery",
        detail: tick.detail ?? "Recovery limit reached; remediation will reconcile next",
      };
    }
    const blocked = FAIL_CLOSED_STATES.has(tick.state);
    this.dependencies.journal.append(
      blocked ? "harness.tick-blocked" : "harness.tick-completed",
      {
        phase,
        action: tick.action,
        state: tick.state,
        attemptId: tick.attemptId ?? null,
        detail: tick.detail ?? null,
      },
    );
    return {
      action: tick.action,
      state: blocked ? "blocked" : tick.state === "idle" ? "idle" : "succeeded",
      phase,
      lane: phase,
      detail: tick.detail ?? tick.state,
    };
  }

  private block(
    action: string,
    detail: string,
    phase: HarnessTickResult["phase"] = "roadmap",
  ): HarnessTickResult {
    this.dependencies.journal.append("harness.fail-closed", { action, detail });
    return { action, state: "blocked", phase, lane: phase, detail };
  }
}

export function readRoadmapHandoff(journal: HostJournal): RoadmapHandoff | undefined {
  const events = journal.read(Number.MAX_SAFE_INTEGER);
  const handoffs = events.filter((event) => event.type === "roadmap.handoff.completed");
  if (handoffs.length > 1) throw new Error("Durable roadmap handoff evidence is duplicated");
  if (handoffs.length === 0) {
    if (events.some(isNormalTickEvent)) {
      throw new Error("Durable roadmap handoff evidence is missing after normal execution");
    }
    return undefined;
  }
  return parseRoadmapHandoff(handoffs[0]!);
}

export function readRoadmapHandoffReservation(
  journal: HostJournal,
): RoadmapHandoff | undefined {
  const reservations = journal
    .read(Number.MAX_SAFE_INTEGER)
    .filter((event) => event.type === "roadmap.handoff.reserved");
  if (reservations.length > 1) {
    throw new Error("Durable roadmap handoff reservation is duplicated");
  }
  return reservations[0] ? parseRoadmapHandoff(reservations[0]) : undefined;
}

function blockedStatus(status: AutonomyStatus): string | undefined {
  if (!status.activeAttempt || !FAIL_CLOSED_STATES.has(status.activeAttempt.state)) {
    return undefined;
  }
  return `Active attempt ${status.activeAttempt.id} is ${status.activeAttempt.state}`;
}

function seedMarkers(body: string): string[] {
  return [...new Set(
    [...body.matchAll(/<!-- one-cli:cold-start-seed:[^>\r\n]* -->/gu)]
      .map((match) => match[0]),
  )];
}

function roadmapBinding(seedMarker: string, issueNumber: number): ExpectedRoadmapBinding {
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
    throw new Error("Expected roadmap issue number is invalid");
  }
  return { seedMarker, issueNumber };
}

function parseRoadmapHandoff(event: JournalEvent): RoadmapHandoff {
  const keys = Object.keys(event.data).sort();
  const expectedKeys = [
    "activeReleaseSha",
    "finalChildIssueNumber",
    "finalMergeSha",
    "finalPullNumber",
    "parentNumber",
  ];
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new Error("Durable roadmap handoff evidence has an invalid shape");
  }
  const {
    parentNumber,
    finalChildIssueNumber,
    finalPullNumber,
    finalMergeSha,
    activeReleaseSha,
  } = event.data;
  if (
    !positiveNumber(parentNumber) ||
    !positiveNumber(finalChildIssueNumber) ||
    !positiveNumber(finalPullNumber) ||
    typeof finalMergeSha !== "string" ||
    !SHA.test(finalMergeSha) ||
    typeof activeReleaseSha !== "string" ||
    !SHA.test(activeReleaseSha) ||
    activeReleaseSha !== finalMergeSha
  ) {
    throw new Error("Durable roadmap handoff evidence is invalid");
  }
  return {
    parentNumber,
    finalChildIssueNumber,
    finalPullNumber,
    finalMergeSha,
    activeReleaseSha,
  };
}

function sameHandoff(left: RoadmapHandoff, right: RoadmapHandoff): boolean {
  return Object.keys(right).every((key) =>
    left[key as keyof RoadmapHandoff] === right[key as keyof RoadmapHandoff]
  );
}

function isNormalTickEvent(event: JournalEvent): boolean {
  return (
    (event.type === "harness.tick-completed" || event.type === "harness.tick-blocked") &&
    event.data.phase === "normal"
  );
}

function positiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
