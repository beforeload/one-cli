import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FailureClass, RepairPlaybook } from "../../src/autonomy/domain.js";
import {
  DEFAULT_PRIORITY_RATE,
  DEMOTION_MAX_SUCCESS_RATE,
  DEMOTION_MIN_ATTEMPTS,
  isDemoted,
  playbookKey,
  type PlaybookStore,
  rankStrategies,
  recordRepairOutcome,
  successRate,
} from "../../src/autonomy/playbook.js";
import { AutonomyStore } from "../../src/autonomy/store.js";
import { makeTempDir, removeTempDir } from "../helpers.js";

/**
 * Fake in-memory {@link PlaybookStore} that mirrors AutonomyStore's upsert
 * semantics (INSERT ... ON CONFLICT DO UPDATE) with zero SQLite / FS, so the
 * pure statistics layer can be exercised deterministically.
 */
class FakePlaybookStore implements PlaybookStore {
  private readonly rows = new Map<string, RepairPlaybook>();

  recordRepairPlaybookOutcome(input: {
    playbookKey: string;
    failureClass: FailureClass;
    strategy: string;
    success: boolean;
    now?: number;
  }): RepairPlaybook {
    const now = input.now ?? 0;
    const existing = this.rows.get(input.playbookKey);
    const next: RepairPlaybook = {
      schema: "autonomy.one-cli/repair-playbook-v1",
      playbookKey: input.playbookKey,
      failureClass: input.failureClass,
      strategy: input.strategy,
      appliedCount: (existing?.appliedCount ?? 0) + 1,
      successCount: (existing?.successCount ?? 0) + (input.success ? 1 : 0),
      lastAppliedAt: now,
      lastOutcome: input.success ? "applied" : "abandoned",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.rows.set(input.playbookKey, next);
    return next;
  }

  getRepairPlaybook(key: string): RepairPlaybook | undefined {
    return this.rows.get(key);
  }

  listRepairPlaybooks(options: { failureClass?: FailureClass; limit?: number } = {}): RepairPlaybook[] {
    let all = [...this.rows.values()];
    if (options.failureClass !== undefined) {
      all = all.filter((p) => p.failureClass === options.failureClass);
    }
    all.sort((a, b) => b.appliedCount - a.appliedCount || a.updatedAt - b.updatedAt);
    return options.limit === undefined ? all : all.slice(0, options.limit);
  }
}

function seed(
  store: PlaybookStore,
  failureClass: FailureClass,
  strategy: string,
  applied: number,
  success: number,
): void {
  for (let i = 0; i < applied; i++) {
    recordRepairOutcome(store, { failureClass, strategy, success: i < success, now: i + 1 });
  }
}

describe("playbook: pure statistics helpers", () => {
  it("playbookKey joins failureClass and strategy source", () => {
    expect(playbookKey("lint", "package.json:lint:fix")).toBe("lint:package.json:lint:fix");
    expect(playbookKey("dependency", "pnpm-lock.yaml")).toBe("dependency:pnpm-lock.yaml");
    expect(playbookKey("typecheck", "agent")).toBe("typecheck:agent");
  });

  describe("successRate", () => {
    it("is 0 when never applied", () => {
      expect(successRate({ appliedCount: 0, successCount: 0 })).toBe(0);
    });

    it("is successCount / appliedCount", () => {
      expect(successRate({ appliedCount: 3, successCount: 1 })).toBeCloseTo(1 / 3);
      expect(successRate({ appliedCount: 4, successCount: 4 })).toBe(1);
      expect(successRate({ appliedCount: 2, successCount: 1 })).toBe(0.5);
    });
  });

  describe("isDemoted", () => {
    it("does not demote below DEMOTION_MIN_ATTEMPTS even with 0 success", () => {
      expect(isDemoted({ appliedCount: DEMOTION_MIN_ATTEMPTS - 1, successCount: 0 })).toBe(false);
    });

    it("demotes at threshold attempts with a low success rate", () => {
      // 3 applied, 1 success => rate 1/3 == DEMOTION_MAX_SUCCESS_RATE (boundary, inclusive)
      expect(isDemoted({ appliedCount: DEMOTION_MIN_ATTEMPTS, successCount: 1 })).toBe(true);
      expect(isDemoted({ appliedCount: 5, successCount: 0 })).toBe(true);
    });

    it("does not demote a strategy with a high success rate", () => {
      // 3 applied, 2 success => rate 2/3 > DEMOTION_MAX_SUCCESS_RATE
      expect(isDemoted({ appliedCount: 3, successCount: 2 })).toBe(false);
      expect(isDemoted({ appliedCount: 10, successCount: 9 })).toBe(false);
    });

    it("boundary: just above DEMOTION_MAX_SUCCESS_RATE is not demoted", () => {
      // 4 applied, 2 success => rate 0.5 > 1/3
      expect(isDemoted({ appliedCount: 4, successCount: 2 })).toBe(false);
    });

    it("constants have the documented values", () => {
      expect(DEMOTION_MIN_ATTEMPTS).toBe(3);
      expect(DEMOTION_MAX_SUCCESS_RATE).toBeCloseTo(1 / 3);
      expect(DEFAULT_PRIORITY_RATE).toBe(0.5);
    });
  });
});

describe("recordRepairOutcome", () => {
  it("increments appliedCount and successCount on success", () => {
    const store = new FakePlaybookStore();
    const pb = recordRepairOutcome(store, {
      failureClass: "lint",
      strategy: "package.json:lint:fix",
      success: true,
      now: 100,
    });
    expect(pb.playbookKey).toBe("lint:package.json:lint:fix");
    expect(pb.appliedCount).toBe(1);
    expect(pb.successCount).toBe(1);
    expect(pb.lastOutcome).toBe("applied");
  });

  it("increments only appliedCount on failure", () => {
    const store = new FakePlaybookStore();
    const pb = recordRepairOutcome(store, {
      failureClass: "lint",
      strategy: "package.json:lint:fix",
      success: false,
      now: 100,
    });
    expect(pb.appliedCount).toBe(1);
    expect(pb.successCount).toBe(0);
    expect(pb.lastOutcome).toBe("abandoned");
  });

  it("accumulates across multiple applications of the same key", () => {
    const store = new FakePlaybookStore();
    recordRepairOutcome(store, { failureClass: "typecheck", strategy: "agent", success: true, now: 1 });
    recordRepairOutcome(store, { failureClass: "typecheck", strategy: "agent", success: false, now: 2 });
    const pb = recordRepairOutcome(store, {
      failureClass: "typecheck",
      strategy: "agent",
      success: true,
      now: 3,
    });
    expect(pb.appliedCount).toBe(3);
    expect(pb.successCount).toBe(2);
    expect(successRate(pb)).toBeCloseTo(2 / 3);
    // distinct keys stay separate
    const other = recordRepairOutcome(store, {
      failureClass: "lint",
      strategy: "agent",
      success: true,
      now: 4,
    });
    expect(other.appliedCount).toBe(1);
  });
});

describe("rankStrategies", () => {
  const candidates = [
    { source: "a" },
    { source: "b" },
    { source: "c" },
  ] as const;

  it("preserves original order when there is no history (stable default)", () => {
    const store = new FakePlaybookStore();
    const ranked = rankStrategies(store, "lint", candidates);
    expect(ranked.map((c) => c.source)).toEqual(["a", "b", "c"]);
  });

  it("sorts higher success rate first", () => {
    const store = new FakePlaybookStore();
    // b: 2/2 = 1.0 (above default), a: no history = 0.5 default, c untouched
    seed(store, "lint", "b", 2, 2);
    const ranked = rankStrategies(store, "lint", candidates);
    expect(ranked.map((c) => c.source)).toEqual(["b", "a", "c"]);
  });

  it("pushes demoted strategies to the back regardless of raw rate", () => {
    const store = new FakePlaybookStore();
    // a: demoted (3 applied, 0 success) => score -1, last
    seed(store, "lint", "a", 3, 0);
    // c: proven good 3/3 => first
    seed(store, "lint", "c", 3, 3);
    // b: no history => default middle
    const ranked = rankStrategies(store, "lint", candidates);
    expect(ranked.map((c) => c.source)).toEqual(["c", "b", "a"]);
  });

  it("keys are per failureClass — history for another class does not leak", () => {
    const store = new FakePlaybookStore();
    seed(store, "build", "a", 3, 0); // demoted under build, irrelevant to lint
    const ranked = rankStrategies(store, "lint", candidates);
    expect(ranked.map((c) => c.source)).toEqual(["a", "b", "c"]);
  });

  it("does not mutate the input candidates array", () => {
    const store = new FakePlaybookStore();
    seed(store, "lint", "c", 2, 2);
    const input = [...candidates];
    rankStrategies(store, "lint", input);
    expect(input.map((c) => c.source)).toEqual(["a", "b", "c"]);
  });
});

describe("recordRepairOutcome + rankStrategies against a real AutonomyStore", () => {
  let root: string;
  let store: AutonomyStore;

  beforeEach(() => {
    root = makeTempDir("autonomy-playbook");
    store = new AutonomyStore(path.join(root, "state.sqlite"));
  });

  afterEach(() => {
    store.close();
    removeTempDir(root);
  });

  it("persists a round-trip readable via getRepairPlaybook", () => {
    recordRepairOutcome(store, { failureClass: "lint", strategy: "agent", success: true, now: 10 });
    recordRepairOutcome(store, { failureClass: "lint", strategy: "agent", success: false, now: 20 });

    const pb = store.getRepairPlaybook(playbookKey("lint", "agent"));
    expect(pb).toBeDefined();
    expect(pb).toMatchObject({
      schema: "autonomy.one-cli/repair-playbook-v1",
      playbookKey: "lint:agent",
      failureClass: "lint",
      strategy: "agent",
      appliedCount: 2,
      successCount: 1,
      lastAppliedAt: 20,
      lastOutcome: "abandoned",
      createdAt: 10,
      updatedAt: 20,
    });
    expect(successRate(pb!)).toBe(0.5);
  });

  it("listRepairPlaybooks filters by failureClass and reads back consistent values", () => {
    seed(store, "lint", "a", 3, 3);
    seed(store, "lint", "b", 2, 0);
    seed(store, "build", "a", 1, 1);

    const lint = store.listRepairPlaybooks({ failureClass: "lint" });
    expect(lint.map((p) => p.playbookKey).sort()).toEqual(["lint:a", "lint:b"]);
    const a = lint.find((p) => p.strategy === "a")!;
    expect(a.appliedCount).toBe(3);
    expect(a.successCount).toBe(3);

    const all = store.listRepairPlaybooks();
    expect(all).toHaveLength(3);
  });

  it("rankStrategies consumes persisted history from the real store", () => {
    seed(store, "unit-test", "good", 3, 3);
    seed(store, "unit-test", "bad", 3, 0); // demoted
    const ranked = rankStrategies(store, "unit-test", [
      { source: "bad" },
      { source: "fresh" },
      { source: "good" },
    ]);
    expect(ranked.map((c) => c.source)).toEqual(["good", "fresh", "bad"]);
  });
});
