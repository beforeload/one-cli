import { describe, expect, it } from "vitest";

import type { DiagnosisReceipt, FailureClass } from "../../src/autonomy/domain.js";
import { classifyFailure, createDiagnosisReceipt } from "../../src/autonomy/diagnosis.js";
import {
  DEFAULT_REPAIR_POLICY,
  INITIAL_HEAL_COUNTERS,
  NON_AUTO_REPAIR_CLASSES,
  applyDependencyRepair,
  applyLintRepair,
  applyAgentRepair,
  applyRepairTask,
  buildAgentRepairPrompt,
  createRepairTask,
  decideHeal,
  decompose,
  detectLintFixCommand,
  detectPackageManager,
  recordHealObservation,
  withStatus,
  type AgentRepairGit,
  type AgentRepairRunner,
  type DependencyCommandRunner,
  type DependencyFixCommand,
  type DependencyRepairGit,
  type DependencyRepairWorktree,
  type LintCommandRunner,
  type LintFixCommand,
  type LintRepairGit,
  type LintRepairWorktree,
} from "../../src/autonomy/repair.js";
import { assertRecoveryEvidence } from "../../src/autonomy/process.js";

const FINGERPRINT = "f".repeat(64);

/** Build a real DiagnosisReceipt via the deterministic classifier. */
function diagnose(log: string, gate: string | null): DiagnosisReceipt {
  const classification = classifyFailure({ log, gate, failureFingerprint: FINGERPRINT });
  return createDiagnosisReceipt(
    {
      source: "github-check",
      attemptId: "attempt-1",
      operationId: "op-1",
      gate,
      failureFingerprint: FINGERPRINT,
      timestamp: 1_700_000_000_000,
    },
    classification,
  );
}

const flakyDiagnosis = diagnose(
  "Error: connect ETIMEDOUT 140.82.112.3:443\nsocket hang up\nservice unavailable (HTTP 503)",
  "unit",
);
const credentialDiagnosis = diagnose(
  "Set repository secret CODEBUDDY_API_KEY before enabling the autonomy workflow.",
  "select-trusted-issue",
);
const roadmapDiagnosis = diagnose(
  "Error: Roadmap marker must identify an issue: 03-context-compaction:v1",
  "select-trusted-issue",
);
const ctx = { timestamp: 1_700_000_000_000 };

