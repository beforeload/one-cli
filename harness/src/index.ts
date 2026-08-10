#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { GhClient } from "./github.js";
import type { HostIssue } from "./github.js";
import { partitionLocalEnvironment } from "./github-app.js";
import {
  GhGovernanceReadinessPort,
  type GovernanceReadiness,
  type GovernanceReadinessPort,
} from "./governance.js";
import { resolveGhExecutable } from "./executable.js";
import {
  HostJournal,
  HostStateCorruptionError,
  acquireHarnessLock,
  loadHostEnvironment,
  loadOrCreateRecoveryKey,
  resolveHarnessPaths,
} from "./host.js";
import {
  installLaunchd,
  launchdPlist,
  launchdStatus,
  uninstallLaunchd,
} from "./launchd.js";
import { OneCliClient } from "./one-cli.js";
import { assertRoadmapParent, loadRoadmap, type Roadmap } from "./roadmap.js";
import { SpawnProcessRunner, requireSuccess } from "./runner.js";
import { seedRoadmap } from "./seed.js";
import { SeedOperationJournal } from "./seed-state.js";
import { resolveHarnessRelease } from "./release.js";
import { ColdStartSupervisor, readRoadmapHandoff } from "./supervisor.js";
import {
  inspectTrustedVerifier,
  loadVerifierPolicy,
  type TrustedVerifierReadiness,
} from "./verifier.js";

const COMMANDS = new Set([
  "doctor",
  "verifier-status",
  "seed",
  "run",
  "status",
  "install",
  "uninstall",
]);

export interface Options {
  command: string;
  workspace: string;
  apply: boolean;
  dryRun: boolean;
  once: boolean;
  intervalMs: number;
  roadmapPath: string;
  bootstrapMergeSha?: string;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    if (argv.length === 0 || argv[0] === "--help" || argv[0] === "help") {
      process.stdout.write(`${helpText()}\n`);
      return 0;
    }
    const options = parseOptions(argv);
    const paths = resolveHarnessPaths();
    const hostEnv = loadHostEnvironment(paths.envFile);
    const environment = safeEnvironment(paths.oneCliHome, hostEnv);
    const repository = loadRepository(options.workspace);
    const partition = partitionLocalEnvironment(environment);
    const runner = new SpawnProcessRunner(Object.values(hostEnv));
    const verifierPolicy = loadVerifierPolicy(defaultVerifierPolicy());
    const verifier = inspectTrustedVerifier(
      options.workspace,
      verifierPolicy,
      partition.rejectedVerifierSecrets,
    );
    const ghExecutable = resolveGhExecutable(
      partition.worker,
      options.command === "doctor" ||
        options.command === "install" ||
        options.command === "verifier-status" ||
        (options.command === "run" && options.dryRun),
    );
    const workerEnvironment: Record<string, string> = {
      ...partition.worker,
      ONE_CLI_GH_EXECUTABLE: ghExecutable,
    };
    const governance = new GhGovernanceReadinessPort({
      runner,
      ghExecutable,
      environment: workerEnvironment,
      repository,
      policy: verifierPolicy,
      ...(partition.verifierAppId === undefined
        ? {}
        : { verifierAppId: partition.verifierAppId }),
    });
    if (options.command === "verifier-status") {
      const readiness = await governance.inspect();
      const ready = verifier.ready && readiness.ready;
      output({ ...verifier, ready, governance: readiness });
      return ready ? 0 : 1;
    }
    if (options.command === "run" && options.dryRun) {
      const readiness = await governance.inspect();
      const ready = verifier.ready && readiness.ready;
      output({
        schema: "one-cli.harness/tick-v1",
        action: "governance-readiness",
        state: ready ? "idle" : "blocked",
        phase: "normal",
        detail: ready
          ? "Dry-run inspected live governance; no subprocess, journal, or external write ran"
          : governanceFailureDetail(readiness, verifier),
        dryRun: true,
        governance: readiness,
      });
      return ready ? 0 : 1;
    }
    const recoveryKey = loadOrCreateRecoveryKey(paths.recoveryKey);
    const journal = new HostJournal(paths.journal, Object.values(hostEnv));
    const roadmap = loadRoadmap(options.roadmapPath);
    const github = new GhClient(runner, repository, ghExecutable, workerEnvironment);
    let builderIdentityDetail = "not probed";
    let builderIdentityHealthy = false;
    if (
      options.command === "doctor" ||
      options.command === "run" ||
      (options.command === "seed" && options.apply)
    ) {
      try {
        builderIdentityDetail = await probeLeastPrivilegeBuilder({
          runner,
          ghExecutable,
          environment: workerEnvironment,
          ...(workerEnvironment.ONE_CLI_BUILDER_APP_ID === undefined
            ? {}
            : { expectedAppId: workerEnvironment.ONE_CLI_BUILDER_APP_ID }),
        });
        builderIdentityHealthy = true;
      } catch (error) {
        builderIdentityDetail = message(error);
        if (options.command === "run" || (options.command === "seed" && options.apply)) {
          throw new Error(`Least-privilege builder identity is not ready: ${builderIdentityDetail}`);
        }
      }
    }
    const oneCli = new OneCliClient(
      runner,
      options.workspace,
      () => resolveHarnessRelease(paths.oneCliHome, options.workspace, repository.repoKey),
      workerEnvironment,
    );
    const seedOperations = new SeedOperationJournal(paths.seedOperations);

