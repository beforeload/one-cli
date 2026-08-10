import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { resolveRunConfig } from "../config.js";
import { errorMessage, type ChatProvider } from "../domain.js";
import { OpenAICompatibleProvider } from "../provider.js";
import {
  AUTONOMY_MODES,
  loadAutonomyConfig,
  type AutonomyConfig,
  type AutonomyMode,
} from "./config.js";
import type {
  ApprovalBinding,
  Attempt,
  JsonValue,
  LeaseGrant,
  RecoveryEvidence,
} from "./domain.js";
import { GitManager } from "./git.js";
import {
  GhRestTransport,
  GitHubClient,
  type GitHubTransport,
} from "./github.js";
import {
  GhGraphqlTransport,
  type GitHubGraphqlTransport,
} from "./github-graphql.js";
import { GitHubReadClient } from "./github-read.js";
import { TrustedIntake } from "./intake.js";
import {
  communityMonitoringStatus,
  MaintenanceCoordinator,
  ProviderFindingNormalizer,
  ProviderIssueNormalizer,
} from "./maintenance.js";
import {
  AutonomyOrchestrator,
  type MachineRecoveryTarget,
} from "./orchestrator.js";
import type { ExpectedRoadmapBinding } from "./roadmap-enforcement.js";
import {
  SpawnProcessRunner,
  assertProcessSucceeded,
  type ProcessRunner,
} from "./process.js";
import { GitHubResearchPort } from "./research.js";
import {
  ReleaseManager,
  Supervisor,
  type ReleaseCandidateBinding,
} from "./release.js";
import { ProviderReviewer } from "./review.js";
import { DarwinSandbox, type SandboxCommand } from "./sandbox.js";
import { AutonomyScheduler } from "./schedule.js";
import { AutonomyStore } from "./store.js";

const COMMANDS = new Set([
  "init",
  "doctor",
  "once",
  "daemon",
  "status",
  "events",
  "approvals",
  "approve",
  "reject",
  "retry",
  "cancel",
  "resolve-in-doubt",
  "reconcile",
  "gc",
  "release",
  "supervise",
  "schedule",
  "intake",
  "recover",
]);

export async function dispatchAutonomyCli(argv: readonly string[]): Promise<number | undefined> {
  const normalized = argv[0] === "autonomy" ? argv.slice(1) : argv;
  const command = normalized[0];
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(`${autonomyHelpText()}\n`);
    return 0;
  }
  if (!COMMANDS.has(command)) return undefined;
  try {
    return await runCommand(command, normalized.slice(1));
  } catch (error) {
    process.stderr.write(`Autonomy error: ${errorMessage(error)}\n`);
    return 2;
  }
}

interface CliOptions {
  workspace: string;
  output: "text" | "json" | "jsonl";
  mode?: AutonomyMode;
  apply: boolean;
  intervalMs?: number;
  evidence?: string;
  machineEvidence?: string;
  operationId?: string;
  recoveryTarget?: MachineRecoveryTarget | "same-state";
  diagnosis?: string;
  action?: string;
  attemptId?: string;
  executionScope: "normal" | "roadmap-only";
  expectedRoadmapIssue?: number;
  expectedRoadmapMarker?: string;
  positionals: string[];
}

async function runCommand(command: string, argv: readonly string[]): Promise<number> {
  const options = parseOptions(argv);
  assertRoadmapCliBinding(command, options);
  if (command === "doctor") return await doctor(options);
  const config = loadAutonomyConfig(options.workspace, {
    ...(options.mode === undefined ? {} : { mode: options.mode }),
  });
  if (config.mode === "observe") assertObserveCommand(command, options);
  const store = new AutonomyStore(path.join(config.stateRoot, "state.sqlite"), {
    readOnly: config.mode === "observe",
  });
  try {
    switch (command) {
      case "init":
        output(options, {
          ok: true,
          repoKey: config.repoKey,
          stateRoot: config.stateRoot,
          policyHash: config.policyHash,
          mode: config.mode,
          maximumMode: config.maximumMode,
        });
        return 0;
      case "status":
        output(options, {
          schema: "autonomy.one-cli/status-v1",
          executionScope: options.executionScope,
          mode: config.mode,
          monitoring: monitoringSnapshot(config, store),
          activeAttempt: store.getActiveAttempt() ?? null,
          action: latestAutonomyAction(store),
          issues: store.listIssues(config.repoKey),
          attempts: store.listAttempts(),
        });
        return 0;
      case "events": {
        const events = store.listEvents({ limit: 1_000 });
        const monitoring = monitoringSnapshot(config, store);
        if (options.output === "json") {
          output(options, { monitoring, events });
        } else {
          for (const event of events) output(options, event, options.output === "jsonl");
          output(
            options,
            { type: "autonomy.monitoring-status", data: monitoring },
            options.output === "jsonl",
          );
        }
        return 0;
      }
      case "approvals":
        output(options, store.listApprovals());
        return 0;
      case "approve":
      case "reject":
        return decideApproval(command, options, config, store);
      case "retry":
        return await retry(options, config, store);
      case "recover":
        return await recoverCommand(options, config, store);
      case "cancel":
        return await cancel(options, config, store);
      case "resolve-in-doubt":
        return await resolveInDoubt(options, config, store);
      case "once":
        return await once(options, config, store);
      case "daemon":
        return await daemon(options, config, store);
      case "reconcile":
        return await reconcile(options, config, store);
      case "gc":
        return await gc(options, config, store);
      case "release":
        return await releaseCommand(options, config, store);
      case "supervise":
        return await supervise(options, config);
      case "schedule":
        return await scheduleCommand(options, config, store);
      case "intake":
        return await intakeCommand(options, config, store);
      default:
        throw new Error(`Unsupported autonomy command: ${command}`);
    }
  } finally {
    store.close();
  }
}

function assertObserveCommand(command: string, options: CliOptions): void {
  const readOnly =
    ["init", "status", "events", "approvals", "once", "daemon", "schedule"].includes(command) ||
    (command === "release" && options.positionals[0] === "status") ||
    (["reconcile", "gc"].includes(command) && !options.apply);
  if (!readOnly) {
    throw new Error(`Autonomy ${command} is unavailable in observe mode`);
  }
}

