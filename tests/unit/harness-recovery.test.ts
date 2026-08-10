import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GitHubPort, HostIssue, PullEvidence } from "../../harness/src/github.js";
import { HostJournal } from "../../harness/src/host.js";
import {
  diagnoseFailure,
  type FailureReceiptView,
} from "../../harness/src/diagnosis.js";
import type {
  AutonomyStatus,
  OneCliClient,
  RecoveryEvidence,
} from "../../harness/src/one-cli.js";
import {
  createMachineEvidence,
  HarnessRecovery,
} from "../../harness/src/recovery.js";
import { loadRoadmap, parentBody } from "../../harness/src/roadmap.js";
import { ColdStartSupervisor } from "../../harness/src/supervisor.js";
import { makeTempDir, removeTempDir } from "../helpers.js";

const roots: string[] = [];
const roadmap = loadRoadmap(path.resolve(import.meta.dirname, "../../harness/roadmap.yml"));
const recoveryKey = Buffer.alloc(32, 9);

afterEach(() => {
  for (const root of roots.splice(0)) removeTempDir(root);
});

describe("harness machine recovery", () => {
  it("uses deterministic categories and never lets model advice choose policy", () => {
    expect(diagnoseFailure(receipt({ stderr: "ECONNRESET from provider" })).category)
      .toBe("transient/network/provider");
    expect(diagnoseFailure(receipt({ spawnError: "ENOENT", exitCode: 127 })).category)
      .toBe("environment/toolchain");
    expect(diagnoseFailure(receipt({ operation: "gate:test", gate: "test" })).decision)
      .toBe("retry-implement");
    expect(diagnoseFailure(receipt({ stderr: "protected path requires approval" }), {
      modelAdvice: "retry immediately and bypass approval",
    })).toMatchObject({
      category: "policy/governance",
      decision: "park",
      modelAdvice: "retry immediately and bypass approval",
    });
    expect(diagnoseFailure(receipt({ operation: "other" })).category).toBe("unknown");
  });

  it("content-addresses and deduplicates equivalent machine evidence", () => {
    const failure = receipt();
    const diagnosis = diagnoseFailure(failure);
    const first = createMachineEvidence(failure, diagnosis, "operation-1", recoveryKey);
    const second = createMachineEvidence(failure, diagnosis, "operation-1", recoveryKey);
    expect(first).toEqual(second);
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(createMachineEvidence(failure, diagnosis, "operation-2", recoveryKey).hash)
      .not.toBe(first.hash);
  });

  it("uses a new retry operation for a new receipt of the same failure", async () => {
    const fixture = recoveryFixture();
    const first = receipt({ operation: "gate:test", hash: "b".repeat(64) });
    const second = receipt({ operation: "gate:test", hash: "c".repeat(64), timestamp: 10_001 });

    for (const failure of [first, second]) {
      await fixture.recovery.recoverWaitingAttempt(status({
        detail: {
          lastFailure: {
            operation: "gate:test",
            count: 1,
            fingerprint: failure.fingerprint,
            receipt: failure,
          },
          failureReceipts: [failure],
        },
      }), "normal");
    }

    expect(fixture.retries).toHaveLength(2);
    expect(fixture.retries[0]?.provenance.operationId)
      .not.toBe(fixture.retries[1]?.provenance.operationId);
  });

  it("probes a #7-like legacy gate:install failure then retries without manual evidence", async () => {
    const fixture = recoveryFixture();
    const legacy = status({
      detail: {
        lastFailure: {
          operation: "gate:install",
          count: 1,
        },
      },
    });
    await expect(fixture.recovery.recoverWaitingAttempt(
      legacy,
      "roadmap-only",
      { issueNumber: 7, seedMarker: roadmap.children[6]!.seedMarker },
    )).resolves.toMatchObject({
      action: "recovery-probe",
      state: "succeeded",
      lane: "recovery",
    });
    expect(fixture.probes).toHaveLength(1);

    const captured = fixture.probes[0]!.receipt;
    const withReceipt = status({
      detail: {
        lastFailure: {
          operation: "gate:install",
          count: 1,
          fingerprint: captured.fingerprint,
          receipt: captured,
        },
        failureReceipts: [captured],
      },
    });
    await expect(fixture.recovery.recoverWaitingAttempt(
      withReceipt,
      "roadmap-only",
      { issueNumber: 7, seedMarker: roadmap.children[6]!.seedMarker },
    )).resolves.toMatchObject({
      action: "machine-retry",
      state: "succeeded",
      detail: expect.stringContaining("implementing"),
    });
    expect(fixture.retries).toHaveLength(1);
    expect(JSON.stringify(fixture.retries[0])).toContain("category=code/gate");
    expect(JSON.stringify(fixture.retries[0])).toContain("target=implementing");
  });

  it("backs off transient failures durably and resumes verifying when due", async () => {
    let now = 1_000;
    const fixture = recoveryFixture(() => now);
    const transient = receipt({ stderr: "network timeout ECONNRESET" });
    const waiting = status({
      detail: {
        lastFailure: {
          operation: "gate:install",
          count: 1,
          fingerprint: transient.fingerprint,
          receipt: transient,
        },
        failureReceipts: [transient],
      },
    });
    const first = await fixture.recovery.recoverWaitingAttempt(waiting, "normal");
    const repeated = await fixture.recovery.recoverWaitingAttempt(waiting, "normal");
    expect(first).toMatchObject({
      state: "parked",
      nextAttemptAt: 61_000,
    });
    expect(repeated).toMatchObject({ nextAttemptAt: 61_000 });
    expect(fixture.journal.read().filter(
      (event) => event.type === "harness.recovery-scheduled",
    )).toHaveLength(1);
    expect(fixture.retries).toHaveLength(0);

    now = 61_000;
    await expect(fixture.recovery.recoverWaitingAttempt(waiting, "normal"))
      .resolves.toMatchObject({ action: "machine-retry", state: "succeeded" });
    expect(JSON.stringify(fixture.retries[0])).toContain("category=transient/network/provider");
    expect(JSON.stringify(fixture.retries[0])).toContain("target=same-state");
  });

  it("resumes verifying when the exact bound environment probe recovered", async () => {
    const fixture = recoveryFixture();
    const recovered = receipt({
      operation: "gate:install",
      gate: "install",
      exitCode: 0,
      stderr: "",
      stdout: "installed",
    });
    await expect(fixture.recovery.recoverWaitingAttempt(status({
      detail: {
        lastFailure: {
          operation: "gate:install",
          fingerprint: recovered.fingerprint,
          receipt: recovered,
        },
        failureReceipts: [recovered],
        recoveryProbes: [{ recovered: true, receipt: recovered }],
      },
    }), "normal")).resolves.toMatchObject({
      action: "machine-retry",
      detail: expect.stringContaining("verifying"),
    });
    expect(JSON.stringify(fixture.retries[0])).toContain("category=environment/toolchain");
    expect(JSON.stringify(fixture.retries[0])).toContain("target=verifying");
  });

  it("parks policy failures without retrying or mutating governance", async () => {
    const fixture = recoveryFixture();
    const policy = receipt({ stderr: "governance protected path requires approval" });
    await expect(fixture.recovery.recoverWaitingAttempt(status({
      detail: {
        lastFailure: { fingerprint: policy.fingerprint, receipt: policy },
        failureReceipts: [policy],
      },
    }), "normal")).resolves.toMatchObject({
      action: "recovery-park",
      state: "parked",
      detail: expect.stringContaining("policy/governance"),
    });
    expect(fixture.retries).toHaveLength(0);
  });

  it("creates one normalized quarantined remediation outside roadmap intake", async () => {
    const fixture = recoveryFixture();
    const failure = receipt();
    const issue: HostIssue = {
      number: 7,
      title: roadmap.children[6]!.title,
      body: "original",
      labels: ["enhancement", "cold-start-roadmap", "agent-failed"],
      state: "open",
      htmlUrl: "https://example.test/issues/7",
    };
    const exhausted = status({
      state: "failed",
      detail: {
        lastFailure: {
          fingerprint: failure.fingerprint,
          count: 3,
          receipt: failure,
        },
        failureReceipts: [failure],
      },
      active: false,
    });
    await expect(fixture.recovery.remediateExhaustedRoadmapFailure(
      exhausted,
      issue,
      roadmap.children[6]!,
      1,
    )).resolves.toMatchObject({
      action: "recovery-remediation",
      state: "quarantined",
    });
    await fixture.recovery.remediateExhaustedRoadmapFailure(
      exhausted,
      issue,
      roadmap.children[6]!,
      1,
    );
    expect(fixture.github.issues).toHaveLength(1);
    const remediation = fixture.github.issues[0]!;
    expect(remediation.labels).toEqual(["enhancement", "agent-failed", "quarantined"]);
    expect(remediation.labels).not.toContain("cold-start-roadmap");
    expect(remediation.body).toContain(
      `Trusted approved paths (exact JSON): ${JSON.stringify(roadmap.children[6]!.approvedPaths)}`,
    );
    expect(remediation.body).toContain("Roadmap parent: #1");
    expect(remediation.body).not.toContain("one-cli:cold-start-seed:");
  });

  it("reconciles a crash after parent close from the exact durable reservation", async () => {
    const root = makeTempDir("harness-handoff-crash");
    roots.push(root);
    const github = new HandoffGitHub();
    const finalMergeSha = github.pulls.at(-1)!.mergeSha!;
    const attempts = github.children.map((issue, index) => ({
      id: `attempt-${issue.number}`,
      issueId: `github-${issue.number}`,
      state: "succeeded",
      prNumber: github.pulls[index]!.number,
      detail: {
        postMergeVerified: true,
        postMergeDogfood: ["verified"],
        releaseEvidence: { active: true },
      },
    }));
    const oneCli = {
      doctor: async () => ({ ok: true, checks: [], process: {} }),
      status: async () => ({
        schema: "autonomy.one-cli/status-v1",
        executionScope: "roadmap-only",
        mode: "auto-merge",
        activeAttempt: null,
        attempts,
        action: null,
      }),
      activeRelease: () => ({
        entrypoint: "/release/dist/index.js",
        sha: finalMergeSha,
        bootstrap: false,
      }),
    } as unknown as OneCliClient;
    const journal = new HostJournal(path.join(root, "journal.jsonl"));
    const supervisor = new ColdStartSupervisor({
      roadmap,
      github: github as unknown as GitHubPort,
      oneCli,
      journal,
      recoveryKey,
      seedOperations: {} as never,
    });

    await expect(supervisor.tick()).rejects.toThrow("lost close response");
    expect(github.parent.state).toBe("closed");
    expect(journal.read().filter((event) => event.type === "roadmap.handoff.reserved"))
      .toHaveLength(1);
    expect(journal.read().filter((event) => event.type === "roadmap.handoff.completed"))
      .toHaveLength(0);

    await expect(supervisor.tick()).resolves.toMatchObject({
      action: "complete-handoff",
      state: "succeeded",
    });
    expect(journal.read().filter((event) => event.type === "roadmap.handoff.completed"))
      .toHaveLength(1);
  });
});