describe("repair.decompose", () => {
  it("(a) flaky-transient → exactly one re-run RepairTask (no code change)", () => {
    expect(flakyDiagnosis.failureClass).toBe("flaky-transient");
    const result = decompose(flakyDiagnosis, ctx);
    expect(result.needsHuman).toBe(false);
    expect(result.tasks).toHaveLength(1);
    const task = result.tasks[0]!;
    expect(task.schema).toBe("autonomy.one-cli/repair-task-v1");
    expect(task.failureClass).toBe("flaky-transient");
    expect(task.failureFingerprint).toBe(FINGERPRINT);
    expect(task.targetPaths).toEqual([]);
    expect(task.instruction).toBe("retry CI, no code change");
    expect(task.verifyGate).toBe("unit");
    expect(task.dependsOn).toEqual([]);
    expect(task.status).toBe("queued");
    expect(task.hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(task.taskId.startsWith("repair:flaky-transient:")).toBe(true);
  });

  it("produces a content-addressed, deterministic task hash", () => {
    const a = decompose(flakyDiagnosis, ctx).tasks[0]!;
    const b = decompose(flakyDiagnosis, { timestamp: 999 }).tasks[0]!;
    // Hash excludes timestamp/status → equivalent tasks dedupe.
    expect(a.hash).toBe(b.hash);
    expect(a.taskId).toBe(b.taskId);
  });

  it("(b) credential → no task + needsHuman", () => {
    expect(credentialDiagnosis.failureClass).toBe("credential");
    const result = decompose(credentialDiagnosis, ctx);
    expect(result.tasks).toHaveLength(0);
    expect(result.needsHuman).toBe(true);
    expect(result.reason).toMatch(/safety boundary/iu);
  });

  it("(b) roadmap-marker → no task + needsHuman", () => {
    expect(roadmapDiagnosis.failureClass).toBe("roadmap-marker");
    const result = decompose(roadmapDiagnosis, ctx);
    expect(result.tasks).toHaveLength(0);
    expect(result.needsHuman).toBe(true);
  });

  it("keeps credential + roadmap-marker on the non-auto-repair boundary", () => {
    expect([...NON_AUTO_REPAIR_CLASSES].sort()).toEqual(["credential", "roadmap-marker"]);
  });

  it("unimplemented classes yield no task but are NOT human-only (extension point)", () => {
    for (const cls of ["e2e", "build", "unknown"] as FailureClass[]) {
      const fake: DiagnosisReceipt = { ...flakyDiagnosis, failureClass: cls };
      const result = decompose(fake, ctx);
      expect(result.tasks).toHaveLength(0);
      expect(result.needsHuman).toBe(false);
    }
  });
});

describe("repair bounded termination", () => {
  it("records observations, incrementing attempts and per-fingerprint counts", () => {
    let counters = INITIAL_HEAL_COUNTERS;
    counters = recordHealObservation(counters, FINGERPRINT);
    expect(counters.healAttempts).toBe(1);
    expect(counters.fingerprintCounts[FINGERPRINT]).toBe(1);
    counters = recordHealObservation(counters, FINGERPRINT);
    expect(counters.healAttempts).toBe(2);
    expect(counters.fingerprintCounts[FINGERPRINT]).toBe(2);
  });

  it("first flaky observation → actionable repair", () => {
    const counters = recordHealObservation(INITIAL_HEAL_COUNTERS, FINGERPRINT);
    const decision = decideHeal(flakyDiagnosis, counters, ctx);
    expect(decision.action).toBe("repair");
    if (decision.action === "repair") {
      expect(decision.task.failureClass).toBe("flaky-transient");
    }
  });

  it("(c) same fingerprint recurring to the limit → blocked (oscillation)", () => {
    let counters = INITIAL_HEAL_COUNTERS;
    // Two occurrences of the identical fingerprint == maxSameFingerprint(2).
    counters = recordHealObservation(counters, FINGERPRINT);
    counters = recordHealObservation(counters, FINGERPRINT);
    const decision = decideHeal(flakyDiagnosis, counters, ctx);
    expect(decision.action).toBe("blocked");
    expect(decision.reason).toMatch(/oscillation|recurred/iu);
  });

  it("(d) heal attempts reaching maxHealAttempts → in_doubt", () => {
    // Distinct fingerprints each time so oscillation doesn't trip first.
    let counters = INITIAL_HEAL_COUNTERS;
    counters = recordHealObservation(counters, "a".repeat(64));
    counters = recordHealObservation(counters, "b".repeat(64));
    counters = recordHealObservation(counters, "c".repeat(64));
    expect(counters.healAttempts).toBe(DEFAULT_REPAIR_POLICY.maxHealAttempts);
    const decision = decideHeal(flakyDiagnosis, counters, ctx);
    expect(decision.action).toBe("in_doubt");
    expect(decision.reason).toMatch(/budget exhausted/iu);
  });

  it("credential diagnosis → in_doubt even within budget (safety boundary wins)", () => {
    const counters = recordHealObservation(INITIAL_HEAL_COUNTERS, credentialDiagnosis.failureFingerprint);
    const decision = decideHeal(credentialDiagnosis, counters, ctx);
    expect(decision.action).toBe("in_doubt");
    expect(decision.reason).toMatch(/safety boundary/iu);
  });

  it("respects a custom, tighter policy", () => {
    const counters = recordHealObservation(INITIAL_HEAL_COUNTERS, FINGERPRINT);
    const decision = decideHeal(flakyDiagnosis, counters, ctx, {
      maxHealAttempts: 1,
      maxSameFingerprint: 5,
    });
    // healAttempts(1) >= maxHealAttempts(1) → in_doubt
    expect(decision.action).toBe("in_doubt");
  });
});

describe("repair.applyRepairTask", () => {
  it("flaky task → rerun-ci, advanced to applied", () => {
    const task = decompose(flakyDiagnosis, ctx).tasks[0]!;
    const result = applyRepairTask(task);
    expect(result.action).toBe("rerun-ci");
    expect(result.task.status).toBe("applied");
    expect(result.reason).toMatch(/no code change|no push/iu);
  });

  it("non-flaky task → noop, abandoned", () => {
    const task = createRepairTask(
      {
        failureClass: "lint",
        failureFingerprint: FINGERPRINT,
        targetPaths: ["src/foo.ts"],
        instruction: "run eslint --fix",
        verifyGate: "lint",
        dependsOn: [],
      },
      ctx.timestamp,
    );
    const result = applyRepairTask(task);
    expect(result.action).toBe("noop");
    expect(result.task.status).toBe("abandoned");
  });

  it("withStatus is pure and non-mutating", () => {
    const task = decompose(flakyDiagnosis, ctx).tasks[0]!;
    const verified = withStatus(task, "verified");
    expect(verified.status).toBe("verified");
    expect(task.status).toBe("queued");
  });
});

// --- Phase 2-B: lint → real code repair --------------------------------------

const AUTH_KEY = new Uint8Array(32).fill(7);
const RECEIPT_HASH = "a".repeat(64);

const lintDiagnosis = diagnose(
  "oxlint\n✖ 3 problems (3 errors, 0 warnings)\nsrc/autonomy/foo.ts:12:1 no-unused-vars",
  "lint",
);

/** A fake worktree that reports a package.json with the given scripts + config files. */
function fakeWorktree(opts: {
  scripts?: Record<string, string>;
  files?: readonly string[];
}): LintRepairWorktree {
  const files = new Set(opts.files ?? []);
  const pkg =
    opts.scripts === undefined ? null : JSON.stringify({ name: "x", scripts: opts.scripts });
  return {
    readFile: (p) => (p === "package.json" ? pkg : null),
    exists: (p) => files.has(p),
  };
}

/** A runner that records the command it was given and returns a fixed exit code. */
function fakeRunner(exitCode: number | null): LintCommandRunner & { calls: LintFixCommand[] } {
  const calls: LintFixCommand[] = [];
  return {
    calls,
    run: async (command) => {
      calls.push(command);
      return { exitCode };
    },
  };
}

/** A git double that reports whether a diff exists and records stageAll calls. */
function fakeGit(hasDiff: boolean): LintRepairGit & { staged: boolean } {
  const state = { staged: false };
  return {
    get staged() {
      return state.staged;
    },
    hasChanges: async () => hasDiff,
    stageAll: async () => {
      state.staged = true;
    },
  };
}

describe("repair.decompose lint (Phase 2-B)", () => {
  it("(a) lint diagnosis → exactly one lint fix task, verifyGate=lint", () => {
    expect(lintDiagnosis.failureClass).toBe("lint");
    const result = decompose(lintDiagnosis, ctx);
    expect(result.needsHuman).toBe(false);
    expect(result.tasks).toHaveLength(1);
    const task = result.tasks[0]!;
    expect(task.failureClass).toBe("lint");
    expect(task.verifyGate).toBe("lint");
    expect(task.dependsOn).toEqual([]);
    expect(task.instruction).toBe(
      "run linter autofix (e.g. oxlint/eslint --fix), stage and re-verify",
    );
    expect(task.failureFingerprint).toBe(FINGERPRINT);
    expect(task.status).toBe("queued");
    expect(task.taskId.startsWith("repair:lint:")).toBe(true);
    // affectedFiles from the classifier flow into targetPaths.
    expect(task.targetPaths).toEqual(lintDiagnosis.affectedFiles);
  });

  it("lint with no affectedFiles → whole-repo fix task (empty targetPaths)", () => {
    const noFiles: DiagnosisReceipt = { ...lintDiagnosis, affectedFiles: [] };
    const result = decompose(noFiles, ctx);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]!.targetPaths).toEqual([]);
    expect(result.reason).toMatch(/whole-repo/iu);
  });

  it("(b) lint hitting a protected path → no task + needsHuman", () => {
    const receipt: DiagnosisReceipt = {
      ...lintDiagnosis,
      affectedFiles: ["src/autonomy/orchestrator.ts", "docs/readme.md"],
    };
    const result = decompose(receipt, {
      timestamp: ctx.timestamp,
      protectedPaths: ["src/autonomy"],
    });
    expect(result.tasks).toHaveLength(0);
    expect(result.needsHuman).toBe(true);
    expect(result.reason).toMatch(/protected path/iu);
  });

  it("lint whose affectedFiles miss the protected paths → still produces a task", () => {
    const receipt: DiagnosisReceipt = { ...lintDiagnosis, affectedFiles: ["src/util/x.ts"] };
    const result = decompose(receipt, {
      timestamp: ctx.timestamp,
      protectedPaths: ["src/autonomy", "src-legacy"],
    });
    expect(result.needsHuman).toBe(false);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]!.targetPaths).toEqual(["src/util/x.ts"]);
  });
});