    switch (options.command) {
      case "doctor": {
        const readiness = await governance.inspect();
        const checks: Array<{ name: string; ok: boolean; detail: string }> = [
          {
            name: "roadmap",
            ok: true,
            detail: `${roadmap.children.length} strict dependency-ordered children`,
          },
          {
            name: "built-one-cli",
            ok: regularFile(oneCli.entrypoint),
            detail: oneCli.entrypoint,
          },
          {
            name: "host-state",
            ok: path.resolve(paths.stateRoot).startsWith(`${path.resolve(options.workspace)}${path.sep}`)
              ? false
              : true,
            detail: paths.stateRoot,
          },
          {
            name: "independent-verifier",
            ok: verifier.ready,
            detail: verifier.detail,
          },
          {
            name: "builder-identity",
            ok: builderIdentityHealthy,
            detail: builderIdentityDetail,
          },
          ...readiness.checks.map((check) => ({
            name: `governance:${check.name}`,
            ok: check.ok,
            detail: check.detail,
          })),
        ];
        try {
          await github.authStatus();
          checks.push({ name: "github-auth", ok: true, detail: "authenticated gh configuration" });
        } catch (error) {
          checks.push({ name: "github-auth", ok: false, detail: message(error) });
        }
        try {
          const result = await oneCli.doctor();
          checks.push({
            name: "one-cli-doctor",
            ok: result.ok,
            detail: result.checks.filter((check) => !check.ok).map((check) => check.name).join(", ") || "ok",
          });
        } catch (error) {
          checks.push({ name: "one-cli-doctor", ok: false, detail: message(error) });
        }
        output({
          schema: "one-cli.harness/doctor-v1",
          ok: checks.every((check) => check.ok),
          checks,
          verifier,
          governance: readiness,
        });
        return checks.every((check) => check.ok) ? 0 : 1;
      }
      case "seed": {
        if (options.apply) {
          const readiness = await governance.inspect();
          if (!verifier.ready || !readiness.ready) {
            throw new Error(governanceFailureDetail(readiness, verifier));
          }
        }
        const lock = acquireHarnessLock(paths.lock);
        try {
          if (lock.recovered) journal.append("harness.lock-recovered");
          const [labeled, marked] = await Promise.all([
            github.listRoadmapIssues(),
            github.listSeedMarkerIssues(),
          ]);
          assertExactRoadmapIssueSet(roadmap, labeled, marked);
          if (options.apply) {
            if (!options.bootstrapMergeSha) {
              throw new Error("--bootstrap-merge-sha is required before applied seeding");
            }
            await github.assertDefaultBranchContains(
              options.bootstrapMergeSha,
              repository.defaultBranch,
            );
          }
          const result = await seedRoadmap({
            roadmap,
            github,
            apply: options.apply,
            operations: seedOperations,
          });
          journal.append(options.apply ? "harness.seed-applied" : "harness.seed-planned", {
            actions: result.actions.length,
          });
          output({ schema: "one-cli.harness/seed-v1", ...result });
          return 0;
        } finally {
          lock.release();
        }
      }
      case "run":
        {
          const product = new ColdStartSupervisor({
            roadmap,
            github,
            oneCli,
            journal,
            recoveryKey,
            seedOperations,
          });
          const appliedGovernance: GovernanceReadinessPort = {
            inspect: async (signal) => {
              const [live, local] = await Promise.all([
                governance.inspect(signal),
                Promise.resolve(inspectTrustedVerifier(
                  options.workspace,
                  verifierPolicy,
                  partition.rejectedVerifierSecrets,
                )),
              ]);
              const checks = [
                {
                  name: "local-trusted-verifier",
                  ok: local.ready,
                  detail: local.detail,
                },
                ...live.checks,
              ];
              return { ...live, ready: checks.every((check) => check.ok), checks };
            },
          };
        return await runLoop({
          once: options.once,
          intervalMs: options.intervalMs,
          paths,
          journal,
          supervisor: automaticLanes(
            appliedGovernance,
            product,
            {
              tick: async () => {
                const readiness = inspectTrustedVerifier(
                  options.workspace,
                  verifierPolicy,
                  partition.rejectedVerifierSecrets,
                );
                return {
                  action: "verifier-status",
                  state: readiness.ready ? "idle" : "parked",
                  detail: readiness.detail,
                };
              },
            },
            journal,
          ),
        });
        }
      case "status": {
        const readiness = await governance.inspect();
        if (!verifier.ready || !readiness.ready) {
          output({
            schema: "one-cli.harness/status-v1",
            phase: "roadmap",
            state: "blocked",
            activeAttempt: null,
            action: "governance-readiness",
            roadmap: {
              total: roadmap.children.length,
              discovered: 0,
              closed: 0,
              ready: [],
            },
            verifier,
            governance: readiness,
            journal: journal.read(20),
          });
          return 1;
        }
        const [autonomy, service, issues, marked, parent] = await Promise.all([
          oneCli.status("roadmap-only"),
          launchdStatus(runner),
          github.listRoadmapIssues(),
          github.listSeedMarkerIssues(),
          github.findIssueByMarker(roadmap.parent.seedMarker),
        ]);
        assertExactRoadmapIssueSet(roadmap, issues, marked);
        if (parent) assertRoadmapParent(parent, roadmap);
        const allClosed = issues.length === roadmap.children.length &&
          issues.every((issue) => issue.state === "closed");
        if (parent?.state === "closed" && !allClosed) {
          throw new Error("Closed roadmap parent is inconsistent with child closure");
        }
        const orderedIssues = allClosed
          ? roadmap.children.map((child) =>
              issues.find((issue) => issue.body.includes(child.seedMarker)))
          : [];
        const pulls = allClosed
          ? await Promise.all(
              orderedIssues.map((issue) =>
                issue ? github.findMergedPullForIssue(issue.number) : undefined),
            )
          : [];
        const deliveryReady = allClosed && orderedIssues.every((issue, index) => {
          const pull = pulls[index];
          const attempt = issue
            ? autonomy.attempts.find((candidate) => candidate.issueId === `github-${issue.number}`)
            : undefined;
          return Boolean(
            issue &&
            pull?.mergeSha &&
            attempt?.state === "succeeded" &&
            attempt.prNumber === pull.number &&
            attempt.detail?.postMergeVerified === true &&
            Array.isArray(attempt.detail.postMergeDogfood) &&
            attempt.detail.postMergeDogfood.length > 0 &&
            attempt.detail.releaseEvidence,
          );
        });
        const finalPull = pulls.at(-1);
        const release = oneCli.activeRelease();
        const finalIssue = orderedIssues.at(-1);
        const handoff = readRoadmapHandoff(journal);
        if (
          handoff &&
          (
            handoff.parentNumber !== parent?.number ||
            handoff.finalChildIssueNumber !== finalIssue?.number ||
            handoff.finalPullNumber !== finalPull?.number ||
            handoff.finalMergeSha !== finalPull?.mergeSha ||
            handoff.activeReleaseSha !== finalPull?.mergeSha
          )
        ) {
          throw new Error(
            "Durable roadmap handoff evidence does not match current parent and final delivery",
          );
        }
        let releaseReady = Boolean(
          handoff &&
          !release.bootstrap &&
          release.sha,
        );
        if (
          releaseReady &&
          release.sha !== handoff?.activeReleaseSha
        ) {
          await github.assertCommitDescendsFrom(handoff!.activeReleaseSha, release.sha!);
        }
        const normalReady =
          deliveryReady &&
          parent?.state === "closed" &&
          handoff !== undefined &&
          releaseReady;
        const ready = issues.filter(
          (issue) => issue.state === "open" && issue.labels.includes("agent-ready"),
        );
        output({
          schema: "one-cli.harness/status-v1",
          phase: normalReady ? "normal" : "roadmap",
          activeAttempt: autonomy.activeAttempt,
          action: autonomy.action,
          roadmap: {
            total: roadmap.children.length,
            discovered: issues.length,
            closed: issues.filter((issue) => issue.state === "closed").length,
            ready: ready.map((issue) => issue.number),
          },
          launchd: service,
          release,
          verifier,
          governance: readiness,
          journal: journal.read(20),
        });
        return !verifier.ready ||
            !readiness.ready ||
            blockedAutonomy(autonomy.activeAttempt?.state)
          ? 1
          : 0;
      }
      case "install": {
        const plist = launchdPlist({
          nodeExecutable: process.execPath,
          harnessEntrypoint: fileURLToPath(import.meta.url),
          workspace: options.workspace,
          paths,
          ghExecutable,
        });
        const result = await installLaunchd({
          apply: options.apply,
          runner,
          plist,
          paths,
        });
        output({ schema: "one-cli.harness/install-v1", ...result, plist: options.apply ? undefined : plist });
        return 0;
      }
      case "uninstall": {
        const result = await uninstallLaunchd({ apply: options.apply, runner, paths });
        output({ schema: "one-cli.harness/uninstall-v1", ...result });
        return 0;
      }
      default:
        throw new Error(`Unsupported command: ${options.command}`);
    }
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ schema: "one-cli.harness/error-v1", error: message(error) })}\n`);
    return 2;
  }
}

export function automaticLanes(
  governance: GovernanceReadinessPort,
  product: { tick(signal?: AbortSignal): Promise<RuntimeTickResult> },
  verifier: { tick(signal?: AbortSignal): Promise<VerifierLaneResult> },
  journal: HostJournal,
): { tick(signal?: AbortSignal): Promise<RuntimeTickResult> } {
  return {
    async tick(signal?: AbortSignal): Promise<RuntimeTickResult> {
      let readiness: GovernanceReadiness;
      try {
        readiness = await governance.inspect(signal);
      } catch (error) {
        const detail = message(error);
        journal.append("harness.governance-readiness-failed", { detail });
        return {
          action: "governance-readiness",
          state: "blocked",
          phase: "normal",
          detail,
        };
      }
      journal.append("harness.governance-readiness", {
        ready: readiness.ready,
        failed: readiness.checks.filter((check) => !check.ok).map((check) => check.name),
      });
      if (!readiness.ready) {
        return {
          action: "governance-readiness",
          state: "blocked",
          phase: "normal",
          detail: governanceFailureDetail(readiness),
        };
      }
      let runtime: RuntimeTickResult;
      try {
        runtime = await product.tick(signal);
      } catch (error) {
        if (error instanceof HostStateCorruptionError) throw error;
        const detail = message(error);
        journal.append("harness.product-lane-failed", { detail });
        runtime = {
          action: "product-lane-failure",
          state: "blocked",
          phase: "normal",
          detail,
        };
      }
      let verification: VerifierLaneResult;
      try {
        verification = await verifier.tick(signal);
        journal.append("harness.verifier-lane", {
          action: verification.action,
          state: verification.state,
          detail: verification.detail,
          ...(verification.pullNumber === undefined ? {} : { pullNumber: verification.pullNumber }),
          ...(verification.headSha === undefined ? {} : { headSha: verification.headSha }),
          ...(verification.mergeSha === undefined ? {} : { mergeSha: verification.mergeSha }),
        });
      } catch (error) {
        if (error instanceof HostStateCorruptionError) throw error;
        const detail = message(error);
        journal.append("harness.verifier-lane-failed", { detail });
        verification = {
          action: "verifier-lane-failure",
          state: "parked",
          detail,
        };
      }
      return combinedLaneResult(runtime, verification);
    },
  };
}

export interface VerifierLaneResult {
  action: string;
  state: string;
  detail: string;
  pullNumber?: number;
  headSha?: string;
  mergeSha?: string;
  nextAttemptAt?: number | string;
}

function combinedLaneResult(
  runtime: RuntimeTickResult,
  verifier: VerifierLaneResult,
): RuntimeTickResult {
  if (
    verifier.state === "succeeded" &&
    !["blocked", "parked", "quarantined"].includes(runtime.state)
  ) {
    return {
      action: verifier.action,
      state: verifier.state,
      phase: "normal",
      detail: `${verifier.detail}; runtime lane: ${runtime.action}/${runtime.state}`,
    };
  }
  return {
    ...runtime,
    detail: `${runtime.detail}; verifier lane: ${verifier.state} (${verifier.detail})`,
    ...(runtime.nextAttemptAt === undefined && verifier.nextAttemptAt !== undefined
      ? { nextAttemptAt: verifier.nextAttemptAt }
      : {}),
  };
}

export interface RuntimeTickResult {
  action: string;
  state: string;
  phase: "roadmap" | "normal";
  detail: string;
  nextAttemptAt?: number | string;
}

export interface HarnessClock {
  now(): number;
  wait(milliseconds: number, signal: AbortSignal): Promise<void>;
  setInterval(callback: () => void, milliseconds: number): ReturnType<typeof setInterval>;
  clearInterval(timer: ReturnType<typeof setInterval>): void;
}

export async function runLoop(input: {
  once: boolean;
  intervalMs: number;
  paths: ReturnType<typeof resolveHarnessPaths>;
  journal: HostJournal;
  supervisor: { tick(signal?: AbortSignal): Promise<RuntimeTickResult> };
  clock?: HarnessClock;
  signal?: AbortSignal;
}): Promise<number> {
  const clock = input.clock ?? systemClock;
  const lock = acquireHarnessLock(input.paths.lock);
  const controller = new AbortController();
  const stop = () => controller.abort(new DOMException("Harness stopped", "AbortError"));
  const stopFromInput = () => controller.abort(input.signal?.reason);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  input.signal?.addEventListener("abort", stopFromInput, { once: true });
  if (input.signal?.aborted) stopFromInput();
  let heartbeatFailure: unknown;
  let runtimeState = "starting";
  let ticks = 0;
  let nextWakeAt: string | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  const heartbeat = () => {
    try {
      input.journal.append("harness.heartbeat", {
        pid: process.pid,
        state: runtimeState,
        ticks,
        nextWakeAt,
      });
    } catch (error) {
      heartbeatFailure = error;
      controller.abort(error);
    }
  };
  try {
    heartbeat();
    if (heartbeatFailure !== undefined) throw heartbeatFailure;
    heartbeatTimer = clock.setInterval(heartbeat, 60_000);
    heartbeatTimer.unref?.();
    if (lock.recovered) input.journal.append("harness.lock-recovered");
    do {
      runtimeState = "ticking";
      nextWakeAt = null;
      let result: RuntimeTickResult;
      try {
        result = await input.supervisor.tick(controller.signal);
      } catch (error) {
        if (controller.signal.aborted && heartbeatFailure === undefined) return 0;
        throw error;
      }
      ticks++;
      if (heartbeatFailure !== undefined) throw heartbeatFailure;
      input.journal.read(1);
      output({ schema: "one-cli.harness/tick-v1", ...result });
      if (input.once) return unsafeTickState(result.state) ? 1 : 0;
      if (controller.signal.aborted) break;
      const delay = adaptiveDelay(result.nextAttemptAt, input.intervalMs, clock.now());
      nextWakeAt = new Date(clock.now() + delay).toISOString();
      runtimeState = unsafeTickState(result.state) ? `waiting-${result.state}` : "sleeping";
      await clock.wait(delay, controller.signal);
      if (heartbeatFailure !== undefined) throw heartbeatFailure;
    } while (!controller.signal.aborted);
    return 0;
  } finally {
    runtimeState = "stopping";
    if (heartbeatTimer) clock.clearInterval(heartbeatTimer);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    input.signal?.removeEventListener("abort", stopFromInput);
    lock.release();
  }
}

export function parseOptions(argv: readonly string[]): Options {
  const command = argv[0];
  if (!command) throw new Error("Harness command is required");
  if (!COMMANDS.has(command)) throw new Error(`Unknown harness command: ${command}`);
  let workspace = process.cwd();
  let apply = false;
  let dryRun = false;
  let once = false;
  let intervalMs = 30 * 60_000;
  let roadmapPath = defaultRoadmap();
  let bootstrapMergeSha: string | undefined;
  const seenOptions = new Set<string>();
  for (let index = 1; index < argv.length; index++) {
    const value = argv[index]!;
    if (value === "--apply") {
      seenOptions.add(value);
      apply = true;
      dryRun = false;
    } else if (value === "--dry-run") {
      seenOptions.add(value);
      apply = false;
      dryRun = true;
    }
    else if (value === "--once") {
      seenOptions.add(value);
      once = true;
    }
    else if (value === "--workspace") {
      seenOptions.add(value);
      workspace = required(argv, ++index, value);
    }
    else if (value === "--roadmap") {
      seenOptions.add(value);
      roadmapPath = required(argv, ++index, value);
    }
    else if (value === "--bootstrap-merge-sha") {
      seenOptions.add(value);
      bootstrapMergeSha = required(argv, ++index, value);
      if (!/^[0-9a-f]{40,64}$/u.test(bootstrapMergeSha)) {
        throw new Error("--bootstrap-merge-sha must be a full lowercase commit SHA");
      }
    }
    else if (value === "--interval-ms") {
      seenOptions.add(value);
      intervalMs = Number(required(argv, ++index, value));
      if (!Number.isSafeInteger(intervalMs) || intervalMs < 1_000) {
        throw new Error("--interval-ms must be an integer of at least 1000");
      }
    } else throw new Error(`Unknown harness option: ${value}`);
  }
  const invalid = [...seenOptions].filter((option) => !commandOptions(command).has(option));
  if (invalid.length > 0) throw new Error(`${command} does not accept ${invalid.join(", ")}`);
  return {
    command,
    workspace: path.resolve(workspace),
    apply,
    dryRun,
    once,
    intervalMs,
    roadmapPath: path.resolve(roadmapPath),
    ...(bootstrapMergeSha ? { bootstrapMergeSha } : {}),
  };
}

function commandOptions(command: string): ReadonlySet<string> {
  switch (command) {
    case "doctor":
    case "status":
      return new Set(["--workspace", "--roadmap"]);
    case "verifier-status":
      return new Set(["--workspace"]);
    case "seed":
      return new Set([
        "--workspace",
        "--roadmap",
        "--apply",
        "--dry-run",
        "--bootstrap-merge-sha",
      ]);
    case "run":
      return new Set(["--workspace", "--roadmap", "--dry-run", "--once", "--interval-ms"]);
    case "install":
    case "uninstall":
      return new Set(["--workspace", "--apply", "--dry-run"]);
    default:
      return new Set();
  }
}

function loadRepository(workspace: string): {
  owner: string;
  repo: string;
  defaultBranch: string;
  repoKey: string;
} {
  const filePath = path.join(workspace, ".autonomy", "product.yml");
  const value = YAML.parse(fs.readFileSync(filePath, "utf8")) as {
    repository?: { owner?: unknown; name?: unknown; defaultBranch?: unknown };
  };
  if (
    typeof value.repository?.owner !== "string" ||
    typeof value.repository.name !== "string" ||
    typeof value.repository.defaultBranch !== "string"
  ) {
    throw new Error("Tracked repository identity is invalid");
  }
  return {
    owner: value.repository.owner,
    repo: value.repository.name,
    defaultBranch: value.repository.defaultBranch,
    repoKey: repositoryKey(value.repository.owner, value.repository.name),
  };
}

export function repositoryKey(owner: string, repository: string): string {
  const slug = `${owner}-${repository}`.toLowerCase().replace(/[^a-z0-9._-]+/gu, "-");
  const digest = crypto
    .createHash("sha256")
    .update(`${owner}/${repository}`)
    .digest("hex")
    .slice(0, 12);
  return `${slug.slice(0, 80)}-${digest}`;
}

function safeEnvironment(
  oneCliHome: string,
  sourced: Readonly<Record<string, string>>,
): Record<string, string> {
  const environment: Record<string, string> = {
    ...sourced,
    ONE_CLI_HOME: oneCliHome,
    NO_COLOR: "1",
  };
  for (const name of [
    "HOME",
    "PATH",
    "XDG_CONFIG_HOME",
    "GH_CONFIG_DIR",
    "GH_HOST",
    "ONE_CLI_GH_EXECUTABLE",
  ]) {
    const value = process.env[name];
    if (value !== undefined && environment[name] === undefined) environment[name] = value;
  }
  return environment;
}

function defaultRoadmap(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../roadmap.yml");
}

function defaultVerifierPolicy(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../verifier-policy.yml");
}

function regularFile(filePath: string): boolean {
  try {
    const stat = fs.lstatSync(filePath);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

async function probeLeastPrivilegeBuilder(input: {
  runner: SpawnProcessRunner;
  ghExecutable: string;
  environment: Readonly<Record<string, string>>;
  expectedAppId?: string;
}): Promise<string> {
  if (
    input.expectedAppId === undefined ||
    !/^[1-9][0-9]*$/u.test(input.expectedAppId)
  ) {
    throw new Error("ONE_CLI_BUILDER_APP_ID must pin the local builder App");
  }
  const installation = recordValue(
    await ghJson(input, "installation"),
    "builder App installation",
  );
  if (String(installation.app_id) !== input.expectedAppId) {
    throw new Error("Authenticated builder token does not match ONE_CLI_BUILDER_APP_ID");
  }
  const permissions = recordValue(installation.permissions, "builder App permissions");
  for (const name of ["contents", "issues", "pull_requests"]) {
    if (permissions[name] !== "write") {
      throw new Error(`Builder App lacks required ${name}:write`);
    }
  }
  const forbidden = [
    "administration",
    "checks",
    "actions",
    "actions_variables",
    "actions_secrets",
    "workflows",
  ].filter((name) => permissions[name] === "write");
  if (forbidden.length > 0) {
    throw new Error(`Builder App has forbidden write permissions: ${forbidden.join(", ")}`);
  }
  const slug = typeof installation.app_slug === "string" ? installation.app_slug : "unknown";
  return `github-app:${slug} (${input.expectedAppId}); no admin/check/verifier authority`;
}

async function ghJson(
  input: {
    runner: SpawnProcessRunner;
    ghExecutable: string;
    environment: Readonly<Record<string, string>>;
  },
  apiPath: string,
): Promise<unknown> {
  const result = requireSuccess("gh api verifier readiness", await input.runner.run({
    executable: input.ghExecutable,
    args: ["api", "--method", "GET", apiPath],
    env: input.environment,
    timeoutMs: 30_000,
    maxOutputBytes: 2 * 1024 * 1024,
  }));
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch {
    throw new Error("GitHub verifier readiness response is malformed JSON");
  }
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function governanceFailureDetail(
  readiness: GovernanceReadiness,
  verifier?: TrustedVerifierReadiness,
): string {
  const failed = readiness.checks
    .filter((check) => !check.ok)
    .map((check) => check.name);
  if (verifier && !verifier.ready) failed.unshift(`local-verifier (${verifier.detail})`);
  return failed.length > 0
    ? `Governance readiness failed: ${failed.join(", ")}`
    : "Governance readiness failed closed";
}

function assertExactRoadmapIssueSet(
  roadmap: Roadmap,
  labeled: readonly HostIssue[],
  marked: readonly HostIssue[],
): void {
  const accepted = new Set([
    roadmap.parent.seedMarker,
    ...roadmap.children.map((child) => child.seedMarker),
  ]);
  const issues = new Map<number, HostIssue>();
  for (const issue of [...labeled, ...marked]) issues.set(issue.number, issue);
  const markerOwners = new Map<string, number>();
  for (const issue of issues.values()) {
    const markers = [...new Set(
      [...issue.body.matchAll(/<!-- one-cli:cold-start-seed:[^>\r\n]* -->/gu)]
        .map((match) => match[0]),
    )];
    if (
      markers.length !== 1 ||
      !accepted.has(markers[0]!) ||
      (issue.labels.includes("cold-start-roadmap") && markers[0] === roadmap.parent.seedMarker)
    ) {
      throw new Error(
        `Unknown or ambiguous cold-start roadmap issue #${issue.number} is outside the manifest`,
      );
    }
    const previous = markerOwners.get(markers[0]!);
    if (previous !== undefined && previous !== issue.number) {
      throw new Error(`Roadmap marker is duplicated by issues #${previous} and #${issue.number}`);
    }
    markerOwners.set(markers[0]!, issue.number);
  }
}

