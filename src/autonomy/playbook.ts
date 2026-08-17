import type { FailureClass, RepairPlaybook } from "./domain.js";

/**
 * Phase 3-B of the PR self-heal loop — the self-evolving playbook library.
 *
 * This module is the deterministic, zero-LLM statistics layer that lets
 * self-heal get "smarter" over time: it tallies how each repair *strategy* has
 * fared against each {@link FailureClass}, ranks the proven strategies ahead of
 * the shaky ones, and demotes strategies that keep failing so the loop stops
 * retrying dead ends.
 *
 * It is a pure injection over the existing repair actions: it never touches the
 * attempt state machine (ATTEMPT_TRANSITIONS), never bypasses the deterministic
 * review / change-file budget, and never calls a model. It only *reorders* the
 * candidate strategies the existing detect* functions already emit — with the
 * current hard-coded detection order kept as the no-history tie-break fallback.
 *
 * Persistence is delegated to {@link AutonomyStore} via the small structural
 * {@link PlaybookStore} port below, so unit tests can substitute a fake store
 * with zero SQLite / FS.
 */

/**
 * The slice of {@link AutonomyStore} the playbook layer needs. Declared
 * structurally so a fake store (or the real AutonomyStore) satisfies it without
 * an import cycle — mirrors how the repair actions inject their worktree/git
 * ports.
 */
export interface PlaybookStore {
  recordRepairPlaybookOutcome(input: {
    playbookKey: string;
    failureClass: FailureClass;
    strategy: string;
    success: boolean;
    now?: number;
  }): RepairPlaybook;
  getRepairPlaybook(playbookKey: string): RepairPlaybook | undefined;
  listRepairPlaybooks(options?: { failureClass?: FailureClass; limit?: number }): RepairPlaybook[];
}

/**
 * Minimum applications before a strategy is eligible for demotion. Below this
 * we have too little signal to conclude a strategy is bad, so it keeps its
 * default detection priority.
 */
export const DEMOTION_MIN_ATTEMPTS = 3;

/**
 * A strategy that has been applied at least {@link DEMOTION_MIN_ATTEMPTS} times
 * with a success rate at or below this is demoted to the back of the candidate
 * list — it keeps failing, so proven and even unproven strategies go first.
 */
export const DEMOTION_MAX_SUCCESS_RATE = 1 / 3;

/**
 * Neutral baseline rate assigned to a strategy with no recorded history, so
 * proven-better strategies sort ahead of it and proven-worse-but-not-yet-demoted
 * strategies sort behind it. Unproven strategies with equal baselines keep their
 * original (default) detection order via a stable sort.
 */
export const DEFAULT_PRIORITY_RATE = 0.5;

/** `failureClass:strategySource` — the natural playbook lookup / dedupe key. */
export function playbookKey(failureClass: FailureClass, strategySource: string): string {
  return `${failureClass}:${strategySource}`;
}

/** successCount / appliedCount, or 0 when the strategy has never been applied. */
export function successRate(playbook: Pick<RepairPlaybook, "appliedCount" | "successCount">): number {
  if (playbook.appliedCount <= 0) return 0;
  return playbook.successCount / playbook.appliedCount;
}

/**
 * True when a strategy has enough applications and a low enough success rate
 * that it should be demoted behind everything else. Deterministic arithmetic —
 * no LLM.
 */
export function isDemoted(playbook: Pick<RepairPlaybook, "appliedCount" | "successCount">): boolean {
  return (
    playbook.appliedCount >= DEMOTION_MIN_ATTEMPTS &&
    successRate(playbook) <= DEMOTION_MAX_SUCCESS_RATE
  );
}

/**
 * Record the outcome of one repair application onto its playbook. Called at the
 * tail of every apply* action, exactly once per application: `success=true`
 * when the task advanced to `applied` (a staged, in-bounds fix), `false` on any
 * abandoned path. appliedCount always increments; successCount only on success.
 *
 * `strategy` is the detect* `source` (e.g. `package.json:lint:fix`,
 * `pnpm-lock.yaml`) or the agent class token (`typecheck` / `unit-test`), which
 * together with the failure class forms the {@link playbookKey}.
 */
export function recordRepairOutcome(
  store: PlaybookStore,
  input: {
    failureClass: FailureClass;
    strategy: string;
    success: boolean;
    now?: number;
  },
): RepairPlaybook {
  const key = playbookKey(input.failureClass, input.strategy);
  return store.recordRepairPlaybookOutcome({
    playbookKey: key,
    failureClass: input.failureClass,
    strategy: input.strategy,
    success: input.success,
    ...(input.now === undefined ? {} : { now: input.now }),
  });
}

/**
 * Reorder a class's candidate strategies by historical success rate (highest
 * first), keeping the caller's default order as the tie-break so a project with
 * no history behaves exactly as before. Demoted strategies (see
 * {@link isDemoted}) are pushed to the very back regardless of their raw rate.
 *
 * `candidates` is the detect* function's own safest-first list; each carries a
 * `source` used to build the {@link playbookKey}. The sort is *stable*, so
 * equal-score candidates (e.g. several with no history) preserve their original
 * relative order — the deterministic default fallback the task requires.
 *
 * Pure: reads only from `store`, mutates nothing, calls no model.
 */
export function rankStrategies<T extends { readonly source: string }>(
  store: PlaybookStore,
  failureClass: FailureClass,
  candidates: readonly T[],
): T[] {
  // Decorate-sort-undecorate to guarantee a stable sort across engines.
  const decorated = candidates.map((candidate, index) => {
    const playbook = store.getRepairPlaybook(playbookKey(failureClass, candidate.source));
    let score: number;
    if (playbook === undefined || playbook.appliedCount <= 0) {
      score = DEFAULT_PRIORITY_RATE; // no history → neutral default priority
    } else if (isDemoted(playbook)) {
      score = -1; // proven-bad → always last
    } else {
      score = successRate(playbook);
    }
    return { candidate, index, score };
  });
  decorated.sort((a, b) => (b.score - a.score) || (a.index - b.index));
  return decorated.map((entry) => entry.candidate);
}