describe("repair.detectLintFixCommand", () => {
  it("prefers a package.json lint:fix script → npm run lint:fix", () => {
    const cmd = detectLintFixCommand(
      fakeWorktree({ scripts: { "lint:fix": "tsx scripts/run-oxlint.ts --fix" } }),
    );
    expect(cmd).toEqual({
      executable: "npm",
      args: ["run", "lint:fix"],
      source: "package.json:lint:fix",
    });
  });

  it("falls back to any lint script whose body contains --fix", () => {
    const cmd = detectLintFixCommand(
      fakeWorktree({ scripts: { lint: "eslint . --fix --max-warnings 0" } }),
    );
    expect(cmd?.source).toBe("package.json:lint-script-with-fix");
    expect(cmd?.args).toEqual(["run", "lint"]);
  });

  it("detects .oxlintrc.json when no fix script exists", () => {
    const cmd = detectLintFixCommand(fakeWorktree({ scripts: {}, files: [".oxlintrc.json"] }));
    expect(cmd).toEqual({ executable: "npx", args: ["oxlint", "--fix"], source: "oxlintrc" });
  });

  it("detects eslint config", () => {
    const cmd = detectLintFixCommand(fakeWorktree({ files: ["eslint.config.mjs"] }));
    expect(cmd).toEqual({ executable: "npx", args: ["eslint", ".", "--fix"], source: "eslintrc" });
  });

  it("returns null when no linter is detectable", () => {
    expect(detectLintFixCommand(fakeWorktree({ scripts: { build: "tsc" } }))).toBeNull();
  });
});

