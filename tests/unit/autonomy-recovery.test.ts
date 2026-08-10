import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadAutonomyConfig,
  parseRecoveryPolicy,
} from "../../src/autonomy/config.js";
import { dispatchAutonomyCli } from "../../src/autonomy/cli.js";
import type { GitHubPort } from "../../src/autonomy/github.js";
import {
  AutonomyOrchestrator,
  type OrchestratorGitPort,
} from "../../src/autonomy/orchestrator.js";
import {
  assertRecoveryEvidence,
  createFailureReceipt,
  createRecoveryEvidence,
  recoveryEvidenceDigest,
  runtimeEnvironmentHash,
} from "../../src/autonomy/process.js";
import { AutonomyStore } from "../../src/autonomy/store.js";
import { makeTempDir, removeTempDir } from "../helpers.js";

describe("autonomy recovery evidence", () => {
  const roots: string[] = [];
  const recoveryKey = Buffer.alloc(32, 7);

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const root of roots.splice(0)) removeTempDir(root);
  });

  it("normalizes, redacts, and bounds complete process failure receipts", () => {
    const context = {
      source: "local-process" as const,
      attemptId: "attempt-1",
      operationId: "failure-1",
      operation: "gate:unit",
      gate: "unit",
      issueDigest: "a".repeat(64),
      diffHash: "b".repeat(64),
      policyHash: "c".repeat(64),
      environmentHash: runtimeEnvironmentHash({
        platform: "test",
        architecture: "test",
        nodeVersion: "test",
      }),
      timestamp: 10_000,
    };
    const result = {
      exitCode: null,
      signal: "SIGTERM" as const,
      stdout: `OPENAI_API_KEY=sk-${"x".repeat(80)}\n${"output ".repeat(100)}`,
      stderr: `Authorization: Bearer ${"y".repeat(80)}\nfailed`,
      spawnError: `password=${"z".repeat(80)}`,
      durationMs: 2_500,
      timedOut: true,
      cancelled: false,
      outputLimitExceeded: true,
    };
    const limits = {
      maxStdoutBytes: 96,
      maxStderrBytes: 96,
      maxSpawnErrorBytes: 48,
    };
    const receipt = createFailureReceipt(context, result, limits);
    const equivalent = createFailureReceipt(
      { ...context, operationId: "failure-2", timestamp: 20_000 },
      { ...result, durationMs: 9_999 },
      limits,
    );

    expect(receipt).toMatchObject({
      operation: "gate:unit",
      gate: "unit",
      timedOut: true,
      outputLimitExceeded: true,
      durationMs: 2_500,
      issueDigest: "a".repeat(64),
      diffHash: "b".repeat(64),
      policyHash: "c".repeat(64),
    });
    expect(JSON.stringify(receipt)).not.toContain("sk-");
    expect(JSON.stringify(receipt)).not.toContain("y".repeat(20));
    expect(JSON.stringify(receipt)).not.toContain("z".repeat(20));
    expect(Buffer.byteLength(receipt.stdout)).toBeLessThanOrEqual(limits.maxStdoutBytes);
    expect(Buffer.byteLength(receipt.stderr)).toBeLessThanOrEqual(limits.maxStderrBytes);
    expect(Buffer.byteLength(receipt.spawnError ?? "")).toBeLessThanOrEqual(
      limits.maxSpawnErrorBytes,
    );
    expect(receipt.fingerprint).toBe(equivalent.fingerprint);
    expect(receipt.hash).not.toBe(equivalent.hash);
  });

  it("binds a recovery evidence digest to normalized source and provenance", () => {
    const evidence = createRecoveryEvidence({
      source: "worker",
      provenance: {
        producer: "test-worker",
        operationId: "diagnosis-1",
        observedAt: 10_000,
      },
      failureFingerprint: "d".repeat(64),
      failureReceiptHash: "e".repeat(64),
      summary: `credential=top-secret\nFresh diagnosis ${"detail ".repeat(100)}`,
    }, recoveryKey, 128);

    expect(evidence.summary).toContain("[REDACTED]");
    expect(Buffer.byteLength(evidence.summary)).toBeLessThanOrEqual(128);
    const { authentication: _authentication, hash: _hash, ...core } = evidence;
    expect(evidence.hash).toBe(recoveryEvidenceDigest(core));
    expect(() =>
      assertRecoveryEvidence(evidence, {
        maxSummaryBytes: 128,
        allowedSources: ["worker"],
      }, recoveryKey),
    ).not.toThrow();
    expect(() =>
      assertRecoveryEvidence(
        { ...evidence, summary: `${evidence.summary}!` },
        { maxSummaryBytes: 256, allowedSources: ["worker"] },
        recoveryKey,
      ),
    ).toThrow("authentication");
    const forgedCore = {
      ...core,
      summary: "caller-forged machine diagnosis",
    };
    expect(() =>
      assertRecoveryEvidence(
        {
          ...forgedCore,
          hash: recoveryEvidenceDigest(forgedCore),
          authentication: evidence.authentication,
        },
        { maxSummaryBytes: 256, allowedSources: ["worker"] },
        recoveryKey,
      ),
    ).toThrow("authentication");
  });

  it("deduplicates machine retries by provenance operation ID", async () => {
    const home = makeTempDir("autonomy-recovery");
    roots.push(home);
    const config = loadAutonomyConfig(path.resolve(import.meta.dirname, "../.."), {
      env: { ONE_CLI_HOME: home },
    });
    const store = new AutonomyStore(path.join(home, "state.sqlite"));
    let claim: { ref: string; sha: string } | undefined;
    let createRefCount = 0;
    let nextId = 0;
    try {
      store.putRepo({ id: config.repoKey, path: config.repoRoot, now: 10_000 });
      store.putIssue({
        id: "github-7",
        repoId: config.repoKey,
        key: "7",
        digest: "e".repeat(64),
        now: 10_000,
      });
      const failureReceipt = createFailureReceipt({
        source: "worker",
        attemptId: "attempt-1",
        operationId: "failure-operation-1",
        operation: "worker",
        issueDigest: "e".repeat(64),
        policyHash: config.policyHash,
        environmentHash: runtimeEnvironmentHash({
          platform: "test",
          architecture: "test",
          nodeVersion: "test",
        }),
        timestamp: 10_000,
      }, {
        exitCode: 1,
        signal: null,
        stdout: "",
        stderr: "test assertion failed",
        durationMs: 1,
        timedOut: false,
        cancelled: false,
        outputLimitExceeded: false,
      }, config.recoveryPolicy.receipts);
      store.beginAttempt({
        id: "attempt-1",
        issueId: "github-7",
        headSha: "a".repeat(40),
        initialState: "waiting_evidence",
        detail: {
          issueNumber: 7,
          lastFailure: {
            fingerprint: failureReceipt.fingerprint,
            operation: "worker",
            normalized: "worker failure",
            receipt: JSON.parse(JSON.stringify(failureReceipt)),
          },
          failureReceipts: [JSON.parse(JSON.stringify(failureReceipt))],
          failureEvidence: [],
          resumeState: "implementing",
        },
        now: 10_000,
      });
      const github = {
        async getRef() {
          return claim;
        },
        async createRef(_repository: unknown, ref: string, sha: string) {
          createRefCount++;
          claim = { ref, sha };
          return claim;
        },
      } as unknown as GitHubPort;
      const orchestrator = new AutonomyOrchestrator({
        config,
        store,
        github,
        git: {} as OrchestratorGitPort,
        remoteUrl: "https://example.test/repo.git",
        sandboxFactory: () => {
          throw new Error("unused");
        },
        reviewer: { review: async () => ({}) },
        provider: {
          async *stream() {
            throw new Error("unused");
          },
        },
        runConfig: {
          apiKey: "unused",
          baseUrl: "https://example.test/v1",
          model: "test",
          home,
          maxRounds: 1,
          maxToolCalls: 1,
          shellTimeoutMs: 1,
        },
        now: () => 10_000,
        id: () => `id-${++nextId}`,
      });
      const evidence = createRecoveryEvidence({
        source: "worker",
        provenance: {
          producer: "one-cli-harness",
          operationId: "diagnosis-operation-1",
          observedAt: 10_000,
        },
        failureFingerprint: failureReceipt.fingerprint,
        failureReceiptHash: failureReceipt.hash,
        summary: "A fresh machine diagnosis changed the bounded worker input.",
      }, recoveryKey);
      const first = await orchestrator.retryAttemptWithMachineEvidence(
        "attempt-1",
        evidence,
        new AbortController().signal,
        { authenticationKey: recoveryKey },
      );
      const second = await orchestrator.retryAttemptWithMachineEvidence(
        "attempt-1",
        evidence,
        new AbortController().signal,
        { authenticationKey: recoveryKey },
      );

      expect(first).toEqual(second);
      expect(first).toMatchObject({ action: "machine-retry", state: "implementing" });
      expect(createRefCount).toBe(1);
      expect(
        store.listOperations().filter((operation) => operation.kind === "autonomy.machine-retry"),
      ).toHaveLength(1);
      expect(store.getAttempt("attempt-1")?.detail).toMatchObject({
        failureEvidence: [expect.objectContaining({ hash: evidence.hash })],
      });
    } finally {
      store.close();
    }
  });

  it("probes a receipt-less legacy attempt under its existing exact roadmap binding", async () => {
    const home = makeTempDir("autonomy-recovery-bound-legacy");
    roots.push(home);
    const config = loadAutonomyConfig(path.resolve(import.meta.dirname, "../.."), {
      env: { ONE_CLI_HOME: home },
    });
    const store = new AutonomyStore(path.join(home, "state.sqlite"));
    const marker = "<!-- one-cli:cold-start-seed:01-semantic-coherence:v1 -->";
    const approvedPaths = ["src/agent.ts"];
    const pathBinding = `Trusted approved paths (exact JSON): ${JSON.stringify(approvedPaths)}`;
    try {
      store.putRepo({ id: config.repoKey, path: config.repoRoot, now: 10_000 });
      store.putIssue({
        id: "github-7",
        repoId: config.repoKey,
        key: "7",
        digest: "e".repeat(64),
        now: 10_000,
      });
      const issueLease = store.acquireLease({
        resource: "issue:github-7",
        owner: "legacy-attempt-owner",
        ttlMs: 60_000,
        now: 10_000,
      });
      store.beginAttempt({
        id: "attempt-bound-legacy",
        issueId: "github-7",
        headSha: "a".repeat(40),
        initialState: "waiting_evidence",
        detail: {
          issueNumber: 7,
          issueLease: {
            resource: issueLease.resource,
            owner: issueLease.owner,
            fence: issueLease.fence,
            expiresAt: issueLease.expiresAt,
          },
          worktreePath: config.repoRoot,
          claimRequest: { digest: "e".repeat(64) },
          issueFields: {
            sourceType: "cold-start-roadmap",
            sourceLinkOrEvidence: marker,
            scope: pathBinding,
            acceptanceCriteria: pathBinding,
          },
          roadmapScopeBinding: {
            version: 1,
            issueNumber: 7,
            issueDigest: "e".repeat(64),
            seedMarker: marker,
            executionMarker: "<!-- one-cli:trusted-execution:v1 -->",
            approvedPaths,
          },
          lastFailure: {
            operation: "gate:unit",
            normalized: "legacy attempt predates durable receipts",
          },
        },
        now: 10_000,
      });
      let sandboxRuns = 0;
      const orchestrator = new AutonomyOrchestrator({
        config,
        store,
        github: {} as GitHubPort,
        git: {} as OrchestratorGitPort,
        remoteUrl: "https://example.test/repo.git",
        sandboxFactory: () => ({
          availability: () => ({ available: true }),
          run: async () => {
            sandboxRuns++;
            return {
              exitCode: 0,
              signal: null,
              stdout: "legacy gate recovered",
              stderr: "",
              durationMs: 1,
              timedOut: false,
              cancelled: false,
              outputLimitExceeded: false,
            };
          },
        }),
        reviewer: { review: async () => ({}) },
        provider: {
          async *stream() {
            throw new Error("unused");
          },
        },
        runConfig: {
          apiKey: "unused",
          baseUrl: "https://example.test/v1",
          model: "test",
          home,
          maxRounds: 1,
          maxToolCalls: 1,
          shellTimeoutMs: 1,
        },
        executionScope: "roadmap-only",
        expectedRoadmapBinding: {
          issueNumber: 7,
          seedMarker: marker,
        },
        now: () => 10_000,
      });

      await expect(orchestrator.probeAttemptFailureGate(
        "attempt-bound-legacy",
        "bound-legacy-probe",
        new AbortController().signal,
      )).resolves.toMatchObject({
        gate: "unit",
        recovered: true,
        receipt: {
          schema: "autonomy.one-cli/failure-receipt-v1",
          provenance: { attemptId: "attempt-bound-legacy" },
        },
      });
      expect(sandboxRuns).toBe(1);
      expect(store.getAttempt("attempt-bound-legacy")?.detail).toMatchObject({
        roadmapScopeBinding: {
          version: 1,
          issueNumber: 7,
          seedMarker: marker,
        },
        failureReceipts: [expect.objectContaining({
          schema: "autonomy.one-cli/failure-receipt-v1",
        })],
      });
    } finally {
      store.close();
    }
  });

  it("rejects a truly unbound roadmap recovery before leases, reservations, or probes", async () => {
    const home = makeTempDir("autonomy-recovery-scope");
    roots.push(home);
    const config = loadAutonomyConfig(path.resolve(import.meta.dirname, "../.."), {
      env: { ONE_CLI_HOME: home },
    });
    const store = new AutonomyStore(path.join(home, "state.sqlite"));
    try {
      store.putRepo({ id: config.repoKey, path: config.repoRoot, now: 10_000 });
      store.putIssue({
        id: "github-7",
        repoId: config.repoKey,
        key: "7",
        digest: "e".repeat(64),
        now: 10_000,
      });
      store.beginAttempt({
        id: "attempt-scope",
        issueId: "github-7",
        headSha: "a".repeat(40),
        initialState: "waiting_evidence",
        detail: {
          issueNumber: 7,
          lastFailure: { operation: "gate:test" },
        },
        now: 10_000,
      });
      let sandboxRuns = 0;
      const orchestrator = new AutonomyOrchestrator({
        config,
        store,
        github: {} as GitHubPort,
        git: {} as OrchestratorGitPort,
        remoteUrl: "https://example.test/repo.git",
        sandboxFactory: () => ({
          availability: () => ({ available: true }),
          run: async () => {
            sandboxRuns++;
            throw new Error("must not run");
          },
        }),
        reviewer: { review: async () => ({}) },
        provider: {
          async *stream() {
            throw new Error("unused");
          },
        },
        runConfig: {
          apiKey: "unused",
          baseUrl: "https://example.test/v1",
          model: "test",
          home,
          maxRounds: 1,
          maxToolCalls: 1,
          shellTimeoutMs: 1,
        },
        executionScope: "roadmap-only",
        expectedRoadmapBinding: {
          issueNumber: 7,
          seedMarker: "<!-- one-cli:cold-start-seed:01-semantic-coherence:v1 -->",
        },
      });
      const evidence = createRecoveryEvidence({
        source: "local-process",
        provenance: {
          producer: "one-cli-harness",
          operationId: "scope-retry",
          observedAt: 10_000,
        },
        failureFingerprint: "f".repeat(64),
        failureReceiptHash: "a".repeat(64),
        summary: "forged scope",
      }, recoveryKey);
      await expect(orchestrator.probeAttemptFailureGate(
        "attempt-scope",
        "scope-probe",
        new AbortController().signal,
      )).rejects.toThrow("scope binding");
      await expect(orchestrator.retryAttemptWithMachineEvidence(
        "attempt-scope",
        evidence,
        new AbortController().signal,
        { authenticationKey: recoveryKey },
      )).rejects.toThrow("scope binding");
      expect(store.listOperations()).toHaveLength(0);
      expect(sandboxRuns).toBe(0);
    } finally {
      store.close();
    }
  });

  it("fails machine CLI recovery closed when the host key is absent", async () => {
    const home = makeTempDir("autonomy-recovery-missing-key");
    roots.push(home);
    vi.stubEnv("ONE_CLI_HOME", home);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await expect(dispatchAutonomyCli([
      "recover",
      "probe",
      "attempt-1",
      "--operation-id",
      "probe-1",
      "--workspace",
      path.resolve(import.meta.dirname, "../.."),
      "--mode",
      "auto-merge",
    ])).resolves.toBe(2);
    expect(stderr.mock.calls.map(([value]) => String(value)).join(""))
      .toContain("Host recovery key is missing");
  });

  it("rejects unknown or relaxed recovery policy fields", () => {
    const valid = {
      schema: "autonomy.one-cli/recovery-policy-v1",
      receipts: {
        maxStdoutBytes: 8_192,
        maxStderrBytes: 8_192,
        maxSpawnErrorBytes: 1_024,
        maxReceiptsPerAttempt: 20,
        redaction: "strict",
      },
      machineEvidence: {
        maxSummaryBytes: 4_096,
        allowedSources: [
          "local-process",
          "worker",
          "github-check",
          "reconciler",
        ],
        requireOperationId: true,
        requireFailureFingerprint: true,
        deduplicateByHash: true,
      },
      manualBreakGlass: {
        maxEvidenceBytes: 4_096,
        requireNovelEvidence: true,
      },
    };

    expect(parseRecoveryPolicy(valid)).toEqual(valid);
    expect(() => parseRecoveryPolicy({ ...valid, unexpected: true })).toThrow();
    expect(() =>
      parseRecoveryPolicy({
        ...valid,
        receipts: { ...valid.receipts, redaction: "best-effort" },
      }),
    ).toThrow();
    expect(() =>
      parseRecoveryPolicy({
        ...valid,
        machineEvidence: {
          ...valid.machineEvidence,
          allowedSources: ["worker"],
        },
      }),
    ).toThrow();
  });
});
