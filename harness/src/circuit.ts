/**
 * Bounded open/closed circuit for flapping GitHub or provider errors so the
 * durable harness loop parks instead of busy-ticking.
 */
export class ServiceCircuit {
  private failures = 0;
  private openUntil = 0;

  constructor(
    private readonly options: {
      readonly failureThreshold?: number;
      readonly openMs?: number;
      readonly now?: () => number;
    } = {},
  ) {}

  recordSuccess(): void {
    this.failures = 0;
    this.openUntil = 0;
  }

  recordFailure(): void {
    const now = this.options.now?.() ?? Date.now();
    this.failures += 1;
    const threshold = this.options.failureThreshold ?? 3;
    if (this.failures >= threshold) {
      const openMs = this.options.openMs ?? 5 * 60_000;
      this.openUntil = Math.max(this.openUntil, now + openMs);
    }
  }

  isOpen(): boolean {
    const now = this.options.now?.() ?? Date.now();
    if (this.openUntil <= now) {
      if (this.openUntil > 0) {
        // Half-open: allow one probe after the window.
        this.openUntil = 0;
      }
      return false;
    }
    return true;
  }

  nextAttemptAt(): number | undefined {
    const now = this.options.now?.() ?? Date.now();
    return this.openUntil > now ? this.openUntil : undefined;
  }

  snapshot(): { failures: number; openUntil: number; open: boolean } {
    const now = this.options.now?.() ?? Date.now();
    return {
      failures: this.failures,
      openUntil: this.openUntil,
      // Snapshot must not mutate half-open state; use isOpen() for probe semantics.
      open: this.openUntil > now,
    };
  }
}

export function isTransientInfrastructureMessage(detail: string): boolean {
  return /\b(?:network|timed? ?out|rate.?limit|temporar|ECONN|EAI_AGAIN|429|504|503|502|provider temporarily|service temporarily|This operation was aborted)\b/iu
    .test(detail);
}
