import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  GitHubPort,
  HostIssue,
  PullEvidence,
} from "../../harness/src/github.js";
import { resolveGhExecutable } from "../../harness/src/executable.js";
import { repositoryKey as harnessRepositoryKey } from "../../harness/src/index.js";
import {
  HostJournal,
  acquireHarnessLock,
  resolveHarnessPaths,
  type JournalEvent,
} from "../../harness/src/host.js";
import { installLaunchd, launchdPlist } from "../../harness/src/launchd.js";
import { OneCliClient, parseAutonomyStatus } from "../../harness/src/one-cli.js";
import { loadRoadmap, NORMALIZED_FIELDS, TRUSTED_EXECUTION_MARKER } from "../../harness/src/roadmap.js";
import { SpawnProcessRunner, type ProcessRunner } from "../../harness/src/runner.js";
import { resolveHarnessRelease } from "../../harness/src/release.js";
import { seedRoadmap } from "../../harness/src/seed.js";
import {
  seedOperationId,
  type SeedOperation,
  type SeedOperationStore,
} from "../../harness/src/seed-state.js";
import { ColdStartSupervisor, readRoadmapHandoff } from "../../harness/src/supervisor.js";
import { repositoryKey as autonomyRepositoryKey } from "../../src/autonomy/config.js";
import { makeTempDir, removeTempDir } from "../helpers.js";

const roots: string[] = [];
const roadmapPath = path.resolve(import.meta.dirname, "../../harness/roadmap.yml");

afterEach(() => {
  for (const root of roots.splice(0)) removeTempDir(root);
});

