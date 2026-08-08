import type { LeaseGrant } from "./domain.js";
import type { AutonomyStore } from "./store.js";

export class LeaseConflictError extends Error {
  constructor(resource: string) {
    super(`Lease for "${resource}" is held by another owner`);
    this.name = "LeaseConflictError";
  }
}

export class LeaseLostError extends Error {
  constructor(resource: string) {
    super(`Lease for "${resource}" is expired, released, or fenced`);
    this.name = "LeaseLostError";
  }
}

/**
 * A small clock-aware facade over the durable lease operations.
 *
 * The returned fence must accompany any externally visible work. A stale
 * owner cannot heartbeat or release a lease after a newer owner takes over.
 */
export class LeaseCoordinator {
  constructor(
    private readonly store: AutonomyStore,
    private readonly now: () => number = Date.now,
  ) {}

  acquire(resource: string, owner: string, ttlMs: number): LeaseGrant {
    return this.store.acquireLease({ resource, owner, ttlMs, now: this.now() });
  }

  acquireCoordinator(repoId: string, owner: string, ttlMs: number): LeaseGrant {
    return this.acquire(exactResource("coordinator", repoId), owner, ttlMs);
  }

  acquireIssue(issueId: string, owner: string, ttlMs: number): LeaseGrant {
    return this.acquire(exactResource("issue", issueId), owner, ttlMs);
  }

  heartbeat(grant: LeaseGrant, ttlMs: number): LeaseGrant {
    return this.store.heartbeatLease({
      resource: grant.resource,
      owner: grant.owner,
      fence: grant.fence,
      ttlMs,
      now: this.now(),
    });
  }

  release(grant: LeaseGrant): boolean {
    return this.store.releaseLease({
      resource: grant.resource,
      owner: grant.owner,
      fence: grant.fence,
      now: this.now(),
    });
  }
}

function exactResource(kind: "coordinator" | "issue", id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(id)) {
    throw new Error(`${kind} lease id is invalid`);
  }
  return `${kind}:${id}`;
}