describe("repair.applyLintRepair (Phase 2-B)", () => {
  const lintTask = createRepairTask(
    {
      failureClass: "lint",
      failureFingerprint: FINGERPRINT,
      targetPaths: ["src/util/x.ts"],
      instruction: "run linter autofix (e.g. oxlint/eslint --fix), stage and re-verify",
      verifyGate: "lint",
      dependsOn: [],
    },
    ctx.timestamp,
  );

  it("(c) success: selects the command, stages the diff, mints valid RecoveryEvidence", async () => {
    const worktree = fakeWorktree({ scripts: { "lint:fix": "tsx scripts/run-oxlint.ts --fix" } });
    const runner = fakeRunner(0);
    const git = fakeGit(true);
    const result = await applyLintRepair({
      task: lintTask,
      worktree,
      runner,
      git,
      authenticationKey: AUTH_KEY,
      failureReceiptHash: RECEIPT_HASH,
      operationId: "op-lint-1",
      timestamp: ctx.timestamp,
    });

    // Selected the right command.
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]!.source).toBe("package.json:lint:fix");
    // Staged the autofix diff (worktree only, no commit/push).
    expect(git.staged).toBe(true);
    expect(result.staged).toBe(true);
    expect(result.task.status).toBe("applied");
    // Produced HMAC-authenticated evidence bound to the failure fingerprint.
    expect(result.evidence).not.toBeNull();
    const evidence = result.evidence!;
    expect(evidence.failureFingerprint).toBe(FINGERPRINT);
    expect(evidence.failureReceiptHash).toBe(RECEIPT_HASH);
    expect(evidence.authentication.algorithm).toBe("hmac-sha256");
    // Round-trips through the authenticator without throwing.
    expect(() =>
      assertRecoveryEvidence(
        evidence,
        { maxSummaryBytes: 4_096, allowedSources: ["local-process"] },
        AUTH_KEY,
      ),
    ).not.toThrow();
  });

  it("(d) fix command exits non-zero → no evidence, task abandoned", async () => {
    const runner = fakeRunner(1);
    const git = fakeGit(false);
    const result = await applyLintRepair({
      task: lintTask,
      worktree: fakeWorktree({ scripts: { "lint:fix": "oxlint --fix" } }),
      runner,
      git,
      authenticationKey: AUTH_KEY,
      failureReceiptHash: RECEIPT_HASH,
      operationId: "op-lint-2",
      timestamp: ctx.timestamp,
    });
    expect(result.task.status).toBe("abandoned");
    expect(result.evidence).toBeNull();
    expect(result.staged).toBe(false);
    expect(git.staged).toBe(false);
    expect(result.reason).toMatch(/could not fix/iu);
  });

  it("fix exits 0 but produces no diff → no evidence, abandoned (would recur)", async () => {
    const result = await applyLintRepair({
      task: lintTask,
      worktree: fakeWorktree({ scripts: { "lint:fix": "oxlint --fix" } }),
      runner: fakeRunner(0),
      git: fakeGit(false),
      authenticationKey: AUTH_KEY,
      failureReceiptHash: RECEIPT_HASH,
      operationId: "op-lint-3",
      timestamp: ctx.timestamp,
    });
    expect(result.task.status).toBe("abandoned");
    expect(result.evidence).toBeNull();
    expect(result.reason).toMatch(/no diff|nothing to fix/iu);
  });

  it("no linter detectable → no evidence, abandoned", async () => {
    const runner = fakeRunner(0);
    const result = await applyLintRepair({
      task: lintTask,
      worktree: fakeWorktree({ scripts: { build: "tsc" } }),
      runner,
      git: fakeGit(true),
      authenticationKey: AUTH_KEY,
      failureReceiptHash: RECEIPT_HASH,
      operationId: "op-lint-4",
      timestamp: ctx.timestamp,
    });
    expect(runner.calls).toHaveLength(0);
    expect(result.task.status).toBe("abandoned");
    expect(result.evidence).toBeNull();
    expect(result.fixCommand).toBeNull();
  });

  it("refuses a non-lint task", async () => {
    const flakyTask = decompose(flakyDiagnosis, ctx).tasks[0]!;
    const result = await applyLintRepair({
      task: flakyTask,
      worktree: fakeWorktree({ scripts: { "lint:fix": "oxlint --fix" } }),
      runner: fakeRunner(0),
      git: fakeGit(true),
      authenticationKey: AUTH_KEY,
      failureReceiptHash: RECEIPT_HASH,
      operationId: "op-lint-5",
      timestamp: ctx.timestamp,
    });
    expect(result.task.status).toBe("abandoned");
    expect(result.evidence).toBeNull();
  });
});

// --- Phase 2-C: dependency → real reinstall repair ---------------------------

const dependencyDiagnosis = diagnose(
  "npm ERR! code ELOCKVERIFY\nnpm ERR! Errors were found in your package-lock.json\npnpm-lock.yaml is out of date",
  "dependency",
);

const typecheckDiagnosis = diagnose(
  "src/foo.ts(12,3): error TS2322: Type 'string' is not assignable to type 'number'.\ntype check failed",
  "typecheck",
);

/** A fake worktree that reports which lockfiles exist. */
function fakeDepWorktree(files: readonly string[]): DependencyRepairWorktree {
  const set = new Set(files);
  return {
    readFile: () => null,
    exists: (p) => set.has(p),
  };
}

/** A runner that records the commands it was given and returns queued exit codes. */
function fakeDepRunner(
  ...exitCodes: (number | null)[]
): DependencyCommandRunner & { calls: DependencyFixCommand[] } {
  const calls: DependencyFixCommand[] = [];
  let i = 0;
  return {
    calls,
    run: async (command) => {
      calls.push(command);
      const code = i < exitCodes.length ? exitCodes[i]! : exitCodes[exitCodes.length - 1] ?? 0;
      i += 1;
      return { exitCode: code };
    },
  };
}

function fakeDepGit(hasDiff: boolean): DependencyRepairGit & { staged: boolean } {
  const state = { staged: false };
  return {
    get staged() {
      return state.staged;
    },
    hasChanges: async () => hasDiff,
    stageAll: async () => {
      state.staged = true;
    },
  };
}