async function doctor(options: CliOptions): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
  let config: AutonomyConfig | undefined;
  try {
    config = loadAutonomyConfig(options.workspace, {
      ...(options.mode === undefined ? {} : { mode: options.mode }),
    });
    checks.push({ name: "configuration", ok: true, detail: config.policyHash });
  } catch (error) {
    checks.push({ name: "configuration", ok: false, detail: errorMessage(error) });
  }
  checks.push({
    name: "provider-credentials",
    ok: Boolean(process.env.OPENAI_API_KEY && process.env.OPENAI_MODEL),
    detail:
      process.env.OPENAI_API_KEY && process.env.OPENAI_MODEL
        ? "configured"
        : "OPENAI_API_KEY and OPENAI_MODEL are required for implementation and review",
  });
  try {
    const gh = await new SpawnProcessRunner().run({
      executable: resolveExecutable("gh"),
      args: ["auth", "status"],
      env: safeHostEnvironment(),
      timeoutMs: 15_000,
      maxOutputBytes: 256 * 1024,
    });
    checks.push({
      name: "github-auth",
      ok: gh.exitCode === 0,
      detail:
        gh.exitCode === 0
          ? "authenticated gh configuration"
          : gh.stderr.trim() || "gh auth unavailable",
    });
  } catch (error) {
    checks.push({ name: "github-auth", ok: false, detail: errorMessage(error) });
  }
  if (config) {
    try {
      const sandbox = sandboxFor(config, config.repoRoot);
      const availability = sandbox.availability();
      checks.push({
        name: "darwin-sandbox",
        ok: availability.available,
        detail: availability.available ? "available" : availability.reason ?? "unavailable",
      });
    } catch (error) {
      checks.push({ name: "darwin-sandbox", ok: false, detail: errorMessage(error) });
    }
    try {
      const safety = await new GitHubClient(hostGhRestTransport()).getRepositorySafety(
        { owner: config.product.repository.owner, repo: config.product.repository.name },
        config.product.repository.defaultBranch,
      );
      const missingChecks = config.qualityGates.githubChecks.required.filter(
        (name) => !safety.requiredCheckNames.includes(name),
      );
      checks.push({
        name: "branch-protection",
        ok:
          safety.branchProtected &&
          safety.canPush &&
          safety.defaultBranch === config.product.repository.defaultBranch &&
          missingChecks.length === 0,
        detail:
          !safety.canPush
            ? "authenticated GitHub identity lacks merge authority"
            : missingChecks.length === 0
            ? `protected default branch ${safety.defaultBranch}`
            : `protection is missing required checks: ${missingChecks.join(", ")}`,
      });
    } catch (error) {
      checks.push({
        name: "branch-protection",
        ok: false,
        detail: `Auto-merge readiness could not prove branch protection: ${errorMessage(error)}`,
      });
    }
  }
  output(options, { ok: checks.every((check) => check.ok), checks });
  return checks.some((check) => !check.ok) ? 1 : 0;
}

function decideApproval(
  command: "approve" | "reject",
  options: CliOptions,
  config: AutonomyConfig,
  store: AutonomyStore,
): number {
  const attempt = selectedAttempt(options, store);
  const issue = store.getIssue(attempt.issueId);
  if (!issue) throw new Error("Attempt issue is missing");
  const binding: ApprovalBinding = {
    issueId: attempt.issueId,
    action:
      options.action ??
      (typeof record(attempt.detail).pendingApprovalAction === "string"
        ? (record(attempt.detail).pendingApprovalAction as string)
        : "merge"),
    issueDigest: issue.digest,
    policyHash: config.policyHash,
    headSha:
      options.action === "promote-release"
        ? releaseManager(config).status().candidateBinding?.headSha ?? attempt.headSha
        : attempt.headSha,
    ...(options.action === "promote-release"
      ? {
          bindingRef: releaseApprovalBindingRef(
            requiredCandidateBinding(releaseManager(config).status().candidateBinding),
          ),
        }
      : typeof record(attempt.detail).pendingApprovalBindingRef === "string"
      ? { bindingRef: record(attempt.detail).pendingApprovalBindingRef as string }
      : {}),
  };
  const approval = store.recordApproval({
    id: randomUUID(),
    binding,
    decision: command === "approve" ? "approved" : "denied",
    expiresAt: Date.now() + 24 * 60 * 60_000,
  });
  output(options, approval);
  return 0;
}

async function retry(
  options: CliOptions,
  config: AutonomyConfig,
  store: AutonomyStore,
): Promise<number> {
  const attempt = selectedAttempt(options, store);
  const evidence =
    options.evidence === undefined ? "" : readEvidence(config.repoRoot, options.evidence);
  const result = await orchestratorRuntime(
    config,
    store,
    options.executionScope,
    roadmapBinding(options),
  ).breakGlassRetryAttempt(
    attempt.id,
    evidence,
    new AbortController().signal,
  );
  output(options, result);
  return result.state === "in_doubt" ? 1 : 0;
}