describe("cold-start harness", () => {
  it("derives the exact autonomy repository key from tracked identity", () => {
    expect(harnessRepositoryKey("beforeload", "one-cli"))
      .toBe(autonomyRepositoryKey("beforeload", "one-cli"));
  });

  it("does not require roadmap handoff while environment-blocker recovery is active", () => {
    const root = makeTempDir("harness-handoff-");
    roots.push(root);
    const journal = new HostJournal(path.join(root, "journal.jsonl"));
    journal.append("harness.environment-blocker-tick", {
      blockerIssueNumber: 29,
      action: "global-dogfood",
      state: "blocked",
    });
    journal.append("harness.tick-blocked", {
      phase: "normal",
      action: "global-dogfood",
      state: "blocked",
      attemptId: null,
      detail: "integration failed",
    });
    expect(readRoadmapHandoff(journal)).toBeUndefined();
  });

  it("bounds subprocess output, timeout, and cancellation without a shell", async () => {
    const runner = new SpawnProcessRunner();
    const overflow = await runner.run({
      executable: process.execPath,
      args: ["-e", "process.stdout.write('x'.repeat(100000));setInterval(()=>{},1000)"],
      timeoutMs: 5_000,
      maxOutputBytes: 1_024,
    });
    expect(overflow.outputLimitExceeded).toBe(true);
    expect(Buffer.byteLength(overflow.stdout)).toBe(1_024);

    const timeout = await runner.run({
      executable: process.execPath,
      args: ["-e", "setInterval(()=>{},1000)"],
      timeoutMs: 20,
      maxOutputBytes: 1_024,
    });
    expect(timeout.timedOut).toBe(true);

    const controller = new AbortController();
    const cancelled = runner.run({
      executable: process.execPath,
      args: ["-e", "setInterval(()=>{},1000)"],
      timeoutMs: 5_000,
      maxOutputBytes: 1_024,
      signal: controller.signal,
    });
    controller.abort();
    await expect(cancelled).resolves.toMatchObject({ cancelled: true });
  });

  it("redacts every host secret from multiline output and spawn errors", async () => {
    const secret = "host-secret-value";
    const runner = new SpawnProcessRunner([secret]);
    const result = await runner.run({
      executable: process.execPath,
      args: ["-e", `process.stdout.write(${JSON.stringify(`before\n${secret}\nafter`)});process.stderr.write(${JSON.stringify(`err\n${secret}\nend`)})`],
      timeoutMs: 5_000,
      maxOutputBytes: 4_096,
    });
    expect(result.stdout).not.toContain(secret);
    expect(result.stderr).not.toContain(secret);
    expect(result.stdout).toContain("[REDACTED]");
    expect(result.stderr).toContain("[REDACTED]");

    const spawnFailure = await runner.run({
      executable: `/missing/${secret}`,
      args: [],
      timeoutMs: 5_000,
      maxOutputBytes: 4_096,
    });
    expect(spawnFailure.spawnError).not.toContain(secret);
  });

  it("loads only the exact non-executable parent and ordered eight-child contract", () => {
    const roadmap = loadRoadmap(roadmapPath);
    expect(roadmap.parent).toEqual({
      title: "Production coding-agent CLI cold-start roadmap",
      labels: ["enhancement", "parent", "priority:p2"],
      seedMarker: "<!-- one-cli:cold-start-seed:parent:v1 -->",
    });
    expect(roadmap.children).toHaveLength(8);
    expect(roadmap.children.map((child) => child.id)).toEqual([
      "01-semantic-coherence",
      "02-lease-heartbeat",
      "03-context-compaction",
      "04-provider-profiles",
      "05-bounded-search",
      "06-interactive-session",
      "07-extension-health",
      "08-linux-release",
    ]);
    for (const child of roadmap.children) {
      expect(Object.keys(child.fields)).toEqual(NORMALIZED_FIELDS);
      expect(child.trustedExecutionMarker).toBe(TRUSTED_EXECUTION_MARKER);
      expect(child.approvedPaths.length).toBeGreaterThan(0);
    }
    expect(JSON.stringify(roadmap.parent)).not.toContain(TRUSTED_EXECUTION_MARKER);
    expect(JSON.stringify(roadmap.parent)).not.toContain("agent-ready");
    expect(JSON.stringify(roadmap.parent)).not.toContain("source:");
  });

  it("rejects extra manifest fields and changed accepted titles", () => {
    const root = temp("manifest");
    const original = fs.readFileSync(roadmapPath, "utf8");
    const extra = path.join(root, "extra.yml");
    fs.writeFileSync(extra, original.replace(
      "schema: one-cli.cold-start-roadmap/v1",
      "schema: one-cli.cold-start-roadmap/v1\nunexpected: true",
    ));
    expect(() => loadRoadmap(extra)).toThrow();
    const changed = path.join(root, "changed.yml");
    fs.writeFileSync(changed, original.replace(
      "Deterministic lease heartbeat",
      "Different lease title",
    ));
    expect(() => loadRoadmap(changed)).toThrow("accepted order");
    const changedMarker = path.join(root, "changed-marker.yml");
    fs.writeFileSync(changedMarker, original.replace(
      "one-cli:cold-start-seed:01-semantic-coherence:v1",
      "one-cli:cold-start-seed:01-arbitrary:v1",
    ));
    expect(() => loadRoadmap(changedMarker)).toThrow("accepted order");
  });

  it("seeds idempotently and reconciles a lost create response without duplication", async () => {
    const roadmap = loadRoadmap(roadmapPath);
    const preview = new FakeGitHub();
    const dryRun = await seedRoadmap({ roadmap, github: preview });
    expect(dryRun.actions).toHaveLength(9);
    expect(preview.issues).toHaveLength(0);

    const github = new FakeGitHub();
    const operations = new MemorySeedOperations();
    github.loseNextCreateResponse = true;
    await expect(seedRoadmap({ roadmap, github, apply: true, operations })).rejects.toThrow(
      "in_doubt",
    );
    expect(github.issues).toHaveLength(1);
    expect(operations.get(seedOperationId(roadmap.parent.seedMarker))?.state).toBe("in_doubt");
    await seedRoadmap({ roadmap, github, apply: true, operations });
    await seedRoadmap({ roadmap, github, apply: true, operations });
    expect(github.issues).toHaveLength(9);
    expect(github.issues.filter((issue) => issue.labels.includes("agent-ready"))).toHaveLength(1);
    expect(github.issues.find((issue) => issue.labels.includes("parent"))?.body)
      .not.toContain(TRUSTED_EXECUTION_MARKER);

    const repeated = await seedRoadmap({ roadmap, github, apply: true, operations });
    expect(repeated.actions).toEqual([]);
    expect(github.issues).toHaveLength(9);
  });

  it("never recreates an in-doubt seed reservation with zero marker results", async () => {
    const roadmap = loadRoadmap(roadmapPath);
    const github = new FakeGitHub();
    const operations = new MemorySeedOperations();
    const marker = roadmap.parent.seedMarker;
    operations.reserve({
      operationId: seedOperationId(marker),
      marker,
      target: "parent",
    });
    await expect(seedRoadmap({ roadmap, github, apply: true, operations })).rejects.toThrow(
      "0 marker results",
    );
    expect(github.issues).toHaveLength(0);
  });

  it("hands agent-ready to exactly one next open child", async () => {
    const roadmap = loadRoadmap(roadmapPath);
    const github = new FakeGitHub();
    const operations = new MemorySeedOperations();
    await seedRoadmap({ roadmap, github, apply: true, operations });
    await seedRoadmap({ roadmap, github, apply: true, operations });
    const first = github.issueForMarker(roadmap.children[0]!.seedMarker);
    first.state = "closed";
    await seedRoadmap({
      roadmap,
      github,
      apply: true,
      operations,
      activeChildId: roadmap.children[1]!.id,
    });
    await seedRoadmap({
      roadmap,
      github,
      apply: true,
      operations,
      activeChildId: roadmap.children[1]!.id,
    });
    const readyOpen = github.issues.filter(
      (issue) => issue.state === "open" && issue.labels.includes("agent-ready"),
    );
    expect(readyOpen).toHaveLength(1);
    expect(readyOpen[0]?.title).toBe(roadmap.children[1]!.title);
  });

  it("resumes a lost ready-label response through a zero-ready interim state", async () => {
    const roadmap = loadRoadmap(roadmapPath);
    const github = new FakeGitHub();
    const operations = new MemorySeedOperations();
    await seedRoadmap({ roadmap, github, apply: true, operations });
    await seedRoadmap({ roadmap, github, apply: true, operations });
    github.issueForMarker(roadmap.children[0]!.seedMarker).state = "closed";
    github.loseNextUpdateResponse = true;
    await expect(seedRoadmap({
      roadmap,
      github,
      apply: true,
      operations,
      activeChildId: roadmap.children[1]!.id,
    })).rejects.toThrow("lost update response");
    expect(github.issues.filter((issue) => issue.labels.includes("agent-ready"))).toHaveLength(0);
    await seedRoadmap({
      roadmap,
      github,
      apply: true,
      operations,
      activeChildId: roadmap.children[1]!.id,
    });
    expect(github.issues.filter((issue) => issue.labels.includes("agent-ready")))
      .toEqual([github.issueForMarker(roadmap.children[1]!.seedMarker)]);
  });

  it("reconciles a lost response after adding the expected ready label", async () => {
    const roadmap = loadRoadmap(roadmapPath);
    const github = new FakeGitHub();
    const operations = new MemorySeedOperations();
    await seedRoadmap({ roadmap, github, apply: true, operations });
    github.loseNextUpdateResponse = true;
    await expect(seedRoadmap({ roadmap, github, apply: true, operations }))
      .rejects.toThrow("lost update response");
    expect(github.issues.filter((issue) => issue.labels.includes("agent-ready"))).toHaveLength(1);
    await expect(seedRoadmap({ roadmap, github, apply: true, operations }))
      .resolves.toMatchObject({ actions: [] });
  });

  it("strictly rejects malformed autonomy status and preserves fail-closed states", () => {
    expect(() => parseAutonomyStatus({ schema: "wrong" })).toThrow("schema");
    const status = parseAutonomyStatus({
      schema: "autonomy.one-cli/status-v1",
      executionScope: "roadmap-only",
      mode: "auto-merge",
      activeAttempt: {
        id: "a",
        issueId: "github-1",
        state: "waiting_evidence",
        prNumber: null,
        detail: null,
      },
      attempts: [],
      action: null,
    });
    expect(status.activeAttempt?.state).toBe("waiting_evidence");
  });

  it("fails closed from status before reconciliation or autonomous execution", async () => {
    const root = temp("blocked-status");
    const roadmap = loadRoadmap(roadmapPath);
    const github = new FakeGitHub();
    const seedOperations = new MemorySeedOperations();
    await seedRoadmap({ roadmap, github, apply: true, operations: seedOperations });
    const journal = new HostJournal(path.join(root, "journal.jsonl"));
    let reconciled = 0;
    let executed = 0;
    const oneCli = {
      doctor: async () => ({ ok: true, checks: [], process: processResult() }),
      status: async () => parseAutonomyStatus({
        schema: "autonomy.one-cli/status-v1",
        executionScope: "roadmap-only",
        mode: "auto-merge",
        activeAttempt: {
          id: "attempt-1",
          issueId: "github-1",
          state: "in_doubt",
          prNumber: null,
          detail: null,
        },
        attempts: [],
        action: null,
      }),
      reconcile: async () => {
        reconciled++;
        return { action: "reconcile", state: "unchanged" };
      },
      once: async () => {
        executed++;
        return { action: "none", state: "idle" };
      },
    } as unknown as OneCliClient;
    const supervisor = new ColdStartSupervisor({
      roadmap,
      github,
      oneCli,
      journal,
      seedOperations,
    });
    await expect(supervisor.tick()).resolves.toMatchObject({
      action: "status",
      state: "blocked",
    });
    expect(reconciled).toBe(0);
    expect(executed).toBe(0);
    expect(journal.read().at(-1)?.type).toBe("harness.fail-closed");
  });

  it("blocks executable parent drift before invoking one-cli", async () => {
    const root = temp("parent-drift");
    const roadmap = loadRoadmap(roadmapPath);
    const github = new FakeGitHub();
    const seedOperations = new MemorySeedOperations();
    await seedRoadmap({ roadmap, github, apply: true, operations: seedOperations });
    const parent = github.issueForMarker(roadmap.parent.seedMarker);
    parent.labels.push("agent-ready");
    let invoked = 0;
    const oneCli = {
      doctor: async () => {
        invoked++;
        return { ok: true, checks: [], process: processResult() };
      },
    } as unknown as OneCliClient;
    const supervisor = new ColdStartSupervisor({
      roadmap,
      github,
      oneCli,
      journal: new HostJournal(path.join(root, "journal.jsonl")),
      seedOperations,
    });
    await expect(supervisor.tick()).resolves.toMatchObject({
      action: "parent-invariant",
      state: "blocked",
    });
    expect(invoked).toBe(0);
  });

  it("rejects extra labeled or trusted-prefix issues outside the manifest", async () => {
    const root = temp("extra-roadmap");
    const roadmap = loadRoadmap(roadmapPath);
    for (const extra of [
      {
        body: "no manifest marker",
        labels: ["cold-start-roadmap"],
      },
      {
        body: "<!-- one-cli:cold-start-seed:99-untrusted:v1 -->",
        labels: [] as string[],
      },
    ]) {
      const github = new FakeGitHub();
      const seedOperations = new MemorySeedOperations();
      await seedRoadmap({ roadmap, github, apply: true, operations: seedOperations });
      await seedRoadmap({ roadmap, github, apply: true, operations: seedOperations });
      github.issues.push({
        number: 100,
        title: "Unknown roadmap issue",
        body: extra.body,
        labels: extra.labels,
        state: "closed",
        htmlUrl: "https://example.test/issues/100",
      });
      let invoked = 0;
      const oneCli = {
        doctor: async () => {
          invoked++;
          return { ok: true, checks: [], process: processResult() };
        },
      } as unknown as OneCliClient;
      const supervisor = new ColdStartSupervisor({
        roadmap,
        github,
        oneCli,
        journal: new HostJournal(path.join(root, `${extra.body.length}.jsonl`)),
        seedOperations,
      });
      await expect(supervisor.tick()).resolves.toMatchObject({
        action: "roadmap-set",
        state: "blocked",
      });
      expect(invoked).toBe(0);
    }
  });

  it("records the final release gate once and accepts later descendant releases", async () => {
    const fixture = await completedRoadmapFixture(temp("handoff"));
    await expect(fixture.supervisor.tick()).resolves.toMatchObject({
      action: "close-parent",
      phase: "roadmap",
      state: "succeeded",
    });
    await expect(fixture.supervisor.tick()).resolves.toMatchObject({
      phase: "normal",
      state: "idle",
    });
    expect(fixture.activeRelease()).toMatchObject({ sha: fixture.nextReleaseSha });

    await expect(fixture.supervisor.tick()).resolves.toMatchObject({
      phase: "normal",
      state: "idle",
    });
    expect(fixture.normalTicks()).toBe(2);
    const handoffs = fixture.journal.read().filter(
      (event) => event.type === "roadmap.handoff.completed",
    );
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]?.data).toEqual({
      parentNumber: fixture.parent.number,
      finalChildIssueNumber: fixture.finalIssue.number,
      finalPullNumber: fixture.finalPull.number,
      finalMergeSha: fixture.finalReleaseSha,
      activeReleaseSha: fixture.finalReleaseSha,
    });
  });

  it("fails closed on tampered, missing, or rolled-back handoff evidence", async () => {
    const tampered = await completedRoadmapFixture(temp("handoff-tampered"));
    await tampered.supervisor.tick();
    await tampered.supervisor.tick();
    rewriteJournal(tampered.journal.filePath, (event) =>
      event.type === "roadmap.handoff.completed"
        ? { ...event, data: { ...event.data, finalPullNumber: 999_999 } }
        : event);
    await expect(tampered.supervisor.tick()).resolves.toMatchObject({
      action: "handoff",
      phase: "normal",
      state: "blocked",
    });

    const missing = await completedRoadmapFixture(temp("handoff-missing"));
    await missing.supervisor.tick();
    rewriteJournal(
      missing.journal.filePath,
      (event) => event.type === "roadmap.handoff.completed" ? undefined : event,
    );
    await expect(missing.supervisor.tick()).resolves.toMatchObject({
      action: "handoff",
      phase: "normal",
      state: "blocked",
    });

    const rollback = await completedRoadmapFixture(temp("handoff-rollback"));
    await rollback.supervisor.tick();
    await rollback.supervisor.tick();
    rollback.setActiveRelease("0".repeat(40));
    await expect(rollback.supervisor.tick()).resolves.toMatchObject({
      action: "release-lineage",
      phase: "normal",
      state: "blocked",
    });
  });

  it("fails closed on stale locks and keeps the journal append-only under ONE_CLI_HOME", () => {
    const root = temp("host");
    const paths = resolveHarnessPaths({ ONE_CLI_HOME: root } as NodeJS.ProcessEnv);
    fs.mkdirSync(path.dirname(paths.lock), { recursive: true });
    fs.writeFileSync(paths.lock, JSON.stringify({ pid: 999_999_999, token: "stale" }));
    expect(() => acquireHarnessLock(paths.lock)).toThrow("automatic reclaim is disabled");
    fs.unlinkSync(paths.lock);
    const lock = acquireHarnessLock(paths.lock);
    expect(lock.recovered).toBe(false);
    const journal = new HostJournal(paths.journal);
    journal.append("harness.test", { ok: true });
    journal.append("harness.test", { ok: true });
    expect(journal.read().map((event) => event.seq)).toEqual([1, 2]);
    expect(paths.journal.startsWith(root)).toBe(true);
    lock.release();
  });

  it("redacts env-file values before journal persistence", () => {
    const root = temp("journal-redaction");
    const secret = "journal-secret";
    const journal = new HostJournal(path.join(root, "journal.jsonl"), [secret]);
    journal.append("harness.error", { detail: `first\n${secret}\nlast` });
    expect(fs.readFileSync(journal.filePath, "utf8")).not.toContain(secret);
    expect(journal.read()[0]?.data.detail).toContain("[REDACTED]");
  });

  it("allows only one live lock owner", () => {
    const root = temp("lock-race");
    const lockPath = resolveHarnessPaths({ ONE_CLI_HOME: root } as NodeJS.ProcessEnv).lock;
    const first = acquireHarnessLock(lockPath);
    expect(() => acquireHarnessLock(lockPath)).toThrow("already runs");
    first.release();
  });

  it("generates a dry-run launchd job with no embedded secrets", async () => {
    const root = temp("launchd");
    const paths = resolveHarnessPaths({ ONE_CLI_HOME: root } as NodeJS.ProcessEnv);
    const plist = launchdPlist({
      nodeExecutable: "/usr/local/bin/node",
      harnessEntrypoint: "/repo/harness/dist/index.js",
      workspace: "/repo",
      paths,
      ghExecutable: process.execPath,
    });
    expect(plist).toContain("/repo/harness/dist/index.js");
    expect(plist).toContain("ONE_CLI_HARNESS_ENV_FILE");
    expect(plist).toContain("ONE_CLI_GH_EXECUTABLE");
    expect(plist).toContain(process.execPath);
    expect(plist).not.toContain("OPENAI_API_KEY");
    expect(plist).not.toContain("GH_TOKEN");
    expect(plist).not.toContain("secret-value");
    let calls = 0;
    const runner: ProcessRunner = {
      run: async () => {
        calls++;
        return processResult();
      },
    };
    await expect(installLaunchd({ apply: false, runner, plist, paths })).resolves.toMatchObject({
      dryRun: true,
    });
    expect(calls).toBe(0);
  });

  it("canonicalizes configured and discovered gh symlinks with a launchd-minimal PATH", () => {
    const root = temp("gh");
    const executable = path.join(root, "gh-real");
    const configuredLink = path.join(root, "gh-configured");
    const discoveredDirectory = path.join(root, "bin");
    const discoveredLink = path.join(discoveredDirectory, "gh");
    fs.mkdirSync(discoveredDirectory);
    fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    fs.symlinkSync(executable, configuredLink);
    fs.symlinkSync(executable, discoveredLink);
    expect(resolveGhExecutable({
      ONE_CLI_GH_EXECUTABLE: configuredLink,
      PATH: "/usr/bin:/bin",
    }, false)).toBe(executable);
    expect(resolveGhExecutable({ PATH: discoveredDirectory }, true)).toBe(executable);
    expect(() => resolveGhExecutable({ PATH: "/usr/bin:/bin" }, false))
      .toThrow("ONE_CLI_GH_EXECUTABLE");
  });

  it("rejects broken, cyclic, non-file, and non-executable gh targets", () => {
    const root = temp("invalid-gh");
    const broken = path.join(root, "broken");
    fs.symlinkSync(path.join(root, "missing"), broken);
    expect(() => resolveGhExecutable({ ONE_CLI_GH_EXECUTABLE: broken }, false)).toThrow();

    const cycleA = path.join(root, "cycle-a");
    const cycleB = path.join(root, "cycle-b");
    fs.symlinkSync(cycleB, cycleA);
    fs.symlinkSync(cycleA, cycleB);
    expect(() => resolveGhExecutable({ ONE_CLI_GH_EXECUTABLE: cycleA }, false)).toThrow();

    const directory = path.join(root, "directory");
    fs.mkdirSync(directory);
    expect(() => resolveGhExecutable({ ONE_CLI_GH_EXECUTABLE: directory }, false))
      .toThrow("regular executable");

    const nonExecutable = path.join(root, "non-executable");
    fs.writeFileSync(nonExecutable, "not executable", { mode: 0o600 });
    expect(() => resolveGhExecutable({ ONE_CLI_GH_EXECUTABLE: nonExecutable }, false))
      .toThrow("regular executable");
  });

  it("resolves only the exact immutable active release under ONE_CLI_HOME", () => {
    const root = temp("release-home");
    const workspace = temp("release-workspace");
    fs.mkdirSync(path.join(workspace, "dist"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "dist", "index.js"), "bootstrap");
    const repoKey = `fake-repo-${"1".repeat(12)}`;
    expect(resolveHarnessRelease(root, workspace, repoKey)).toMatchObject({
      bootstrap: true,
      sha: null,
    });

    const sha = "a".repeat(40);
    const release = path.join(root, "autonomy", repoKey, "releases", sha);
    fs.mkdirSync(path.join(release, "dist"), { recursive: true });
    const bytes = Buffer.from("immutable release");
    fs.writeFileSync(path.join(release, "dist", "index.js"), bytes);
    const manifestBody = {
      version: 1,
      commitSha: sha,
      totalBytes: bytes.length,
      files: [{
        path: "dist/index.js",
        bytes: bytes.length,
        sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
        executable: false,
      }],
    };
    fs.writeFileSync(path.join(release, "manifest.json"), JSON.stringify({
      ...manifestBody,
      manifestSha256: crypto.createHash("sha256").update(stableJson(manifestBody)).digest("hex"),
    }));
    fs.writeFileSync(path.join(root, "autonomy", repoKey, "releases", "state.json"), JSON.stringify({
      version: 1,
      active: sha,
      generation: 1,
    }));
    expect(resolveHarnessRelease(root, workspace, repoKey)).toMatchObject({
      bootstrap: false,
      sha,
      entrypoint: path.join(release, "dist", "index.js"),
    });
  });
});

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