describe("repair.decompose dependency (Phase 2-C)", () => {
  it("(a) dependency diagnosis → exactly one reinstall task, verifyGate=dependency", () => {
    expect(dependencyDiagnosis.failureClass).toBe("dependency");
    const result = decompose(dependencyDiagnosis, ctx);
    expect(result.needsHuman).toBe(false);
    expect(result.tasks).toHaveLength(1);
    const task = result.tasks[0]!;
    expect(task.failureClass).toBe("dependency");
    expect(task.verifyGate).toBe("dependency");
    expect(task.dependsOn).toEqual([]);
    expect(task.instruction).toBe(
      "reinstall dependencies from lockfile (pnpm install --frozen-lockfile or repair lockfile), stage and re-verify",
    );
    expect(task.failureFingerprint).toBe(FINGERPRINT);
    expect(task.status).toBe("queued");
    expect(task.taskId.startsWith("repair:dependency:")).toBe(true);
    expect(task.targetPaths).toEqual(dependencyDiagnosis.affectedFiles);
  });

  it("dependency with no affectedFiles → whole-repo reinstall (empty targetPaths)", () => {
    const noFiles: DiagnosisReceipt = { ...dependencyDiagnosis, affectedFiles: [] };
    const result = decompose(noFiles, ctx);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]!.targetPaths).toEqual([]);
    expect(result.reason).toMatch(/whole-repo/iu);
  });

  it("(b) dependency hitting a protected path → no task + needsHuman", () => {
    const receipt: DiagnosisReceipt = {
      ...dependencyDiagnosis,
      affectedFiles: ["pnpm-lock.yaml", "docs/readme.md"],
    };
    const result = decompose(receipt, {
      timestamp: ctx.timestamp,
      protectedPaths: ["pnpm-lock.yaml"],
    });
    expect(result.tasks).toHaveLength(0);
    expect(result.needsHuman).toBe(true);
    expect(result.reason).toMatch(/protected path/iu);
  });

  it("dependency whose affectedFiles miss the protected paths → still produces a task", () => {
    const receipt: DiagnosisReceipt = { ...dependencyDiagnosis, affectedFiles: ["package.json"] };
    const result = decompose(receipt, {
      timestamp: ctx.timestamp,
      protectedPaths: ["src/autonomy"],
    });
    expect(result.needsHuman).toBe(false);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]!.targetPaths).toEqual(["package.json"]);
  });
});

describe("repair.detectPackageManager (Phase 2-C)", () => {
  it("prefers pnpm-lock.yaml → pnpm install --frozen-lockfile", () => {
    const cmd = detectPackageManager(fakeDepWorktree(["pnpm-lock.yaml"]));
    expect(cmd).toEqual({
      executable: "pnpm",
      args: ["install", "--frozen-lockfile"],
      packageManager: "pnpm",
      mode: "frozen",
      source: "pnpm-lock.yaml",
    });
  });

  it("detects package-lock.json → npm ci", () => {
    const cmd = detectPackageManager(fakeDepWorktree(["package-lock.json"]));
    expect(cmd?.packageManager).toBe("npm");
    expect(cmd?.args).toEqual(["ci"]);
  });

  it("detects yarn.lock → yarn install --frozen-lockfile", () => {
    const cmd = detectPackageManager(fakeDepWorktree(["yarn.lock"]));
    expect(cmd?.packageManager).toBe("yarn");
    expect(cmd?.args).toEqual(["install", "--frozen-lockfile"]);
  });

  it("prefers pnpm over npm/yarn when multiple lockfiles present (safest-first)", () => {
    const cmd = detectPackageManager(
      fakeDepWorktree(["pnpm-lock.yaml", "package-lock.json", "yarn.lock"]),
    );
    expect(cmd?.packageManager).toBe("pnpm");
  });

  it("regenerate mode drops the frozen flag (repairs a drifted lockfile)", () => {
    const cmd = detectPackageManager(fakeDepWorktree(["pnpm-lock.yaml"]), "regenerate");
    expect(cmd?.mode).toBe("regenerate");
    expect(cmd?.args).toEqual(["install"]);
  });

  it("returns null when no lockfile is present", () => {
    expect(detectPackageManager(fakeDepWorktree([]))).toBeNull();
  });
});