async function recoverCommand(
  options: CliOptions,
  config: AutonomyConfig,
  store: AutonomyStore,
): Promise<number> {
  const [operation, attemptId, extra] = options.positionals;
  if (!operation || !attemptId || extra !== undefined) {
    throw new Error("recover requires probe|retry <attempt-id>");
  }
  if (
    options.apply ||
    options.evidence !== undefined ||
    options.action !== undefined ||
    options.attemptId !== undefined ||
    options.intervalMs !== undefined
  ) {
    throw new Error("recover received an option that is not valid for machine recovery");
  }
  if (!options.operationId) throw new Error("recover requires --operation-id");
  const recoveryKey = readHostRecoveryKey(config);
  const orchestrator = orchestratorRuntime(
    config,
    store,
    options.executionScope,
    roadmapBinding(options),
  );
  if (operation === "probe") {
    if (
      options.machineEvidence !== undefined ||
      options.recoveryTarget !== undefined ||
      options.diagnosis !== undefined
    ) {
      throw new Error("recover probe accepts only its attempt and operation ID");
    }
    output(
      options,
      await orchestrator.probeAttemptFailureGate(
        attemptId,
        options.operationId,
        new AbortController().signal,
      ),
    );
    return 0;
  }
  if (operation !== "retry") throw new Error("recover requires probe or retry");
  if (!options.machineEvidence) {
    throw new Error("recover retry requires --machine-evidence <file|->");
  }
  if (options.recoveryTarget !== undefined || options.diagnosis !== undefined) {
    throw new Error("recover retry derives target and diagnosis from verified host evidence");
  }
  const evidence = await readMachineRecoveryEvidence(config, options.machineEvidence);
  if (evidence.provenance.operationId !== options.operationId) {
    throw new Error("Machine evidence operation ID does not match --operation-id");
  }
  const result = await orchestrator.retryAttemptWithMachineEvidence(
    attemptId,
    evidence,
    new AbortController().signal,
    { authenticationKey: recoveryKey },
  );
  output(options, result);
  return result.state === "in_doubt" ? 1 : 0;
}

async function cancel(
  options: CliOptions,
  config: AutonomyConfig,
  store: AutonomyStore,
): Promise<number> {
  const attempt = selectedAttempt(options, store);
  const result = await orchestratorRuntime(
    config,
    store,
    options.executionScope,
    roadmapBinding(options),
  ).cancelAttempt(
    attempt.id,
    "operator cancellation",
    new AbortController().signal,
  );
  output(options, result);
  return result.state === "in_doubt" ? 1 : 0;
}

async function resolveInDoubt(
  options: CliOptions,
  config: AutonomyConfig,
  store: AutonomyStore,
): Promise<number> {
  const attempt = selectedAttempt(options, store);
  if (attempt.state !== "in_doubt") throw new Error("Attempt is not in_doubt");
  const target = options.positionals[1];
  if (!target || !["failed", "cancelled"].includes(target)) {
    throw new Error(
      "resolve-in-doubt only permits failed|cancelled; use reconcile to prove external success",
    );
  }
  const result = await orchestratorRuntime(
    config,
    store,
    options.executionScope,
    roadmapBinding(options),
  ).resolveAttemptInDoubt(
    attempt.id,
    target as "failed" | "cancelled",
    new AbortController().signal,
  );
  output(options, result);
  return result.state === "in_doubt" ? 1 : 0;
}

async function once(
  options: CliOptions,
  config: AutonomyConfig,
  store: AutonomyStore,
  signal = new AbortController().signal,
): Promise<number> {
  const coordinator = runtime(config, store, options.executionScope, roadmapBinding(options));
  const result = await coordinator.tick(signal);
  output(options, result);
  return ["blocked", "failed", "in_doubt"].includes(result.state) ? 1 : 0;
}

