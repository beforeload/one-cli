#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { GhClient } from "./github.js";
import type { HostIssue } from "./github.js";
import { resolveGhExecutable } from "./executable.js";
import {
  HostJournal,
  acquireHarnessLock,
  loadHostEnvironment,
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
import { SpawnProcessRunner } from "./runner.js";
import { seedRoadmap } from "./seed.js";
import { SeedOperationJournal } from "./seed-state.js";
import { resolveHarnessRelease } from "./release.js";
import { ColdStartSupervisor, readRoadmapHandoff } from "./supervisor.js";

const COMMANDS = new Set(["doctor", "seed", "run", "status", "install", "uninstall"]);

interface Options {
  command: string;
  workspace: string;
  apply: boolean;
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
    const runner = new SpawnProcessRunner(Object.values(hostEnv));
    const roadmap = loadRoadmap(options.roadmapPath);
    const repository = loadRepository(options.workspace);
    const ghExecutable = resolveGhExecutable(
      environment,
      options.command === "doctor" || options.command === "install",
    );
    environment.ONE_CLI_GH_EXECUTABLE = ghExecutable;
    const github = new GhClient(runner, repository, ghExecutable, environment);
    const oneCli = new OneCliClient(
      runner,
      options.workspace,
      () => resolveHarnessRelease(paths.oneCliHome, options.workspace, repository.repoKey),
      environment,
    );
    const journal = new HostJournal(paths.journal, Object.values(hostEnv));
    const seedOperations = new SeedOperationJournal(paths.seedOperations);

    switch (options.command) {
      case "doctor": {
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
        output({ schema: "one-cli.harness/doctor-v1", ok: checks.every((check) => check.ok), checks });
        return checks.every((check) => check.ok) ? 0 : 1;
      }
      case "seed": {
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
        return await runLoop({
          once: options.once,
          intervalMs: options.intervalMs,
          paths,
          journal,
          supervisor: new ColdStartSupervisor({
            roadmap,
            github,
            oneCli,
            journal,
            seedOperations,
          }),
        });
      case "status": {
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
          journal: journal.read(20),
        });
        return blockedAutonomy(autonomy.activeAttempt?.state) ? 1 : 0;
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

async function runLoop(input: {
  once: boolean;
  intervalMs: number;
  paths: ReturnType<typeof resolveHarnessPaths>;
  journal: HostJournal;
  supervisor: ColdStartSupervisor;
}): Promise<number> {
  const lock = acquireHarnessLock(input.paths.lock);
  const controller = new AbortController();
  const stop = () => controller.abort(new DOMException("Harness stopped", "AbortError"));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    if (lock.recovered) input.journal.append("harness.lock-recovered");
    do {
      const result = await input.supervisor.tick(controller.signal);
      output({ schema: "one-cli.harness/tick-v1", ...result });
      if (result.state === "blocked") return 1;
      if (input.once) return 0;
      await wait(input.intervalMs, controller.signal);
    } while (!controller.signal.aborted);
    return 0;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    lock.release();
  }
}

function parseOptions(argv: readonly string[]): Options {
  const command = argv[0];
  if (!command) throw new Error("Harness command is required");
  if (!COMMANDS.has(command)) throw new Error(`Unknown harness command: ${command}`);
  let workspace = process.cwd();
  let apply = false;
  let once = false;
  let intervalMs = 30 * 60_000;
  let roadmapPath = defaultRoadmap();
  let bootstrapMergeSha: string | undefined;
  for (let index = 1; index < argv.length; index++) {
    const value = argv[index]!;
    if (value === "--apply") apply = true;
    else if (value === "--dry-run") apply = false;
    else if (value === "--once") once = true;
    else if (value === "--workspace") workspace = required(argv, ++index, value);
    else if (value === "--roadmap") roadmapPath = required(argv, ++index, value);
    else if (value === "--bootstrap-merge-sha") {
      bootstrapMergeSha = required(argv, ++index, value);
      if (!/^[0-9a-f]{40,64}$/u.test(bootstrapMergeSha)) {
        throw new Error("--bootstrap-merge-sha must be a full lowercase commit SHA");
      }
    }
    else if (value === "--interval-ms") {
      intervalMs = Number(required(argv, ++index, value));
      if (!Number.isSafeInteger(intervalMs) || intervalMs < 1_000) {
        throw new Error("--interval-ms must be an integer of at least 1000");
      }
    } else throw new Error(`Unknown harness option: ${value}`);
  }
  return {
    command,
    workspace: path.resolve(workspace),
    apply,
    once,
    intervalMs,
    roadmapPath: path.resolve(roadmapPath),
    ...(bootstrapMergeSha ? { bootstrapMergeSha } : {}),
  };
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

function regularFile(filePath: string): boolean {
  try {
    const stat = fs.lstatSync(filePath);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
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
  seed [--apply]
  run [--once]
  status
  install [--apply]
  uninstall [--apply]

External mutations are dry-run by default for seed/install/uninstall.
Applied seed requires --bootstrap-merge-sha <full-sha> already contained by the default branch.
Run performs one bounded action per tick; its default interval is 30 minutes.`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