describe("repair.applyDependencyRepair (Phase 2-C)", () => {
  const depTask = createRepairTask(
    {
      failureClass: "dependency",
      failureFingerprint: FINGERPRINT,
      targetPaths: ["pnpm-lock.yaml"],
      instruction:
        "reinstall dependencies from lockfile (pnpm install --frozen-lockfile or repair lockfile), stage and re-verify",
      verifyGate: "dependency",
      dependsOn: [],
    },
    ctx.timestamp,
  );

  it("(c) success: probes pnpm, stages the diff, mints valid RecoveryEvidence", async () => {
    const runner = fakeDepRunner(0);
    const git = fakeDepGit(true);
    const result = await applyDependencyRepair({
      task: depTask,
      worktree: fakeDepWorktree(["pnpm-lock.yaml"]),
      runner,
      git,
      authenticationKey: AUTH_KEY,
      failureReceiptHash: RECEIPT_HASH,
      operationId: "op-dep-1",
      timestamp: ctx.timestamp,
    });

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]!.packageManager).toBe("pnpm");
    expect(runner.calls[0]!.mode).toBe("frozen");
    expect(git.staged).toBe(true);
    expect(result.staged).toBe(true);
    expect(result.task.status).toBe("applied");
    expect(result.evidence).not.toBeNull();
    const evidence = result.evidence!;
    expect(evidence.failureFingerprint).toBe(FINGERPRINT);
    expect(evidence.failureReceiptHash).toBe(RECEIPT_HASH);
    expect(evidence.authentication.algorithm).toBe("hmac-sha256");
    expect(() =>
      assertRecoveryEvidence(
        evidence,
        { maxSummaryBytes: 4_096, allowedSources: ["local-process"] },
        AUTH_KEY,
      ),
    ).not.toThrow();
  });

  it("detects npm → runs npm ci on success", async () => {
    const runner = fakeDepRunner(0);
    const result = await applyDependencyRepair({
      task: depTask,
      worktree: fakeDepWorktree(["package-lock.json"]),
      runner,
      git: fakeDepGit(true),
      authenticationKey: AUTH_KEY,
      failureReceiptHash: RECEIPT_HASH,
      operationId: "op-dep-npm",
      timestamp: ctx.timestamp,
    });
    expect(runner.calls[0]!.packageManager).toBe("npm");
    expect(runner.calls[0]!.args).toEqual(["ci"]);
    expect(result.task.status).toBe("applied");
  });

  it("frozen install fails → retries once in regenerate mode, then succeeds", async () => {
    // first (frozen) exits 1, second (regenerate) exits 0.
    const runner = fakeDepRunner(1, 0);
    const result = await applyDependencyRepair({
      task: depTask,
      worktree: fakeDepWorktree(["pnpm-lock.yaml"]),
      runner,
      git: fakeDepGit(true),
      authenticationKey: AUTH_KEY,
      failureReceiptHash: RECEIPT_HASH,
      operationId: "op-dep-regen",
      timestamp: ctx.timestamp,
    });
    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[0]!.mode).toBe("frozen");
    expect(runner.calls[1]!.mode).toBe("regenerate");
    expect(result.task.status).toBe("applied");
    expect(result.fixCommand?.mode).toBe("regenerate");
    expect(result.evidence).not.toBeNull();
  });

  it("(d) reinstall exits non-zero (regeneration disabled) → no evidence, abandoned", async () => {
    const runner = fakeDepRunner(1);
    const git = fakeDepGit(false);
    const result = await applyDependencyRepair({
      task: depTask,
      worktree: fakeDepWorktree(["pnpm-lock.yaml"]),
      runner,
      git,
      authenticationKey: AUTH_KEY,
      failureReceiptHash: RECEIPT_HASH,
      operationId: "op-dep-2",
      timestamp: ctx.timestamp,
      allowLockfileRegeneration: false,
    });
    expect(runner.calls).toHaveLength(1);
    expect(result.task.status).toBe("abandoned");
    expect(result.evidence).toBeNull();
    expect(result.staged).toBe(false);
    expect(git.staged).toBe(false);
    expect(result.reason).toMatch(/could not reinstall/iu);
  });

  it("reinstall exits 0 but no diff → no evidence, abandoned (would recur)", async () => {
    const result = await applyDependencyRepair({
      task: depTask,
      worktree: fakeDepWorktree(["pnpm-lock.yaml"]),
      runner: fakeDepRunner(0),
      git: fakeDepGit(false),
      authenticationKey: AUTH_KEY,
      failureReceiptHash: RECEIPT_HASH,
      operationId: "op-dep-3",
      timestamp: ctx.timestamp,
    });
    expect(result.task.status).toBe("abandoned");
    expect(result.evidence).toBeNull();
    expect(result.reason).toMatch(/no diff|nothing changed/iu);
  });

  it("no package manager detectable → no evidence, abandoned", async () => {
    const runner = fakeDepRunner(0);
    const result = await applyDependencyRepair({
      task: depTask,
      worktree: fakeDepWorktree([]),
      runner,
      git: fakeDepGit(true),
      authenticationKey: AUTH_KEY,
      failureReceiptHash: RECEIPT_HASH,
      operationId: "op-dep-4",
      timestamp: ctx.timestamp,
    });
    expect(runner.calls).toHaveLength(0);
    expect(result.task.status).toBe("abandoned");
    expect(result.evidence).toBeNull();
    expect(result.fixCommand).toBeNull();
  });

  it("refuses a non-dependency task", async () => {
    const flakyTask = decompose(flakyDiagnosis, ctx).tasks[0]!;
    const result = await applyDependencyRepair({
      task: flakyTask,
      worktree: fakeDepWorktree(["pnpm-lock.yaml"]),
      runner: fakeDepRunner(0),
      git: fakeDepGit(true),
      authenticationKey: AUTH_KEY,
      failureReceiptHash: RECEIPT_HASH,
      operationId: "op-dep-5",
      timestamp: ctx.timestamp,
    });
    expect(result.task.status).toBe("abandoned");
    expect(result.evidence).toBeNull();
  });
});

// --- Phase 3-A: typecheck / unit-test → agent-driven repair ------------------

const unitTestDiagnosis = diagnose(
  "FAIL tests/unit/session.test.ts > resumes a session\nAssertionError: expected 2 to be 3\n  ❯ tests/unit/session.test.ts:42:24\n1 failed, 10 passed",
  "unit-test",
);

/** A fake agent runner that records its input and returns a fixed outcome. */
function fakeAgentRunner(
  ok: boolean,
  summary?: string,
): AgentRepairRunner & { calls: Array<{ prompt: string; approvedPaths: readonly string[] }> } {
  const calls: Array<{ prompt: string; approvedPaths: readonly string[] }> = [];
  return {
    calls,
    run: async (input) => {
      calls.push({ prompt: input.prompt, approvedPaths: input.approvedPaths });
      return { ok, ...(summary === undefined ? {} : { summary }) };
    },
  };
}