async function daemon(
  options: CliOptions,
  config: AutonomyConfig,
  store: AutonomyStore,
): Promise<number> {
  const controller = new AbortController();
  const onSignal = () => controller.abort(new DOMException("Daemon stopped", "AbortError"));
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  const interval = options.intervalMs ?? config.product.limits.loopMinutes * 60_000;
  const coordinator = runtime(config, store, options.executionScope, roadmapBinding(options));
  try {
    while (!controller.signal.aborted) {
      try {
        const result = await coordinator.tick(controller.signal);
        output(options, result, options.output === "jsonl");
      } catch (error) {
        if (controller.signal.aborted) break;
        const detail = errorMessage(error);
        if (config.mode !== "observe") {
          store.appendEvent({
            aggregateType: "daemon",
            aggregateId: config.repoKey,
            type: "daemon.tick-failed",
            data: { detail },
          });
        }
        output(options, { action: "tick-error", state: "waiting", detail }, options.output === "jsonl");
      }
      if (controller.signal.aborted) break;
      await wait(interval, controller.signal);
    }
    return 0;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

async function reconcile(
  options: CliOptions,
  config: AutonomyConfig,
  store: AutonomyStore,
): Promise<number> {
  if (!options.apply) {
    output(options, {
      dryRun: true,
      activeAttempt: store.getActiveAttempt() ?? null,
      action: "No state changed; pass --apply to reconcile against GitHub",
    });
    return 0;
  }
  const result = await orchestratorRuntime(
    config,
    store,
    options.executionScope,
    roadmapBinding(options),
  ).reconcile(new AbortController().signal);
  output(options, result ?? { action: "reconcile", state: "unchanged" });
  return result?.state === "in_doubt" ? 1 : 0;
}

async function gc(
  options: CliOptions,
  config: AutonomyConfig,
  store: AutonomyStore,
): Promise<number> {
  const terminal = store
    .listAttempts()
    .filter((attempt) => ["succeeded", "failed", "cancelled"].includes(attempt.state));
  const candidates = terminal.flatMap((attempt) => {
    const detail = record(attempt.detail);
    return [detail.worktreePath, detail.postWorktreePath].filter(
      (value): value is string => typeof value === "string",
    );
  });
  if (!options.apply) {
    output(options, { dryRun: true, candidates });
    return 0;
  }
  const git = new GitManager({ storageRoot: path.join(config.stateRoot, "git") });
  const repository = await git.ensureBare(config.repoKey, remoteUrl(config));
  const removed: string[] = [];
  for (const candidate of candidates) {
    const id = path.basename(candidate);
    const worktree = { id, repositoryId: config.repoKey, path: candidate };
    try {
      await git.removeWorktree(repository, worktree);
      removed.push(candidate);
    } catch {
      // Dirty, missing, or non-managed paths are intentionally preserved.
    }
  }
  output(options, { dryRun: false, removed, preserved: candidates.filter((path) => !removed.includes(path)) });
  return 0;
}

async function releaseCommand(
  options: CliOptions,
  config: AutonomyConfig,
  store: AutonomyStore,
): Promise<number> {
  const [operation, sha, extra] = options.positionals;
  if (extra !== undefined) throw new Error("Too many release arguments");
  const releases = releaseManager(config);
  if (operation === "status") {
    if (sha !== undefined) throw new Error("release status does not accept a SHA");
    output(options, releases.status());
    return 0;
  }
  if (operation === "stage") {
    if (!sha) throw new Error("release stage requires an exact commit SHA");
    await assertCleanExactHead(config.repoRoot, sha);
    assertArtifactDirectory(config.repoRoot, "dist");
    assertArtifactDirectory(config.repoRoot, "node_modules");
    output(
      options,
      await releases.stage({
        worktreePath: config.repoRoot,
        commitSha: sha,
        binding: candidateBindingForAttempt(
          config,
          store,
          selectedReleaseAttempt(options, store),
          sha,
        ),
      }),
    );
    return 0;
  }
  if (operation === "promote") {
    if (!sha) throw new Error("release promote requires an exact candidate SHA");
    const binding = requiredCandidateBinding(releases.status().candidateBinding);
    if (binding.headSha !== sha) throw new Error("Release candidate binding does not match SHA");
    const attempt = store.getAttempt(binding.attemptId);
    const issue = attempt ? store.getIssue(attempt.issueId) : undefined;
    if (!attempt || !issue) throw new Error("Release candidate attempt binding is missing");
    if (!["post_merge", "succeeded"].includes(attempt.state)) {
      throw new Error("Release candidate attempt is blocked or incomplete");
    }
    if (issue.digest !== binding.issueDigest || config.policyHash !== binding.policyHash) {
      throw new Error("Release candidate issue or policy binding is stale");
    }
    const mergeSha = record(attempt.detail).mergeSha;
    if (typeof mergeSha !== "string" || mergeSha !== binding.headSha) {
      throw new Error("Release candidate head is not bound to the attempt merge");
    }
    const approval = store.findValidApproval({
      issueId: attempt.issueId,
      action: "promote-release",
      issueDigest: binding.issueDigest,
      policyHash: binding.policyHash,
      headSha: binding.headSha,
      bindingRef: releaseApprovalBindingRef(binding),
    });
    if (!approval) {
      throw new Error("release promotion requires a durable valid promote-release approval");
    }
    output(options, releases.promote(sha, 1, binding));
    return 0;
  }
  if (operation === "rollback") {
    output(options, releases.rollback(sha));
    return 0;
  }
  throw new Error("release requires status|stage <sha>|promote <sha>|rollback [sha]");
}

async function supervise(options: CliOptions, config: AutonomyConfig): Promise<number> {
  if (options.positionals.length > 0) throw new Error("supervise accepts options only");
  const daemonArgs = [
    "--workspace",
    config.repoRoot,
    "--mode",
    config.mode,
    "--output",
    options.output,
    ...(options.executionScope === "roadmap-only" ? ["--roadmap-only"] : []),
    ...(options.expectedRoadmapIssue === undefined
      ? []
      : ["--expected-roadmap-issue", String(options.expectedRoadmapIssue)]),
    ...(options.expectedRoadmapMarker === undefined
      ? []
      : ["--expected-roadmap-marker", options.expectedRoadmapMarker]),
    ...(options.intervalMs === undefined
      ? []
      : ["--interval-ms", String(options.intervalMs)]),
  ];
  const result = await new Supervisor({
    releases: releaseManager(config),
    runner: new SpawnProcessRunner(),
  }).launch(daemonArgs);
  output(options, result);
  return result.process.exitCode === 0 && !result.process.timedOut ? 0 : 1;
}

async function scheduleCommand(
  options: CliOptions,
  config: AutonomyConfig,
  store: AutonomyStore,
): Promise<number> {
  const [operation, extra] = options.positionals;
  if (operation !== "status" || extra !== undefined) {
    throw new Error("schedule requires status");
  }
  const now = Date.now();
  const github = new GitHubClient(hostGhRestTransport());
  const promotable = await github.listCandidateIssues(
    { owner: config.product.repository.owner, repo: config.product.repository.name },
    ["source:user", "maintainer-accepted"],
  );
  const ready = await github.listCandidateIssues(
    { owner: config.product.repository.owner, repo: config.product.repository.name },
    ["agent-ready"],
  );
  const scheduler = new AutonomyScheduler(store, config);
  const due = scheduler.due(now);
  const promotableGap = store.selectGapFindings({
    policyHash: config.policyHash,
    now,
    limit: 1,
  });
  const next = scheduler.next({
    now,
    initializeDue: false,
    hasPromotableUserIssue: promotable.length > 0,
    hasPromotableGap: promotableGap.length > 0,
    hasReadyIssue: ready.length > 0,
  });
  output(options, {
    priority: [
      "recovery",
      "security",
      "ci",
      "active-issue",
      "user-promotion",
      "post-merge-dogfood",
      "global-dogfood",
      "gap-promotion",
      "ready-issue",
      "community-scan",
      "idle",
    ],
    due,
    next: next ?? null,
    activeAttempt: store.getActiveAttempt() ?? null,
    promotableUserIssues: promotable.map((issue) => issue.number),
    promotableGapFindings: promotableGap.map((finding) => finding.fingerprint),
    readyIssues: ready.map((issue) => issue.number),
    monitoring: communityMonitoringStatus(config, store, due.communityScan, now),
  });
  return 0;
}

async function intakeCommand(
  options: CliOptions,
  config: AutonomyConfig,
  store: AutonomyStore,
): Promise<number> {
  const [operation, first, second, extra] = options.positionals;
  if (extra !== undefined) throw new Error("Too many intake arguments");
  const github = new GitHubClient(hostGhRestTransport());
  const intake = new TrustedIntake({ config, store, github });
  if (operation === "promote-user") {
    if (!first || !second) {
      throw new Error("intake promote-user requires <issue> <fields-json-file>");
    }
    const issueNumber = Number(first);
    if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
      throw new Error("Issue number must be positive");
    }
    output(options, await intake.promoteUserIssue({
      issueNumber,
      normalizedFields: readNormalizedFields(config.repoRoot, second),
    }));
    return 0;
  }
  if (operation === "promote-community" || operation === "promote-self") {
    if (!first || !second) {
      throw new Error(`intake ${operation} requires <finding-json-file> <fields-json-file>`);
    }
    const finding = readWorkspaceJson(config.repoRoot, first);
    const normalizedFields = readNormalizedFields(config.repoRoot, second);
    const result =
      operation === "promote-community"
        ? await intake.promoteCommunityFinding({
            finding,
            registry: config.community,
            normalizedFields,
          })
        : await intake.promoteSelfDiscovery({ finding, normalizedFields });
    output(options, result);
    return 0;
  }
  throw new Error(
    "intake requires promote-user|promote-community|promote-self with bounded JSON files",
  );
}

function releaseManager(config: AutonomyConfig): ReleaseManager {
  return new ReleaseManager({
    releasesDir: path.join(config.stateRoot, "releases"),
    readOnly: config.mode === "observe",
  });
}

function monitoringSnapshot(
  config: AutonomyConfig,
  store: AutonomyStore,
  now = Date.now(),
) {
  const due = new AutonomyScheduler(store, config).due(now);
  return communityMonitoringStatus(config, store, due.communityScan, now);
}

async function assertCleanExactHead(workspace: string, expectedSha: string): Promise<void> {
  const runner = new SpawnProcessRunner();
  const executable = resolveExecutable("git");
  const request = async (args: readonly string[]) =>
    await runner.run({
      executable,
      args,
      cwd: workspace,
      env: { ...safeHostEnvironment(), GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
      timeoutMs: 30_000,
      maxOutputBytes: 1024 * 1024,
    });
  const head = await request(["rev-parse", "--verify", "HEAD^{commit}"]);
  assertProcessSucceeded("git rev-parse release workspace", head);
  if (head.stdout.trim() !== expectedSha) {
    throw new Error("Release SHA must equal the current workspace HEAD");
  }
  const status = await request(["status", "--porcelain=v1", "--untracked-files=all"]);
  assertProcessSucceeded("git status release workspace", status);
  if (status.stdout !== "") throw new Error("Release workspace must be exactly clean");
}

function assertArtifactDirectory(workspace: string, relative: string): void {
  const candidate = path.join(workspace, relative);
  const stat = fs.lstatSync(candidate);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Release artifact ${relative} must be a real directory`);
  }
  assertWithin(workspace, fs.realpathSync(candidate), `Release artifact ${relative}`);
}

function readNormalizedFields(
  workspace: string,
  filePath: string,
): Readonly<Record<string, string>> {
  const value = readWorkspaceJson(workspace, filePath);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Normalized fields JSON must be an object");
  }
  const fields: Record<string, string> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (typeof nested !== "string") {
      throw new Error(`Normalized field ${key} must be a string`);
    }
    fields[key] = nested;
  }
  return fields;
}

export function readWorkspaceJson(workspace: string, filePath: string): unknown {
  if (!filePath || filePath.includes("\0")) throw new Error("JSON file path is invalid");
  const root = fs.realpathSync(workspace);
  const unresolved = path.resolve(root, filePath);
  assertWithin(root, unresolved, "JSON file");
  const before = fs.lstatSync(unresolved);
  if (before.isSymbolicLink() || !before.isFile() || before.size > 256 * 1024) {
    throw new Error("JSON input must be a bounded regular file");
  }
  const canonical = fs.realpathSync(unresolved);
  assertWithin(root, canonical, "JSON file");
  const fd = fs.openSync(canonical, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size > 256 * 1024
    ) {
      throw new Error("JSON input changed while being opened");
    }
    return JSON.parse(fs.readFileSync(fd, "utf8")) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("JSON input is malformed", { cause: error });
    throw error;
  } finally {
    fs.closeSync(fd);
  }
}

function assertWithin(root: string, candidate: string, label: string): void {
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes the workspace`);
  }
}