function required(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function blockedAutonomy(state: string | undefined): boolean {
  return state !== undefined && ["in_doubt", "blocked", "waiting_evidence"].includes(state);
}

function unsafeTickState(state: string): boolean {
  return ["blocked", "parked", "quarantined"].includes(state);
}

function adaptiveDelay(
  nextAttemptAt: number | string | undefined,
  intervalMs: number,
  now: number,
): number {
  const target = typeof nextAttemptAt === "number"
    ? nextAttemptAt
    : typeof nextAttemptAt === "string"
    ? Date.parse(nextAttemptAt)
    : Number.NaN;
  if (!Number.isFinite(target)) return intervalMs;
  return Math.max(1_000, Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(target - now)));
}

async function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

const systemClock: HarnessClock = {
  now: () => Date.now(),
  wait,
  setInterval: (callback, milliseconds) => setInterval(callback, milliseconds),
  clearInterval: (timer) => clearInterval(timer),
};

function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 4_096);
}

function helpText(): string {
  return `Usage: node harness/dist/index.js <command> [options]

Commands:
  doctor
  verifier-status
  seed [--apply]
  run [--once] [--dry-run]
  status
  install [--apply]
  uninstall [--apply]

External mutations are dry-run by default for seed/install/uninstall.
Run is applied by default; explicit --dry-run performs inspection without subprocesses or writes.
Independent verification is applied only by the trusted pull_request_target Action.
Applied seed requires --bootstrap-merge-sha <full-sha> already contained by the default branch.
Run performs one bounded action per tick; its default interval is 30 minutes.`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