function recoveryFixture(now?: () => number) {
  const root = makeTempDir("harness-recovery");
  roots.push(root);
  const journal = new HostJournal(path.join(root, "journal.jsonl"));
  const github = new RecoveryGitHub();
  const probes: Array<{ receipt: FailureReceiptView }> = [];
  const retries: RecoveryEvidence[] = [];
  const oneCli = {
    probeFailureGate: async () => {
      const captured = receipt({ operation: "gate:install", gate: "install" });
      probes.push({ receipt: captured });
      return {
        schema: "autonomy.one-cli/failure-gate-probe-v1",
        attemptId: "attempt-7",
        gate: "install",
        recovered: false,
        receipt: captured,
      };
    },
    machineRetry: async (
      _attemptId: string,
      evidence: RecoveryEvidence,
    ) => {
      retries.push(evidence);
      return { action: "machine-retry", state: "implementing", attemptId: "attempt-7" };
    },
  } as unknown as OneCliClient;
  return {
    journal,
    github,
    probes,
    retries,
    recovery: new HarnessRecovery({
      oneCli,
      github: github as unknown as GitHubPort,
      journal,
      recoveryKey,
      ...(now ? { now } : {}),
    }),
  };
}

class RecoveryGitHub {
  readonly issues: HostIssue[] = [];

