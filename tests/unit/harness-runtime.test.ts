import fs from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  automaticLanes,
  type HarnessClock,
  runLoop,
} from "../../harness/src/index.js";
import {
  HostJournal,
  loadOrCreateRecoveryKey,
  resolveHarnessPaths,
  type JournalEvent,
} from "../../harness/src/host.js";
import { launchdPlist } from "../../harness/src/launchd.js";
import { makeTempDir, removeTempDir } from "../helpers.js";

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) removeTempDir(root);
});

describe("durable harness runtime", () => {
  it("keeps a blocked long-running loop alive but fails a blocked once run", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const longRoot = temp("blocked-loop");
    const longPaths = resolveHarnessPaths({ ONE_CLI_HOME: longRoot } as NodeJS.ProcessEnv);
    const longJournal = new HostJournal(longPaths.journal);
    const controller = new AbortController();
    const clock = new FakeClock(1_000);
    clock.onWait = (count) => {
      if (count === 2) controller.abort();
    };
    let ticks = 0;
    const supervisor = {
      tick: async () => {
        ticks++;
        return {
          action: "park",
          state: "blocked",
          phase: "normal" as const,
          detail: "operator evidence required",
        };
      },
    };

    await expect(runLoop({
      once: false,
      intervalMs: 1_000,
      paths: longPaths,
      journal: longJournal,
      supervisor,
      clock,
      signal: controller.signal,
    })).resolves.toBe(0);
    expect(ticks).toBe(2);
    expect(clock.waits).toEqual([1_000, 1_000]);
    expect(longJournal.read().some((event) => event.type === "harness.heartbeat")).toBe(true);

    const onceRoot = temp("blocked-once");
    const oncePaths = resolveHarnessPaths({ ONE_CLI_HOME: onceRoot } as NodeJS.ProcessEnv);
    await expect(runLoop({
      once: true,
      intervalMs: 1_000,
      paths: oncePaths,
      journal: new HostJournal(oncePaths.journal),
      supervisor,
      clock: new FakeClock(1_000),
    })).resolves.toBe(1);
  });

  it("uses an exposed nextAttemptAt and emits timed health heartbeats", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const root = temp("adaptive");
    const paths = resolveHarnessPaths({ ONE_CLI_HOME: root } as NodeJS.ProcessEnv);
    const journal = new HostJournal(paths.journal);
    const controller = new AbortController();
    const clock = new FakeClock(10_000);
    clock.onWait = () => controller.abort();

    await expect(runLoop({
      once: false,
      intervalMs: 30 * 60_000,
      paths,
      journal,
      supervisor: {
        tick: async () => ({
          action: "park",
          state: "parked",
          phase: "normal" as const,
          detail: "retry scheduled",
          nextAttemptAt: 70_000,
        }),
      },
      clock,
      signal: controller.signal,
    })).resolves.toBe(0);

    expect(clock.waits).toEqual([60_000]);
    expect(journal.read().filter((event) => event.type === "harness.heartbeat")).toHaveLength(2);
  });

  it("allows exactly one of two stale-lock reclaimers to own the lock", async () => {
    const root = temp("reclaimers");
    const lockPath = resolveHarnessPaths({ ONE_CLI_HOME: root } as NodeJS.ProcessEnv).lock;
    const startPath = path.join(root, "start");
    const contendedPath = path.join(root, "contended");
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, `${JSON.stringify({
      pid: 999_999_999,
      token: "a".repeat(32),
      startedAt: "2026-01-01T00:00:00.000Z",
    })}\n`);

    const readyPaths = [path.join(root, "ready-a"), path.join(root, "ready-b")];
    const contenders = readyPaths.map((readyPath, index) =>
      spawnReclaimer(String(index), lockPath, startPath, readyPath, contendedPath));
    await waitUntil(() => readyPaths.every((readyPath) => fs.existsSync(readyPath)));
    fs.writeFileSync(startPath, "start");
    const results = await Promise.all(contenders);
    expect(results.filter((result) => result.acquired)).toHaveLength(1);
    expect(results.find((result) => result.acquired)?.recovered).toBe(true);
    expect(results.filter((result) => !result.acquired)).toHaveLength(1);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("segments and verifies the journal hash chain across rollover", () => {
    const root = temp("journal-rollover");
    const filePath = path.join(root, "journal.jsonl");
    const journal = new HostJournal(filePath, [], { maxSegmentBytes: 700 });
    for (let index = 0; index < 12; index++) {
      journal.append("harness.test", { index, payload: "x".repeat(180) });
    }

    const segments = fs.readdirSync(root).filter((name) => name.includes(".segment-"));
    expect(segments.length).toBeGreaterThan(1);
    const events = new HostJournal(filePath, [], { maxSegmentBytes: 700 }).read();
    expect(events.map((event) => event.seq)).toEqual(
      Array.from({ length: 12 }, (_, index) => index + 1),
    );
    expect(events.every((event) => event.hash && event.prevHash)).toBe(true);

    const firstSegment = path.join(root, segments.sort()[0]!);
    const lines = fs.readFileSync(firstSegment, "utf8").trimEnd().split("\n");
    const first = JSON.parse(lines[0]!) as JournalEvent;
    lines[0] = JSON.stringify({ ...first, data: { ...first.data, index: 999 } });
    fs.writeFileSync(firstSegment, `${lines.join("\n")}\n`);
    expect(() => new HostJournal(filePath, [], { maxSegmentBytes: 700 }))
      .toThrow("hash chain is corrupt");
  });

  it("extends legacy journals with a verifiable hash-chain transition", () => {
    const root = temp("legacy-journal");
    const filePath = path.join(root, "journal.jsonl");
    fs.writeFileSync(filePath, [
      JSON.stringify({ seq: 1, at: "2026-01-01T00:00:00.000Z", type: "legacy", data: {} }),
      JSON.stringify({ seq: 2, at: "2026-01-01T00:01:00.000Z", type: "legacy", data: {} }),
      "",
    ].join("\n"));
    const journal = new HostJournal(filePath);
    const appended = journal.append("harness.test");
    expect(appended).toMatchObject({ seq: 3 });
    expect(appended.hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(new HostJournal(filePath).read()).toHaveLength(3);
  });

  it("stream-migrates an oversized legacy journal into bounded verified segments", () => {
    const root = temp("legacy-migration");
    const filePath = path.join(root, "journal.jsonl");
    const legacy = writeOversizedLegacyJournal(filePath);
    expect(Buffer.byteLength(legacy)).toBeGreaterThan(700);

    const events = new HostJournal(filePath, [], { maxSegmentBytes: 700 }).read(100);
    const files = fs.readdirSync(root).filter((name) => name.startsWith("journal.jsonl"));
    expect(events).toHaveLength(30);
    expect(events.every((event) => event.hash && event.prevHash)).toBe(true);
    expect(files.length).toBeGreaterThan(1);
    for (const name of files) {
      expect(fs.statSync(path.join(root, name)).size).toBeLessThanOrEqual(700);
    }
  });

  it("reconciles every durable legacy migration crash phase on startup", () => {
    const planningRoot = temp("legacy-migration-plan");
    const planningPath = path.join(planningRoot, "journal.jsonl");
    writeOversizedLegacyJournal(planningPath);
    expect(() =>
      new HostJournal(planningPath, [], {
        maxSegmentBytes: 700,
        onLegacyMigrationStep(step) {
          if (step === "after-manifest-durable") throw new Error("simulated crash");
        },
      })
    ).toThrow("simulated crash");
    const manifest = JSON.parse(
      fs.readFileSync(`${planningPath}.migration-state.json`, "utf8"),
    ) as { segments: unknown[] };
    const lastSegment = manifest.segments.length;
    expect(lastSegment).toBeGreaterThan(2);
    expect(new HostJournal(planningPath, [], { maxSegmentBytes: 700 }).read(100))
      .toHaveLength(30);

    const crashPoints = [
      "after-source-rename",
      "after-segment-rename:1",
      `after-segment-rename:${Math.ceil(lastSegment / 2)}`,
      `after-segment-rename:${lastSegment}`,
      "after-chain-verification",
      "after-backup-removal",
    ];
    for (const [index, crashPoint] of crashPoints.entries()) {
      const root = temp(`legacy-migration-crash-${index}`);
      const filePath = path.join(root, "journal.jsonl");
      writeOversizedLegacyJournal(filePath);
      expect(() =>
        new HostJournal(filePath, [], {
          maxSegmentBytes: 700,
          onLegacyMigrationStep(step) {
            if (step === crashPoint) throw new Error(`simulated crash at ${step}`);
          },
        })
      ).toThrow(`simulated crash at ${crashPoint}`);

      const events = new HostJournal(filePath, [], { maxSegmentBytes: 700 }).read(100);
      expect(events.map((event) => event.seq)).toEqual(
        Array.from({ length: 30 }, (_, eventIndex) => eventIndex + 1),
      );
      expect(events.every((event) => event.hash && event.prevHash)).toBe(true);
      const names = fs.readdirSync(root);
      expect(names.some((name) =>
        name.includes(".migration-") ||
        name.includes(".legacy-") ||
        name.endsWith(".migration-state.json")
      )).toBe(false);
      for (const name of names.filter((name) => name.startsWith("journal.jsonl"))) {
        expect(fs.statSync(path.join(root, name)).size).toBeLessThanOrEqual(700);
      }
    }
  });

  it("creates one canonical private recovery key and never changes it", () => {
    const root = temp("recovery-key");
    const paths = resolveHarnessPaths({ ONE_CLI_HOME: root } as NodeJS.ProcessEnv);
    const first = loadOrCreateRecoveryKey(paths.recoveryKey);
    const second = loadOrCreateRecoveryKey(paths.recoveryKey);
    const stat = fs.lstatSync(paths.recoveryKey);
    expect(first).toEqual(second);
    expect(first).toHaveLength(32);
    expect(stat.isFile()).toBe(true);
    expect(stat.isSymbolicLink()).toBe(false);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(fs.realpathSync(paths.recoveryKey)).toBe(paths.recoveryKey);
  });

  it("isolates product and verifier lane failures while journaling each", async () => {
    const root = temp("lane-isolation");
    const journal = new HostJournal(path.join(root, "journal.jsonl"));
    let verifierTicks = 0;
    const productFailure = automaticLanes(
      {
        inspect: async () => ({
          schema: "one-cli.harness/governance-readiness-v1",
          ready: true,
          checks: [],
          release: null,
        }),
      },
      { tick: async () => { throw new Error("product unavailable"); } },
      {
        tick: async () => {
          verifierTicks++;
          return { action: "verify", state: "idle", detail: "healthy" };
        },
      },
      journal,
    );
    await expect(productFailure.tick()).resolves.toMatchObject({
      action: "product-lane-failure",
      state: "blocked",
    });
    expect(verifierTicks).toBe(1);
    expect(journal.read().some((event) => event.type === "harness.product-lane-failed"))
      .toBe(true);

    let productTicks = 0;
    const verifierFailure = automaticLanes(
      {
        inspect: async () => ({
          schema: "one-cli.harness/governance-readiness-v1",
          ready: true,
          checks: [],
          release: null,
        }),
      },
      {
        tick: async () => {
          productTicks++;
          return { action: "product", state: "idle", phase: "normal", detail: "healthy" };
        },
      },
      { tick: async () => { throw new Error("verifier unavailable"); } },
      journal,
    );
    await expect(verifierFailure.tick()).resolves.toMatchObject({
      action: "product",
      state: "idle",
      detail: expect.stringContaining("verifier unavailable"),
    });
    expect(productTicks).toBe(1);
    expect(journal.read().some((event) => event.type === "harness.verifier-lane-failed"))
      .toBe(true);
  });

  it("renders crash-only launchd policy with bounded output", () => {
    const root = temp("launchd-template");
    const paths = resolveHarnessPaths({ ONE_CLI_HOME: root } as NodeJS.ProcessEnv);
    const generated = launchdPlist({
      nodeExecutable: process.execPath,
      harnessEntrypoint: "/repo/harness/dist/index.js",
      workspace: "/repo",
      paths,
      ghExecutable: "/usr/bin/gh",
    });
    const template = fs.readFileSync(
      path.resolve(import.meta.dirname, "../../harness/launchd/com.beforeload.one-cli-harness.plist"),
      "utf8",
    );
    for (const plist of [generated, template]) {
      expect(plist).toMatch(
        /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/u,
      );
      expect(plist).toContain("<integer>300</integer>");
      expect(plist.match(/<string>\/dev\/null<\/string>/gu)).toHaveLength(2);
    }
  });

  it("survives 1000 ticks with intermittent failures without busy-looping", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const root = temp("soak-1000");
    const paths = resolveHarnessPaths({ ONE_CLI_HOME: root } as NodeJS.ProcessEnv);
    const journal = new HostJournal(paths.journal);
    const controller = new AbortController();
    const clock = new FakeClock(0);
    let ticks = 0;
    let inspectCalls = 0;
    clock.onWait = (count) => {
      if (count >= 1_000) controller.abort();
    };
    const lanes = automaticLanes(
      {
        inspect: async () => {
          inspectCalls += 1;
          // Sparse transient faults: enough to exercise the circuit, but the
          // next probe after a half-open window must be allowed to succeed so
          // the product lane can keep advancing.
          if (inspectCalls % 41 === 0) throw new Error("network timeout ECONNRESET");
          return {
            schema: "one-cli.harness/governance-readiness-v1" as const,
            ready: true,
            checks: [],
            release: null,
          };
        },
      },
      {
        tick: async () => {
          ticks += 1;
          if (ticks % 23 === 0) {
            return {
              action: "product",
              state: "blocked",
              phase: "normal" as const,
              // Non-transient: must not permanently reopen the provider circuit
              // while the product counter is parked on the same tick.
              detail: "gate:test failed with assertion mismatch",
            };
          }
          if (ticks % 29 === 0) {
            return {
              action: "product",
              state: "blocked",
              phase: "normal" as const,
              detail: "provider temporarily unavailable 504",
            };
          }
          return {
            action: "product",
            state: "idle",
            phase: "normal" as const,
            detail: "idle",
          };
        },
      },
      {
        tick: async () => ({
          action: "verifier-status",
          state: "idle",
          detail: "ok",
        }),
      },
      journal,
    );

    await expect(runLoop({
      once: false,
      intervalMs: 1_000,
      paths,
      journal,
      supervisor: lanes,
      clock,
      signal: controller.signal,
    })).resolves.toBe(0);

    expect(clock.waits.length).toBeGreaterThanOrEqual(1_000);
    expect(ticks).toBeGreaterThan(900);
    expect(clock.waits.every((wait) => wait >= 1_000)).toBe(true);
    expect(journal.read().some((event) => event.type === "harness.heartbeat")).toBe(true);
    expect(journal.read().some((event) => event.type === "harness.circuit")).toBe(true);
  }, 60_000);
});