class FakeGitHub implements GitHubPort {
  readonly issues: HostIssue[] = [];
  readonly pulls = new Map<number, PullEvidence>();
  readonly releaseLineage = new Set<string>();
  loseNextCreateResponse = false;
  loseNextUpdateResponse = false;
  private next = 1;

  async authStatus(): Promise<void> {}

  async findIssueByMarker(marker: string): Promise<HostIssue | undefined> {
    const found = await this.findIssuesByMarker(marker);
    if (found.length > 1) throw new Error("duplicate marker");
    return found[0];
  }

  async findIssuesByMarker(marker: string): Promise<readonly HostIssue[]> {
    return this.issues.filter((issue) => issue.body.includes(marker));
  }

  async listRoadmapIssues(): Promise<readonly HostIssue[]> {
    return this.issues.filter((issue) => issue.labels.includes("cold-start-roadmap"));
  }

  async listSeedMarkerIssues(): Promise<readonly HostIssue[]> {
    return this.issues.filter((issue) => issue.body.includes("<!-- one-cli:cold-start-seed:"));
  }

  async listOpenEnvironmentBlockers(): Promise<readonly HostIssue[]> {
    return this.issues.filter((issue) =>
      issue.state === "open" &&
      issue.labels.includes("agent-ready") &&
      issue.body.includes("<!-- one-cli:environment-blocker:"));
  }