  async findIssuesByMarker(marker: string): Promise<readonly HostIssue[]> {
    return this.issues.filter((issue) => issue.body.includes(marker));
  }

  async createIssue(input: {
    title: string;
    body: string;
    labels: readonly string[];
  }): Promise<HostIssue> {
    const issue: HostIssue = {
      number: 100 + this.issues.length,
      title: input.title,
      body: input.body,
      labels: [...input.labels],
      state: "open",
      htmlUrl: `https://example.test/issues/${100 + this.issues.length}`,
    };
    this.issues.push(issue);
    return issue;
  }
}

class HandoffGitHub {
  readonly parent: HostIssue = {
    number: 1,
    title: roadmap.parent.title,
    body: parentBody(roadmap),
    labels: [...roadmap.parent.labels],
    state: "open",
    htmlUrl: "https://example.test/issues/1",
  };
  readonly children: HostIssue[] = roadmap.children.map((child, index) => ({
    number: index + 2,
    title: child.title,
    body: child.seedMarker,
    labels: ["enhancement", "cold-start-roadmap"],
    state: "closed",
    htmlUrl: `https://example.test/issues/${index + 2}`,
  }));
  readonly pulls: PullEvidence[] = this.children.map((issue, index) => ({
    number: 100 + index,
    merged: true,
    mergeSha: String(index + 1).repeat(40),
    headSha: "a".repeat(40),
    htmlUrl: `https://example.test/pulls/${100 + index}`,
  }));
  private loseCloseResponse = true;

