import type { AutonomyConfig } from "./config.js";
import type { JsonValue, LeaseGrant } from "./domain.js";
import type { AutonomyStore } from "./store.js";

export const GLOBAL_DOGFOOD_INTERVAL_MS = 24 * 60 * 60_000;
export const COMMUNITY_SCAN_INTERVAL_MS = 2 * 60 * 60_000;
export const COMMUNITY_SCAN_MAX_LATENESS_MS = 60 * 60_000;
export const DEFAULT_SCHEDULE_ACTION_TTL_MS = 30 * 60_000;

export const SCHEDULE_PRIORITY = [
  "reconcile",
  "active-issue",
  "user-promotion",
  "post-merge-dogfood",
  "global-dogfood",
  "gap-promotion",
  "ready-issue",
  "community-scan",
] as const;

export type ScheduledActionKind = (typeof SCHEDULE_PRIORITY)[number];
export type RecurringScheduledActionKind = "global-dogfood" | "community-scan";

export interface ScheduleDueTimestamps {
  postMergeDogfood?: number;
  globalDogfood: number;
  communityScan: number;
}

export interface ScheduleInputs {
  now: number;
  reconcileRequired: boolean;
  due: ScheduleDueTimestamps;
  hasActiveIssue: boolean;
  hasPromotableUserIssue: boolean;
  hasPromotableGap?: boolean;
  hasReadyIssue?: boolean;
  actionInProgress?: ScheduledActionKind;
}

export interface ScheduledAction {
  kind: ScheduledActionKind;
  dueAt: number;
  idempotencyKey: string;
  marker: string;
}

export interface ScheduleClaim {
  action: ScheduledAction;
  lease: LeaseGrant;
}

export interface SchedulerNextInput {
  now?: number;
  initializeDue?: boolean;
  reconcileRequired?: boolean;
  postMergeDogfoodDueAt?: number;
  hasActiveIssue?: boolean;
  hasPromotableUserIssue?: boolean;
  hasPromotableGap?: boolean;
  hasReadyIssue?: boolean;
}

const SCHEDULE_AGGREGATE = "autonomy-schedule";
const SCHEDULE_LEASE = "autonomy:schedule:action";

export function computeNextScheduledAction(input: ScheduleInputs): ScheduledAction | undefined {
  const now = timestamp(input.now, "schedule time");
  if (input.actionInProgress !== undefined) return undefined;
  if (input.reconcileRequired) return scheduled("reconcile", now);
  if (input.hasActiveIssue) return scheduled("active-issue", now);
  if (input.hasPromotableUserIssue) return scheduled("user-promotion", now);
  if (
    input.due.postMergeDogfood !== undefined &&
    timestamp(input.due.postMergeDogfood, "post-merge dogfood due time") <= now
  ) {
    return scheduled("post-merge-dogfood", input.due.postMergeDogfood);
  }
  if (timestamp(input.due.globalDogfood, "global dogfood due time") <= now) {
    return scheduled("global-dogfood", input.due.globalDogfood);
  }
  if (
    timestamp(input.due.communityScan, "community scan due time") +
      COMMUNITY_SCAN_MAX_LATENESS_MS <=
    now
  ) {
    return scheduled("community-scan", input.due.communityScan);
  }
  if (input.hasPromotableGap === true) return scheduled("gap-promotion", now);
  if (input.hasReadyIssue === true) return scheduled("ready-issue", now);
  if (timestamp(input.due.communityScan, "community scan due time") <= now) {
    return scheduled("community-scan", input.due.communityScan);
  }
  return undefined;
}

export function nextDueAt(completedAt: number, intervalMs: number): number {
  const completed = timestamp(completedAt, "completion time");
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    throw new Error("Schedule interval must be a positive integer");
  }
  return completed + intervalMs;
}

export function scheduleMarker(kind: ScheduledActionKind, dueAt: number): string {
  return `<!-- one-cli:schedule:${kind}:due:${timestamp(dueAt, "due time")} -->`;
}