describe("service circuit", () => {
  it("opens after repeated transient failures and half-opens after the window", async () => {
    const { ServiceCircuit } = await import("../../harness/src/circuit.js");
    let now = 1_000;
    const circuit = new ServiceCircuit({
      failureThreshold: 3,
      openMs: 10_000,
      now: () => now,
    });
    circuit.recordFailure();
    circuit.recordFailure();
    expect(circuit.isOpen()).toBe(false);
    circuit.recordFailure();
    expect(circuit.isOpen()).toBe(true);
    expect(circuit.nextAttemptAt()).toBe(11_000);
    now = 11_000;
    expect(circuit.isOpen()).toBe(false);
    circuit.recordSuccess();
    expect(circuit.snapshot().failures).toBe(0);
  });
});

class FakeClock implements HarnessClock {
  readonly waits: number[] = [];
  onWait?: (count: number) => void;
  private readonly timers = new Map<
    ReturnType<typeof setInterval>,
    { callback: () => void; interval: number; next: number }
  >();

  constructor(private time: number) {}

  now(): number {
    return this.time;
  }

  async wait(milliseconds: number, _signal: AbortSignal): Promise<void> {
    this.waits.push(milliseconds);
    const target = this.time + milliseconds;
    for (const timer of this.timers.values()) {
      while (timer.next <= target) {
        this.time = timer.next;
        timer.callback();
        timer.next += timer.interval;
      }
    }
    this.time = target;
    this.onWait?.(this.waits.length);
  }