function runtime(
  config: AutonomyConfig,
  store: AutonomyStore,
  executionScope: CliOptions["executionScope"] = "normal",
  expectedRoadmapBinding?: ExpectedRoadmapBinding,
): MaintenanceCoordinator {
  const parts = runtimeParts(config, store, executionScope, expectedRoadmapBinding);
  return new MaintenanceCoordinator({
    config,
    store,
    github: parts.github,
    git: parts.git,
    remoteUrl: remoteUrl(config),
    sandboxFactory: (worktreePath) => sandboxFor(config, worktreePath),
    orchestrator: parts.orchestrator,
    intake: parts.intake,
    executionScope,
    ...(expectedRoadmapBinding ? { expectedRoadmapBinding } : {}),
    ...(config.mode === "observe"
      ? {}
      : {
          issueNormalizer: new ProviderIssueNormalizer(parts.provider, parts.runConfig.model),
          findingNormalizer: new ProviderFindingNormalizer(parts.provider, parts.runConfig.model),
          research: parts.research!,
        }),
  });
}

function orchestratorRuntime(
  config: AutonomyConfig,
  store: AutonomyStore,
  executionScope: CliOptions["executionScope"] = "normal",
  expectedRoadmapBinding?: ExpectedRoadmapBinding,
): AutonomyOrchestrator {
  return runtimeParts(config, store, executionScope, expectedRoadmapBinding).orchestrator;
}