export function readScheduleDueTimestamps(
  store: AutonomyStore,
  defaults: { globalDogfood: number; communityScan: number },
): ScheduleDueTimestamps {
  const due: ScheduleDueTimestamps = {
    globalDogfood: timestamp(defaults.globalDogfood, "default global dogfood due time"),
    communityScan: timestamp(defaults.communityScan, "default community scan due time"),
  };
  for (const event of store.listEvents({ aggregateType: SCHEDULE_AGGREGATE })) {
    const data = object(event.data);
    const dueAt = optionalTimestamp(data.dueAt);
    if (dueAt === undefined) continue;
    if (event.type === "schedule.global-dogfood.due") due.globalDogfood = dueAt;
    if (event.type === "schedule.community-scan.due") due.communityScan = dueAt;
    if (event.type === "schedule.post-merge-dogfood.due") due.postMergeDogfood = dueAt;
    if (event.type === "schedule.post-merge-dogfood.completed") {
      delete due.postMergeDogfood;
    }
  }
  return due;
}

export class AutonomyScheduler {
  private readonly owner: string;
  private readonly actionTtlMs: number;

  constructor(
    private readonly store: AutonomyStore,
    readonly config: AutonomyConfig,
    options: { owner?: string; actionTtlMs?: number } = {},
  ) {
    this.owner = options.owner ?? `scheduler:${config.repoKey}`;
    this.actionTtlMs = options.actionTtlMs ?? DEFAULT_SCHEDULE_ACTION_TTL_MS;
    if (!Number.isSafeInteger(this.actionTtlMs) || this.actionTtlMs <= 0) {
      throw new Error("Scheduler action TTL must be a positive integer");
    }
  }

  ensureDueTimestamps(now = Date.now()): ScheduleDueTimestamps {
    const at = timestamp(now, "schedule time");
    const existing = this.scheduleEvents();
    if (!existing.some((event) => event.type === "schedule.global-dogfood.due")) {
      this.setRecurringDue("global-dogfood", at + GLOBAL_DOGFOOD_INTERVAL_MS, at);
    }
    if (!existing.some((event) => event.type === "schedule.community-scan.due")) {
      this.setRecurringDue("community-scan", at + this.communityScanIntervalMs(), at);
    }
    return this.due(at);
  }

  due(now = Date.now(), postMergeDogfoodDueAt?: number): ScheduleDueTimestamps {
    const at = timestamp(now, "schedule time");
    const due = readScheduleDueTimestamps(this.store, {
      globalDogfood: at + GLOBAL_DOGFOOD_INTERVAL_MS,
      communityScan: at + COMMUNITY_SCAN_INTERVAL_MS,
    });
    if (postMergeDogfoodDueAt !== undefined) {
      due.postMergeDogfood = timestamp(postMergeDogfoodDueAt, "post-merge dogfood due time");
    }
    return due;
  }

  schedulePostMergeDogfood(
    deliveryId: string,
    dueAt: number,
    now = Date.now(),
  ): ScheduleDueTimestamps {
    const id = requiredId(deliveryId, "post-merge delivery id");
    const due = timestamp(dueAt, "post-merge dogfood due time");
    const at = timestamp(now, "schedule time");
    const key = `schedule:post-merge-dogfood:${id}:due:${due}`;
    const reservation = this.store.reserveOperation({
      id: operationId(key),
      idempotencyKey: key,
      kind: "schedule.post-merge-dogfood",
      request: { deliveryId: id, dueAt: due, marker: scheduleMarker("post-merge-dogfood", due) },
    });
    if (reservation.created) {
      this.store.appendEvent({
        aggregateType: SCHEDULE_AGGREGATE,
        aggregateId: this.config.repoKey,
        type: "schedule.post-merge-dogfood.due",
        data: { deliveryId: id, dueAt: due },
        createdAt: at,
      });
      this.store.reconcileOperation({
        idempotencyKey: key,
        state: "succeeded",
        result: { deliveryId: id, dueAt: due },
        now: at,
      });
    }
    return this.due(at);
  }