  async assertDefaultBranchContains(): Promise<void> {}

  async assertCommitDescendsFrom(ancestorSha: string, descendantSha: string): Promise<void> {
    if (
      ancestorSha !== descendantSha &&
      !this.releaseLineage.has(`${ancestorSha}:${descendantSha}`)
    ) {
      throw new Error(`${descendantSha} does not descend from ${ancestorSha}`);
    }
  }

  async createIssue(input: {
    title: string;
    body: string;
    labels: readonly string[];
  }): Promise<HostIssue> {
    const issue: HostIssue = {
      number: this.next++,
      title: input.title,
      body: input.body,
      labels: [...input.labels],
      state: "open",
      htmlUrl: `https://example.test/issues/${this.next - 1}`,
    };
    this.issues.push(issue);
    if (this.loseNextCreateResponse) {
      this.loseNextCreateResponse = false;
      throw new Error("lost response");
    }
    return issue;
  }

  async updateIssue(
    number: number,
    input: {
      title?: string;
      state?: "open" | "closed";
      labels?: readonly string[];
      body?: string;
    },
  ): Promise<HostIssue> {
    const issue = this.issues.find((candidate) => candidate.number === number);
    if (!issue) throw new Error("missing issue");
    if (input.title) issue.title = input.title;
    if (input.state) issue.state = input.state;
    if (input.labels) issue.labels = [...input.labels];
    if (input.body !== undefined) issue.body = input.body;
    if (this.loseNextUpdateResponse) {
      this.loseNextUpdateResponse = false;
      throw new Error("lost update response");
    }
    return issue;
  }