/** A git double that reports a fixed set of changed paths and records staging. */
function fakeAgentGit(
  changed: readonly string[],
): AgentRepairGit & { staged: boolean } {
  const state = { staged: false };
  return {
    get staged() {
      return state.staged;
    },
    changedPaths: async () => changed,
    stageAll: async () => {
      state.staged = true;
    },
  };
}

describe("repair.decompose typecheck / unit-test (Phase 3-A, agent-driven)", () => {
  it("(a) typecheck diagnosis → exactly one requiresAgent task, verifyGate=typecheck", () => {
    expect(typecheckDiagnosis.failureClass).toBe("typecheck");
    const result = decompose(typecheckDiagnosis, ctx);
    expect(result.needsHuman).toBe(false);
    expect(result.tasks).toHaveLength(1);
    const task = result.tasks[0]!;
    expect(task.failureClass).toBe("typecheck");
    expect(task.requiresAgent).toBe(true);
    expect(task.verifyGate).toBe("typecheck");
    expect(task.dependsOn).toEqual([]);
    expect(task.status).toBe("queued");
    expect(task.taskId.startsWith("repair:typecheck:")).toBe(true);
    expect(task.targetPaths).toEqual(typecheckDiagnosis.affectedFiles);
    expect(task.instruction).toMatch(/agent/iu);
    expect(task.instruction).toMatch(/minimal/iu);
  });

  it("(b) unit-test diagnosis → exactly one requiresAgent task, verifyGate=unit-test", () => {
    expect(unitTestDiagnosis.failureClass).toBe("unit-test");
    const result = decompose(unitTestDiagnosis, ctx);
    expect(result.needsHuman).toBe(false);
    expect(result.tasks).toHaveLength(1);
    const task = result.tasks[0]!;
    expect(task.failureClass).toBe("unit-test");
    expect(task.requiresAgent).toBe(true);
    expect(task.verifyGate).toBe("unit-test");
    expect(task.taskId.startsWith("repair:unit-test:")).toBe(true);
    expect(task.instruction).toMatch(/do not (?:delete|disable|skip)/iu);
  });

  it("(f) typecheck hitting a protected path → no task + needsHuman (safety boundary)", () => {
    const receipt: DiagnosisReceipt = {
      ...typecheckDiagnosis,
      affectedFiles: ["src/autonomy/orchestrator.ts", "src/foo.ts"],
    };
    const result = decompose(receipt, {
      timestamp: ctx.timestamp,
      protectedPaths: ["src/autonomy"],
    });
    expect(result.tasks).toHaveLength(0);
    expect(result.needsHuman).toBe(true);
    expect(result.reason).toMatch(/protected path/iu);
  });

  it("unit-test hitting a protected path → no task + needsHuman", () => {
    const receipt: DiagnosisReceipt = {
      ...unitTestDiagnosis,
      affectedFiles: [".github/workflows/ci.yml"],
    };
    const result = decompose(receipt, {
      timestamp: ctx.timestamp,
      protectedPaths: [".github"],
    });
    expect(result.tasks).toHaveLength(0);
    expect(result.needsHuman).toBe(true);
  });

  it("agent-driven task within budget → decideHeal returns an actionable repair", () => {
    const counters = recordHealObservation(
      INITIAL_HEAL_COUNTERS,
      typecheckDiagnosis.failureFingerprint,
    );
    const decision = decideHeal(typecheckDiagnosis, counters, ctx);
    expect(decision.action).toBe("repair");
    if (decision.action === "repair") {
      expect(decision.task.requiresAgent).toBe(true);
      expect(decision.task.failureClass).toBe("typecheck");
    }
  });
});