function runtimeParts(
  config: AutonomyConfig,
  store: AutonomyStore,
  executionScope: CliOptions["executionScope"] = "normal",
  expectedRoadmapBinding?: ExpectedRoadmapBinding,
): {
  runConfig: ReturnType<typeof resolveRunConfig>;
  provider: ChatProvider;
  github: GitHubClient;
  git: GitManager;
  intake: TrustedIntake;
  orchestrator: AutonomyOrchestrator;
  research?: GitHubResearchPort;
} {
  const runConfig =
    config.mode === "observe"
      ? {
          apiKey: "<disabled>",
          baseUrl: "https://disabled.invalid/v1",
          model: "<disabled>",
          home: config.stateRoot,
          maxRounds: 1,
          maxToolCalls: 1,
          shellTimeoutMs: 1,
        }
      : resolveRunConfig();
  const provider: ChatProvider =
    config.mode === "observe"
      ? {
          async *stream(): AsyncGenerator<never> {
            throw new Error("Provider access is disabled in observe mode");
          },
        }
      : new OpenAICompatibleProvider({
          apiKey: runConfig.apiKey,
          baseUrl: runConfig.baseUrl,
        });
  const githubRuntime = createGitHubRuntimeAdapters(config, store);
  const github = githubRuntime.github;
  const git = new GitManager({
    storageRoot: path.join(config.stateRoot, "git"),
    readOnly: config.mode === "observe",
  });
  const intake = new TrustedIntake({ config, store, github });
  const orchestrator = new AutonomyOrchestrator({
    config,
    store,
    github,
    git,
    remoteUrl: remoteUrl(config),
    sandboxFactory: (worktreePath) => sandboxFor(config, worktreePath),
    reviewer: new ProviderReviewer(provider, runConfig.model),
    provider,
    runConfig,
    intake,
    release: releaseManager(config),
    executionScope,
    ...(expectedRoadmapBinding ? { expectedRoadmapBinding } : {}),
  });
  return {
    runConfig,
    provider,
    github,
    git,
    intake,
    orchestrator,
    ...(githubRuntime.research === undefined ? {} : { research: githubRuntime.research }),
  };
}

export interface GitHubRuntimeAdapterOptions {
  runner?: ProcessRunner;
  rest?: GitHubTransport;
  graphql?: GitHubGraphqlTransport;
}

export function createGitHubRuntimeAdapters(
  config: AutonomyConfig,
  store: AutonomyStore,
  options: GitHubRuntimeAdapterOptions = {},
): {
  github: GitHubClient;
  read?: GitHubReadClient;
  research?: GitHubResearchPort;
} {
  const runner = options.runner ?? new SpawnProcessRunner();
  const ghExecutable = process.env.ONE_CLI_GH_EXECUTABLE;
  const executableOptions = ghExecutable === undefined ? {} : { ghExecutable };
  const rest = options.rest ?? new GhRestTransport({ runner, ...executableOptions });
  const github = new GitHubClient(rest);
  if (config.mode === "observe") return { github };
  const graphql = options.graphql ?? new GhGraphqlTransport({ runner, ...executableOptions });
  const read = new GitHubReadClient(rest, graphql);
  const research = new GitHubResearchPort({ store, github: read, config });
  return { github, read, research };
}

function sandboxFor(config: AutonomyConfig, worktreePath: string): DarwinSandbox {
  const commands: Record<string, SandboxCommand> = {};
  for (const command of Object.values(config.commands)) {
    commands[command.name] = {
      executable: resolveExecutable(command.executable),
      args: command.args,
      cwd: worktreePath,
      network: command.network,
    };
  }
  return new DarwinSandbox({ workspace: worktreePath, commands });
}

function selectedAttempt(options: CliOptions, store: AutonomyStore): Attempt {
  const id = options.positionals[0];
  const attempt = id ? store.getAttempt(id) : store.getActiveAttempt();
  if (!attempt) throw new Error(id ? `Unknown attempt "${id}"` : "There is no active attempt");
  return attempt;
}

function parseOptions(argv: readonly string[]): CliOptions {
  let workspace = process.cwd();
  let outputFormat: CliOptions["output"] = "text";
  let mode: AutonomyMode | undefined;
  let apply = false;
  let intervalMs: number | undefined;
  let evidence: string | undefined;
  let machineEvidence: string | undefined;
  let operationId: string | undefined;
  let recoveryTarget: MachineRecoveryTarget | "same-state" | undefined;
  let diagnosis: string | undefined;
  let action: string | undefined;
  let attemptId: string | undefined;
  let executionScope: CliOptions["executionScope"] = "normal";
  let expectedRoadmapIssue: number | undefined;
  let expectedRoadmapMarker: string | undefined;
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index]!;
    if (value === "--workspace") workspace = requiredValue(argv, ++index, value);
    else if (value === "--output") {
      const candidate = requiredValue(argv, ++index, value);
      if (!["text", "json", "jsonl"].includes(candidate)) throw new Error("Invalid --output");
      outputFormat = candidate as CliOptions["output"];
    } else if (value === "--mode") {
      const candidate = requiredValue(argv, ++index, value);
      if (!AUTONOMY_MODES.includes(candidate as AutonomyMode)) throw new Error("Invalid --mode");
      mode = candidate as AutonomyMode;
    } else if (value === "--apply") apply = true;
    else if (value === "--dry-run") apply = false;
    else if (value === "--interval-ms") {
      const candidate = Number(requiredValue(argv, ++index, value));
      if (!Number.isSafeInteger(candidate) || candidate < 1_000) {
        throw new Error("--interval-ms must be an integer of at least 1000");
      }
      intervalMs = candidate;
    } else if (value === "--evidence") {
      evidence = requiredValue(argv, ++index, value);
    } else if (value === "--machine-evidence") {
      machineEvidence = requiredValue(argv, ++index, value);
    } else if (value === "--operation-id") {
      operationId = requiredValue(argv, ++index, value);
      if (Buffer.byteLength(operationId) > 512 || /[\0\r\n]/u.test(operationId)) {
        throw new Error("--operation-id is invalid");
      }
    } else if (value === "--target") {
      const target = requiredValue(argv, ++index, value);
      if (target !== "same-state" && target !== "implementing" && target !== "verifying") {
        throw new Error("--target must be same-state, implementing, or verifying");
      }
      recoveryTarget = target;
    } else if (value === "--diagnosis") {
      diagnosis = requiredValue(argv, ++index, value);
      if (
        ![
          "transient/network/provider",
          "environment/toolchain",
          "code/gate",
          "policy/governance",
          "unknown",
        ].includes(diagnosis)
      ) {
        throw new Error("--diagnosis is invalid");
      }
    } else if (value === "--action") {
      action = requiredValue(argv, ++index, value);
      if (action !== "promote-release") throw new Error("Unsupported --action");
    } else if (value === "--attempt") {
      attemptId = requiredValue(argv, ++index, value);
    } else if (value === "--roadmap-only") {
      executionScope = "roadmap-only";
    } else if (value === "--expected-roadmap-issue") {
      expectedRoadmapIssue = Number(requiredValue(argv, ++index, value));
      if (!Number.isSafeInteger(expectedRoadmapIssue) || expectedRoadmapIssue <= 0) {
        throw new Error("--expected-roadmap-issue must be a positive integer");
      }
    } else if (value === "--expected-roadmap-marker") {
      expectedRoadmapMarker = requiredValue(argv, ++index, value);
    } else if (value.startsWith("-")) throw new Error(`Unknown autonomy option: ${value}`);
    else positionals.push(value);
  }
  return {
    workspace,
    output: outputFormat,
    apply,
    executionScope,
    positionals,
    ...(mode === undefined ? {} : { mode }),
    ...(intervalMs === undefined ? {} : { intervalMs }),
    ...(evidence === undefined ? {} : { evidence }),
    ...(machineEvidence === undefined ? {} : { machineEvidence }),
    ...(operationId === undefined ? {} : { operationId }),
    ...(recoveryTarget === undefined ? {} : { recoveryTarget }),
    ...(diagnosis === undefined ? {} : { diagnosis }),
    ...(action === undefined ? {} : { action }),
    ...(attemptId === undefined ? {} : { attemptId }),
    ...(expectedRoadmapIssue === undefined ? {} : { expectedRoadmapIssue }),
    ...(expectedRoadmapMarker === undefined ? {} : { expectedRoadmapMarker }),
  };
}