  next(input: SchedulerNextInput = {}): ScheduledAction | undefined {
    const now = timestamp(input.now ?? Date.now(), "schedule time");
    const due =
      input.initializeDue === false ? this.due(now) : this.ensureDueTimestamps(now);
    if (input.postMergeDogfoodDueAt !== undefined) {
      due.postMergeDogfood = timestamp(
        input.postMergeDogfoodDueAt,
        "post-merge dogfood due time",
      );
    }
    const activeAttempt = this.store.getActiveAttempt();
    const actionInProgress = this.runningAction(now);
    return computeNextScheduledAction({
      now,
      reconcileRequired:
        input.reconcileRequired ?? this.store.listPendingOutbox(1).length > 0,
      due,
      hasActiveIssue: input.hasActiveIssue ?? activeAttempt !== undefined,
      hasPromotableUserIssue: input.hasPromotableUserIssue ?? false,
      hasPromotableGap: input.hasPromotableGap ?? false,
      hasReadyIssue: input.hasReadyIssue ?? false,
      ...(actionInProgress === undefined ? {} : { actionInProgress }),
    });
  }

  claim(action: ScheduledAction, now = Date.now()): ScheduleClaim {
    const at = timestamp(now, "schedule time");
    if (this.runningAction(at) !== undefined) {
      throw new Error("A scheduled action is already in progress");
    }
    const lease = this.store.acquireLease({
      resource: SCHEDULE_LEASE,
      owner: this.owner,
      ttlMs: this.actionTtlMs,
      now: at,
    });
    this.store.appendEvent({
      aggregateType: SCHEDULE_AGGREGATE,
      aggregateId: this.config.repoKey,
      type: "schedule.action.started",
      data: {
        kind: action.kind,
        dueAt: action.dueAt,
        idempotencyKey: action.idempotencyKey,
        marker: action.marker,
        owner: lease.owner,
        fence: lease.fence,
        expiresAt: lease.expiresAt,
      },
      createdAt: at,
    });
    return { action, lease };
  }

  renew(claim: ScheduleClaim, now = Date.now()): ScheduleClaim {
    if (claim.lease.owner !== this.owner) throw new Error("Schedule claim belongs to another owner");
    return {
      action: claim.action,
      lease: this.store.heartbeatLease({
        resource: claim.lease.resource,
        owner: claim.lease.owner,
        fence: claim.lease.fence,
        ttlMs: this.actionTtlMs,
        now: timestamp(now, "schedule heartbeat time"),
      }),
    };
  }

  complete(claim: ScheduleClaim, now = Date.now()): void {
    const at = timestamp(now, "schedule completion time");
    if (claim.lease.owner !== this.owner) throw new Error("Schedule claim belongs to another owner");
    const liveLease = this.store.heartbeatLease({
      resource: claim.lease.resource,
      owner: claim.lease.owner,
      fence: claim.lease.fence,
      ttlMs: this.actionTtlMs,
      now: at,
    });
    if (claim.action.kind === "global-dogfood") {
      this.setRecurringDue("global-dogfood", at + GLOBAL_DOGFOOD_INTERVAL_MS, at);
    }
    if (claim.action.kind === "community-scan") {
      this.setRecurringDue("community-scan", at + this.communityScanIntervalMs(), at);
    }
    if (claim.action.kind === "post-merge-dogfood") {
      this.store.appendEvent({
        aggregateType: SCHEDULE_AGGREGATE,
        aggregateId: this.config.repoKey,
        type: "schedule.post-merge-dogfood.completed",
        data: { dueAt: claim.action.dueAt },
        createdAt: at,
      });
    }
    this.store.appendEvent({
      aggregateType: SCHEDULE_AGGREGATE,
      aggregateId: this.config.repoKey,
      type: "schedule.action.completed",
      data: {
        kind: claim.action.kind,
        idempotencyKey: claim.action.idempotencyKey,
        owner: claim.lease.owner,
        fence: claim.lease.fence,
      },
      createdAt: at,
    });
    if (!this.store.releaseLease({ ...liveLease, now: at })) {
      throw new Error("Scheduled action lease was lost before completion");
    }
  }