  setInterval(callback: () => void, milliseconds: number): ReturnType<typeof setInterval> {
    const handle = { unref: () => handle } as unknown as ReturnType<typeof setInterval>;
    this.timers.set(handle, {
      callback,
      interval: milliseconds,
      next: this.time + milliseconds,
    });
    return handle;
  }

  clearInterval(timer: ReturnType<typeof setInterval>): void {
    this.timers.delete(timer);
  }
}

function temp(prefix: string): string {
  const root = makeTempDir(`harness-runtime-${prefix}`);
  roots.push(root);
  return root;
}

function spawnReclaimer(
  id: string,
  lockPath: string,
  startPath: string,
  readyPath: string,
  contendedPath: string,
): Promise<{ acquired: boolean; recovered?: boolean; error?: string }> {
  const hostUrl = pathToFileURL(
    path.resolve(import.meta.dirname, "../../harness/src/host.ts"),
  ).href;
  const source = `
    import fs from "node:fs";
    import { acquireHarnessLock } from ${JSON.stringify(hostUrl)};
    const delay = () => new Promise((resolve) => setTimeout(resolve, 5));
    fs.writeFileSync(${JSON.stringify(readyPath)}, "ready");
    while (!fs.existsSync(${JSON.stringify(startPath)})) await delay();
    try {
      const lock = acquireHarnessLock(${JSON.stringify(lockPath)});
      while (!fs.existsSync(${JSON.stringify(contendedPath)})) await delay();
      lock.release();
      console.log(JSON.stringify({ acquired: true, recovered: lock.recovered }));
    } catch (error) {
      fs.writeFileSync(${JSON.stringify(contendedPath)}, ${JSON.stringify(id)});
      console.log(JSON.stringify({
        acquired: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", source],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`Reclaimer exited ${String(code)}: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()) as {
          acquired: boolean;
          recovered?: boolean;
          error?: string;
        });
      } catch {
        reject(new Error(`Reclaimer returned invalid output: ${stdout}\n${stderr}`));
      }
    });
  });
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for reclaimers");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function writeOversizedLegacyJournal(filePath: string): string {
  const legacy = Array.from({ length: 30 }, (_, index) =>
    JSON.stringify({
      seq: index + 1,
      at: new Date(index * 1_000).toISOString(),
      type: "legacy",
      data: { payload: "x".repeat(80) },
    })
  ).join("\n") + "\n";
  fs.writeFileSync(filePath, legacy);
  return legacy;
}