function roadmapBinding(options: CliOptions): ExpectedRoadmapBinding | undefined {
  return options.expectedRoadmapIssue === undefined || options.expectedRoadmapMarker === undefined
    ? undefined
    : {
        issueNumber: options.expectedRoadmapIssue,
        seedMarker: options.expectedRoadmapMarker,
      };
}

function assertRoadmapCliBinding(command: string, options: CliOptions): void {
  const hasIssue = options.expectedRoadmapIssue !== undefined;
  const hasMarker = options.expectedRoadmapMarker !== undefined;
  if (hasIssue !== hasMarker) {
    throw new Error("Expected roadmap issue and marker must be supplied together");
  }
  if ((hasIssue || hasMarker) && options.executionScope !== "roadmap-only") {
    throw new Error("Expected roadmap binding is valid only with --roadmap-only");
  }
  if (
    options.executionScope === "roadmap-only" &&
    command !== "status" &&
    (!hasIssue || !hasMarker)
  ) {
    throw new Error("Roadmap-only execution requires exact expected issue and marker arguments");
  }
}

function output(options: CliOptions, value: unknown, forceLine = false): void {
  if (options.output === "json" && !forceLine) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  } else if (options.output === "jsonl" || forceLine) {
    process.stdout.write(`${JSON.stringify(value)}\n`);
  } else if (Array.isArray(value)) {
    for (const item of value) process.stdout.write(`${text(item)}\n`);
  } else {
    process.stdout.write(`${text(value)}\n`);
  }
}

function text(value: unknown): string {
  if (!value || typeof value !== "object") return String(value);
  return Object.entries(value as Record<string, unknown>)
    .map(([key, nested]) => `${key}=${typeof nested === "object" ? JSON.stringify(nested) : String(nested)}`)
    .join("\t");
}

function requiredValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function resolveExecutable(executable: string): string {
  if (path.isAbsolute(executable)) return fs.realpathSync(executable);
  if (executable.includes("/") || executable.includes("\0")) throw new Error("Command executable is invalid");
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, executable);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch {
      // Continue searching trusted host PATH entries.
    }
  }
  throw new Error(`Executable not found on PATH: ${executable}`);
}

function safeHostEnvironment(): Readonly<Record<string, string>> {
  const environment: Record<string, string> = { NO_COLOR: "1" };
  for (const name of ["HOME", "PATH", "XDG_CONFIG_HOME", "GH_CONFIG_DIR", "GH_HOST"]) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

function hostGhRestTransport(): GhRestTransport {
  const ghExecutable = process.env.ONE_CLI_GH_EXECUTABLE;
  return new GhRestTransport(ghExecutable === undefined ? {} : { ghExecutable });
}

function remoteUrl(config: AutonomyConfig): string {
  return `https://github.com/${config.product.repository.owner}/${config.product.repository.name}.git`;
}

function record(value: JsonValue | null): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, JsonValue>) }
    : {};
}

async function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function autonomyHelpText(): string {
  return `Usage:
  one-cli autonomy <subcommand> [options]

Subcommands:
  init doctor once daemon status events approvals approve reject retry cancel
  resolve-in-doubt reconcile gc supervise
  release status|stage <sha>|promote <sha>|rollback [sha]
  schedule status
  intake promote-user <issue> <fields-json-file>
  intake promote-community <finding-json-file> <fields-json-file>
  intake promote-self <finding-json-file> <fields-json-file>
  recover probe <attempt-id> --operation-id <id>
  recover retry <attempt-id> --machine-evidence <file|-> --operation-id <id>

Options:
  --workspace <dir>  Repository root
  --mode <mode>      observe|propose|auto-pr|auto-merge (bounded by trusted maximum)
  --output <format>  text|json|jsonl
  --interval-ms <n>  Daemon/supervisor interval (minimum 1000)
  --evidence <text|file>  Manual break-glass diagnosis evidence for retry
  --machine-evidence <file|->  Canonical bounded recovery evidence under ONE_CLI_HOME or stdin
  --operation-id <id>  Machine recovery idempotency operation ID
  --attempt <id>     Attempt binding for release stage
  --action promote-release  Record a release-promotion approval
  --roadmap-only      Execute only agent-ready cold-start roadmap issues
  --expected-roadmap-issue <n>  Host-bound next roadmap issue
  --expected-roadmap-marker <marker>  Host-bound exact manifest marker
  --apply            Apply reconcile or garbage collection`;
}