describe("repair.applyAgentRepair (Phase 3-A)", () => {
  const APPROVED = ["src/foo.ts"] as const;

  function agentTask(failureClass: "typecheck" | "unit-test"): ReturnType<typeof createRepairTask> {
    return createRepairTask(
      {
        failureClass,
        failureFingerprint: FINGERPRINT,
        targetPaths: ["src/foo.ts"],
        instruction: "Use an agent to make the MINIMAL fix inside the approved paths.",
        verifyGate: failureClass,
        dependsOn: [],
        requiresAgent: true,
      },
      ctx.timestamp,
    );
  }

  it("(c) success: fake runner returns ok + in-bounds diff → stage + valid RecoveryEvidence", async () => {
    const runner = fakeAgentRunner(true);
    const git = fakeAgentGit(["src/foo.ts"]);
    const result = await applyAgentRepair({
      task: agentTask("typecheck"),
      diagnosis: typecheckDiagnosis,
      runner,
      git,
      approvedPaths: APPROVED,
      protectedPaths: ["src/autonomy"],
      authenticationKey: AUTH_KEY,
      failureReceiptHash: RECEIPT_HASH,
      operationId: "op-agent-1",
      timestamp: ctx.timestamp,
    });

    // The agent was invoked once, with a prompt carrying the approvedPaths + log.
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]!.approvedPaths).toEqual(APPROVED);
    expect(runner.calls[0]!.prompt).toMatch(/approved paths/iu);
    // Staged the in-bounds diff, task applied.
    expect(git.staged).toBe(true);
    expect(result.staged).toBe(true);
    expect(result.escapedPaths).toEqual([]);
    expect(result.task.status).toBe("applied");
    // Evidence bound to the fingerprint, round-trips through the authenticator.
    expect(result.evidence).not.toBeNull();
    const evidence = result.evidence!;
    expect(evidence.failureFingerprint).toBe(FINGERPRINT);
    expect(evidence.failureReceiptHash).toBe(RECEIPT_HASH);
    expect(evidence.source).toBe("worker");
    expect(() =>
      assertRecoveryEvidence(
        evidence,
        { maxSummaryBytes: 4_096, allowedSources: ["worker"] },
        AUTH_KEY,
      ),
    ).not.toThrow();
  });

  it("(d) agent changes a path OUTSIDE approvedPaths → abandon, no stage, no evidence", async () => {
    const git = fakeAgentGit(["src/foo.ts", "src/secret/keys.ts"]);
    const result = await applyAgentRepair({
      task: agentTask("typecheck"),
      diagnosis: typecheckDiagnosis,
      runner: fakeAgentRunner(true),
      git,
      approvedPaths: APPROVED,
      authenticationKey: AUTH_KEY,
      failureReceiptHash: RECEIPT_HASH,
      operationId: "op-agent-2",
      timestamp: ctx.timestamp,
    });
    expect(result.task.status).toBe("abandoned");
    expect(result.evidence).toBeNull();
    expect(result.staged).toBe(false);
    expect(git.staged).toBe(false);
    expect(result.escapedPaths).toEqual(["src/secret/keys.ts"]);
    expect(result.reason).toMatch(/escaped its authority/iu);
  });

  it("(d') agent changes a PROTECTED path (inside approvedPaths tree) → abandon, no evidence", async () => {
    const git = fakeAgentGit(["src/foo.ts"]);
    const result = await applyAgentRepair({
      task: agentTask("unit-test"),
      diagnosis: unitTestDiagnosis,
      runner: fakeAgentRunner(true),
      git,
      approvedPaths: ["src"],
      protectedPaths: ["src/foo.ts"],
      authenticationKey: AUTH_KEY,
      failureReceiptHash: RECEIPT_HASH,
      operationId: "op-agent-3",
      timestamp: ctx.timestamp,
    });
    expect(result.task.status).toBe("abandoned");
    expect(result.evidence).toBeNull();
    expect(result.escapedPaths).toEqual(["src/foo.ts"]);
  });

  it("(e) agent produced no diff → abandoned, no evidence (would recur)", async () => {
    const git = fakeAgentGit([]);
    const result = await applyAgentRepair({
      task: agentTask("unit-test"),
      diagnosis: unitTestDiagnosis,
      runner: fakeAgentRunner(true),
      git,
      approvedPaths: APPROVED,
      authenticationKey: AUTH_KEY,
      failureReceiptHash: RECEIPT_HASH,
      operationId: "op-agent-4",
      timestamp: ctx.timestamp,
    });
    expect(result.task.status).toBe("abandoned");
    expect(result.evidence).toBeNull();
    expect(result.staged).toBe(false);
    expect(result.reason).toMatch(/no diff|would recur/iu);
  });

  it("agent run fails (not ok) → abandoned, no evidence, no git inspection", async () => {
    const git = fakeAgentGit(["src/foo.ts"]);
    const result = await applyAgentRepair({
      task: agentTask("typecheck"),
      diagnosis: typecheckDiagnosis,
      runner: fakeAgentRunner(false, "agent hit its round budget"),
      git,
      approvedPaths: APPROVED,
      authenticationKey: AUTH_KEY,
      failureReceiptHash: RECEIPT_HASH,
      operationId: "op-agent-5",
      timestamp: ctx.timestamp,
    });
    expect(result.task.status).toBe("abandoned");
    expect(result.evidence).toBeNull();
    expect(result.staged).toBe(false);
    expect(result.reason).toMatch(/did not succeed/iu);
  });

  it("refuses a non-agent task (deterministic class / requiresAgent false)", async () => {
    const lintTask = decompose(lintDiagnosis, ctx).tasks[0]!;
    const result = await applyAgentRepair({
      task: lintTask,
      diagnosis: lintDiagnosis,
      runner: fakeAgentRunner(true),
      git: fakeAgentGit(["src/util/x.ts"]),
      approvedPaths: ["src/util/x.ts"],
      authenticationKey: AUTH_KEY,
      failureReceiptHash: RECEIPT_HASH,
      operationId: "op-agent-6",
      timestamp: ctx.timestamp,
    });
    expect(result.task.status).toBe("abandoned");
    expect(result.evidence).toBeNull();
    expect(result.reason).toMatch(/non-agent/iu);
  });

  it("buildAgentRepairPrompt carries class, gate, log excerpt and approvedPaths", () => {
    const prompt = buildAgentRepairPrompt({
      task: agentTask("typecheck"),
      diagnosis: typecheckDiagnosis,
      approvedPaths: APPROVED,
      protectedPaths: ["src/autonomy"],
    });
    expect(prompt).toMatch(/typecheck/iu);
    expect(prompt).toContain(typecheckDiagnosis.logExcerpt);
    expect(prompt).toContain(JSON.stringify([...APPROVED]));
    expect(prompt).toMatch(/MUST NOT touch/iu);
    expect(prompt).toMatch(/SMALLEST change/iu);
  });
});