  async createComment(): Promise<void> {}

  async findMergedPullForIssue(number: number): Promise<PullEvidence | undefined> {
    return this.pulls.get(number);
  }

  issueForMarker(marker: string): HostIssue {
    const issue = this.issues.find((candidate) => candidate.body.includes(marker));
    if (!issue) throw new Error("missing marker");
    return issue;
  }
}

class MemorySeedOperations implements SeedOperationStore {
  readonly values = new Map<string, SeedOperation>();

  get(operationId: string): SeedOperation | undefined {
    return this.values.get(operationId);
  }

  reserve(input: { operationId: string; marker: string; target: string }): SeedOperation {
    const existing = this.values.get(input.operationId);
    if (existing) return existing;
    const operation: SeedOperation = { ...input, state: "in_doubt" };
    this.values.set(operation.operationId, operation);
    return operation;
  }

  succeed(operationId: string, issueNumber: number): SeedOperation {
    const existing = this.values.get(operationId);
    if (!existing) throw new Error("missing operation");
    const operation: SeedOperation = { ...existing, state: "succeeded", issueNumber };
    this.values.set(operationId, operation);
    return operation;
  }
}

async function completedRoadmapFixture(root: string) {
  const roadmap = loadRoadmap(roadmapPath);
  const github = new FakeGitHub();
  const seedOperations = new MemorySeedOperations();
  await seedRoadmap({ roadmap, github, apply: true, operations: seedOperations });
  await seedRoadmap({ roadmap, github, apply: true, operations: seedOperations });
  const children = roadmap.children.map((child) => github.issueForMarker(child.seedMarker));
  for (const [index, issue] of children.entries()) {
    issue.state = "closed";
    const mergeSha = String(index + 1).repeat(40);
    github.pulls.set(issue.number, {
      number: 100 + index,
      merged: true,
      mergeSha,
      headSha: "a".repeat(40),
      htmlUrl: `https://example.test/pulls/${100 + index}`,
    });
  }
  const parent = github.issueForMarker(roadmap.parent.seedMarker);
  const finalIssue = children.at(-1)!;
  const finalPull = github.pulls.get(finalIssue.number)!;
  const finalReleaseSha = finalPull.mergeSha!;
  const nextReleaseSha = "9".repeat(40);
  github.releaseLineage.add(`${finalReleaseSha}:${nextReleaseSha}`);
  let release = {
    entrypoint: path.join(root, "release", "dist", "index.js"),
    sha: finalReleaseSha,
    bootstrap: false,
  };
  let normalTickCount = 0;
  const attempts = children.map((issue) => ({
    id: `attempt-${issue.number}`,
    issueId: `github-${issue.number}`,
    state: "succeeded",
    prNumber: github.pulls.get(issue.number)!.number,
    detail: {
      postMergeVerified: true,
      postMergeDogfood: ["verified"],
      releaseEvidence: { active: true },
    },
  }));
  const oneCli = {
    doctor: async () => ({ ok: true, checks: [], process: processResult() }),
    status: async () => parseAutonomyStatus({
      schema: "autonomy.one-cli/status-v1",
      executionScope: "roadmap-only",
      mode: "auto-merge",
      activeAttempt: null,
      attempts,
      action: null,
    }),
    activeRelease: () => release,
    once: async (scope: string) => {
      if (scope === "normal") {
        normalTickCount++;
        if (normalTickCount === 1) {
          release = { ...release, sha: nextReleaseSha };
        }
      }
      return { action: "none", state: "idle" };
    },
  } as unknown as OneCliClient;
  const journal = new HostJournal(path.join(root, "journal.jsonl"));
  return {
    supervisor: new ColdStartSupervisor({
      roadmap,
      github,
      oneCli,
      journal,
      seedOperations,
    }),
    journal,
    parent,
    finalIssue,
    finalPull,
    finalReleaseSha,
    nextReleaseSha,
    activeRelease: () => release,
    normalTicks: () => normalTickCount,
    setActiveRelease: (sha: string) => {
      release = { ...release, sha };
    },
  };
}

function rewriteJournal(
  filePath: string,
  map: (event: JournalEvent) => JournalEvent | undefined,
): void {
  const events = fs.readFileSync(filePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => map(JSON.parse(line) as JournalEvent))
    .filter((event): event is JournalEvent => event !== undefined);
  fs.writeFileSync(
    filePath,
    events.length > 0 ? `${events.map((event) => JSON.stringify(event)).join("\n")}\n` : "",
  );
}

function temp(prefix: string): string {
  const root = makeTempDir(`harness-${prefix}`);
  roots.push(root);
  return root;
}

function processResult() {
  return {
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    durationMs: 0,
    timedOut: false,
    cancelled: false,
    outputLimitExceeded: false,
  } as const;
}