function latestAutonomyAction(store: AutonomyStore): {
  type: string;
  aggregateId: string;
  createdAt: number;
} | null {
  const event = store.listEvents({ limit: 1_000 }).at(-1);
  return event
    ? { type: event.type, aggregateId: event.aggregateId, createdAt: event.createdAt }
    : null;
}

function readEvidence(workspace: string, value: string): string {
  const candidate = path.resolve(workspace, value);
  if (!fs.existsSync(candidate)) {
    if (Buffer.byteLength(value) > 4_096 || value.includes("\0")) {
      throw new Error("Retry evidence must be bounded and NUL-free");
    }
    return value;
  }
  const root = fs.realpathSync(workspace);
  assertWithin(root, candidate, "Evidence file");
  const stat = fs.lstatSync(candidate);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 4_096) {
    throw new Error("Evidence file must be a bounded regular workspace file");
  }
  return fs.readFileSync(candidate, "utf8");
}

async function readMachineRecoveryEvidence(
  config: AutonomyConfig,
  value: string,
): Promise<RecoveryEvidence> {
  const maximumBytes = 64 * 1024;
  let bytes: Buffer;
  if (value === "-") {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of process.stdin) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.byteLength;
      if (total > maximumBytes) throw new Error("Machine evidence stdin exceeds its byte bound");
      chunks.push(buffer);
    }
    bytes = Buffer.concat(chunks);
  } else {
    if (value.includes("\0")) throw new Error("Machine evidence file path is invalid");
    const oneCliHome = path.resolve(config.stateRoot, "..", "..");
    const root = fs.realpathSync(oneCliHome);
    const unresolved = path.resolve(root, value);
    assertWithin(root, unresolved, "Machine evidence file");
    const before = fs.lstatSync(unresolved);
    if (before.isSymbolicLink() || !before.isFile() || before.size > maximumBytes) {
      throw new Error("Machine evidence must be a bounded regular file under ONE_CLI_HOME");
    }
    const canonical = fs.realpathSync(unresolved);
    assertWithin(root, canonical, "Machine evidence file");
    const descriptor = fs.openSync(canonical, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const opened = fs.fstatSync(descriptor);
      if (
        !opened.isFile() ||
        opened.dev !== before.dev ||
        opened.ino !== before.ino ||
        opened.size > maximumBytes
      ) {
        throw new Error("Machine evidence changed while being opened");
      }
      bytes = fs.readFileSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  }
  const source = bytes.toString("utf8").trim();
  if (!source) throw new Error("Machine evidence JSON is empty");
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error("Machine evidence JSON is malformed", { cause: error });
  }
  if (JSON.stringify(parsed) !== source) {
    throw new Error("Machine evidence JSON must use canonical compact serialization");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Machine evidence JSON must be an object");
  }
  return parsed as RecoveryEvidence;
}

function readHostRecoveryKey(config: AutonomyConfig): Buffer {
  const oneCliHome = path.resolve(config.stateRoot, "..", "..");
  const expected = path.join(oneCliHome, "harness", "recovery.key");
  let descriptor: number | undefined;
  try {
    const before = fs.lstatSync(expected);
    if (
      before.isSymbolicLink() ||
      !before.isFile() ||
      before.size !== 32 ||
      (before.mode & 0o777) !== 0o600 ||
      fs.realpathSync(expected) !== expected
    ) {
      throw new Error("Host recovery key must be a canonical 0600 regular 32-byte file");
    }
    descriptor = fs.openSync(expected, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const opened = fs.fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.size !== 32 ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      (opened.mode & 0o777) !== 0o600
    ) {
      throw new Error("Host recovery key changed while being opened");
    }
    return fs.readFileSync(descriptor);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error("Host recovery key is missing; machine recovery fails closed");
    }
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function selectedReleaseAttempt(options: CliOptions, store: AutonomyStore): Attempt {
  const attempt = options.attemptId
    ? store.getAttempt(options.attemptId)
    : store.getActiveAttempt();
  if (!attempt) throw new Error("release stage requires --attempt <id>");
  return attempt;
}

function candidateBindingForAttempt(
  config: AutonomyConfig,
  store: AutonomyStore,
  attempt: Attempt,
  releaseSha: string,
): ReleaseCandidateBinding {
  const issue = store.getIssue(attempt.issueId);
  if (!issue) throw new Error("Release attempt issue is missing");
  const mergeSha = record(attempt.detail).mergeSha;
  if (
    !["post_merge", "succeeded"].includes(attempt.state) ||
    typeof mergeSha !== "string" ||
    mergeSha !== releaseSha
  ) {
    throw new Error("Release SHA must equal the bound attempt merge SHA");
  }
  let approval: ReleaseCandidateBinding["approval"];
  if (record(attempt.detail).approvalRequired === true) {
    const bindingRef = `${attempt.baseSha}:${attempt.headSha}`;
    const durable = store.findValidApproval({
      issueId: attempt.issueId,
      action: "merge",
      issueDigest: issue.digest,
      policyHash: config.policyHash,
      headSha: attempt.headSha,
      bindingRef,
    });
    if (!durable) throw new Error("Required approval is not valid for release staging");
    approval = { approvalId: durable.id, action: "merge", bindingRef };
  }
  return {
    attemptId: attempt.id,
    issueDigest: issue.digest,
    policyHash: config.policyHash,
    headSha: releaseSha,
    ...(approval ? { approval } : {}),
  };
}

function requiredCandidateBinding(
  binding: ReleaseCandidateBinding | null | undefined,
): ReleaseCandidateBinding {
  if (!binding) throw new Error("Release candidate has no durable attempt binding");
  return binding;
}

function releaseApprovalBindingRef(binding: ReleaseCandidateBinding): string {
  return [
    binding.attemptId,
    binding.issueDigest,
    binding.policyHash,
    binding.headSha,
    binding.approval?.approvalId ?? "no-required-approval",
  ].join(":");
}