  /**
   * Releases a claimed action without advancing its due timestamp. This is
   * used when optional runtime capability (for example ResearchPort) is absent.
   */
  defer(claim: ScheduleClaim, reason: string, now = Date.now()): void {
    const at = timestamp(now, "schedule defer time");
    if (claim.lease.owner !== this.owner) throw new Error("Schedule claim belongs to another owner");
    const liveLease = this.store.heartbeatLease({
      resource: claim.lease.resource,
      owner: claim.lease.owner,
      fence: claim.lease.fence,
      ttlMs: this.actionTtlMs,
      now: at,
    });
    this.store.appendEvent({
      aggregateType: SCHEDULE_AGGREGATE,
      aggregateId: this.config.repoKey,
      type: "schedule.action.deferred",
      data: {
        kind: claim.action.kind,
        idempotencyKey: claim.action.idempotencyKey,
        reason: reason.slice(0, 2_000),
        owner: claim.lease.owner,
        fence: claim.lease.fence,
      },
      createdAt: at,
    });
    if (!this.store.releaseLease({ ...liveLease, now: at })) {
      throw new Error("Scheduled action lease was lost before defer");
    }
  }

  private setRecurringDue(
    kind: RecurringScheduledActionKind,
    dueAt: number,
    now: number,
  ): void {
    const due = timestamp(dueAt, `${kind} due time`);
    this.store.appendEvent({
      aggregateType: SCHEDULE_AGGREGATE,
      aggregateId: this.config.repoKey,
      type: `schedule.${kind}.due`,
      data: { dueAt: due, marker: scheduleMarker(kind, due) },
      createdAt: timestamp(now, "schedule time"),
    });
  }

  private communityScanIntervalMs(): number {
    const minutes = this.config.community?.monitoring?.intervalMinutes;
    return minutes === undefined ? COMMUNITY_SCAN_INTERVAL_MS : minutes * 60_000;
  }

  private runningAction(now: number): ScheduledActionKind | undefined {
    let running:
      | { kind: ScheduledActionKind; idempotencyKey: string; expiresAt: number }
      | undefined;
    for (const event of this.scheduleEvents()) {
      const data = object(event.data);
      if (event.type === "schedule.action.started") {
        const kind = scheduledKind(data.kind);
        const idempotencyKey =
          typeof data.idempotencyKey === "string" ? data.idempotencyKey : undefined;
        const expiresAt = optionalTimestamp(data.expiresAt);
        if (kind && idempotencyKey && expiresAt !== undefined) {
          running = { kind, idempotencyKey, expiresAt };
        }
      }
      if (
        (event.type === "schedule.action.completed" ||
          event.type === "schedule.action.deferred") &&
        running !== undefined &&
        data.idempotencyKey === running.idempotencyKey
      ) {
        running = undefined;
      }
    }
    return running !== undefined && running.expiresAt > now ? running.kind : undefined;
  }

  private scheduleEvents() {
    return this.store.listEvents({
      aggregateType: SCHEDULE_AGGREGATE,
      aggregateId: this.config.repoKey,
    });
  }
}

export function createAutonomyScheduler(
  store: AutonomyStore,
  config: AutonomyConfig,
  options: { owner?: string; actionTtlMs?: number } = {},
): AutonomyScheduler {
  return new AutonomyScheduler(store, config, options);
}

function scheduled(kind: ScheduledActionKind, dueAt: number): ScheduledAction {
  const due = timestamp(dueAt, "due time");
  const idempotencyKey = `schedule:${kind}:due:${due}`;
  return {
    kind,
    dueAt: due,
    idempotencyKey,
    marker: scheduleMarker(kind, due),
  };
}

function scheduledKind(value: JsonValue | undefined): ScheduledActionKind | undefined {
  return typeof value === "string" &&
    (SCHEDULE_PRIORITY as readonly string[]).includes(value)
    ? (value as ScheduledActionKind)
    : undefined;
}

function object(value: JsonValue): Record<string, JsonValue> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return { ...(value as Readonly<Record<string, JsonValue>>) };
}

function optionalTimestamp(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function timestamp(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a timestamp`);
  return value;
}

function requiredId(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 256 || !/^[A-Za-z0-9._:/#-]+$/u.test(trimmed)) {
    throw new Error(`${label} is invalid`);
  }
  return trimmed;
}

function operationId(key: string): string {
  let hash = 2_166_136_261;
  for (const character of key) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return `schedule-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