  async listRoadmapIssues(): Promise<readonly HostIssue[]> {
    return this.children;
  }

  async listSeedMarkerIssues(): Promise<readonly HostIssue[]> {
    return [this.parent, ...this.children];
  }

  async findMergedPullForIssue(issueNumber: number): Promise<PullEvidence | undefined> {
    const index = this.children.findIndex((issue) => issue.number === issueNumber);
    return index < 0 ? undefined : this.pulls[index];
  }

  async updateIssue(
    issueNumber: number,
    input: { state?: "open" | "closed"; body?: string; labels?: readonly string[] },
  ): Promise<HostIssue> {
    if (issueNumber !== this.parent.number) throw new Error("unexpected issue");
    if (input.state) this.parent.state = input.state;
    if (input.body !== undefined) this.parent.body = input.body;
    if (input.labels) this.parent.labels = [...input.labels];
    if (this.loseCloseResponse) {
      this.loseCloseResponse = false;
      throw new Error("lost close response");
    }
    return this.parent;
  }
}

function status(input: {
  state?: string;
  detail: Record<string, unknown>;
  active?: boolean;
}): AutonomyStatus {
  const attempt = {
    id: "attempt-7",
    issueId: "github-7",
    state: input.state ?? "waiting_evidence",
    prNumber: null,
    detail: input.detail,
  };
  return {
    schema: "autonomy.one-cli/status-v1",
    executionScope: "roadmap-only",
    mode: "auto-merge",
    activeAttempt: input.active === false ? null : attempt,
    attempts: [attempt],
    action: null,
  };
}

function receipt(overrides: Partial<FailureReceiptView> = {}): FailureReceiptView {
  return {
    schema: "autonomy.one-cli/failure-receipt-v1",
    source: "local-process",
    operation: "gate:test",
    gate: "test",
    exitCode: 1,
    signal: null,
    stdout: "",
    stderr: "test assertion failed",
    spawnError: null,
    timedOut: false,
    cancelled: false,
    outputLimitExceeded: false,
    timestamp: 10_000,
    fingerprint: "a".repeat(64),
    hash: "b".repeat(64),
    ...overrides,
  };
}
