import { describe, expect, it } from "vitest";
import {
  OneCliClient,
  type RecoveryEvidence,
} from "../../harness/src/one-cli.js";
import type {
  ProcessRequest,
  ProcessResult,
  ProcessRunner,
} from "../../harness/src/runner.js";

describe("harness recovery CLI boundary", () => {
  it("binds roadmap recovery, canonical evidence stdin, target, diagnosis, and operation ID", async () => {
    const requests: ProcessRequest[] = [];
    const evidence: RecoveryEvidence = {
      schema: "autonomy.one-cli/recovery-evidence-v1",
      source: "local-process",
      provenance: {
        producer: "one-cli-harness",
        operationId: "harness:retry:abc",
        observedAt: 123,
      },
      failureFingerprint: "a".repeat(64),
      failureReceiptHash: "b".repeat(64),
      summary: "category=code/gate;decision=retry-implement",
      hash: "c".repeat(64),
      authentication: {
        algorithm: "hmac-sha256",
        keyId: "d".repeat(64),
        mac: "e".repeat(64),
      },
    };
    const runner: ProcessRunner = {
      run: async (request) => {
        requests.push(request);
        return result({
          action: "machine-retry",
          state: "implementing",
          attemptId: "attempt-7",
        });
      },
    };
    const client = new OneCliClient(
      runner,
      "/workspace",
      "/release/dist/index.js",
      { ONE_CLI_HOME: "/one-cli-home" },
    );
    await expect(client.machineRetry(
      "attempt-7",
      evidence,
      "roadmap-only",
      {
        issueNumber: 7,
        seedMarker: "<!-- one-cli:cold-start-seed:07-extension-health:v1 -->",
      },
    )).resolves.toMatchObject({
      action: "machine-retry",
      state: "implementing",
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.stdin).toBe(JSON.stringify(evidence));
    expect(requests[0]?.args).toEqual(expect.arrayContaining([
      "recover",
      "retry",
      "attempt-7",
      "--machine-evidence",
      "-",
      "--operation-id",
      evidence.provenance.operationId,
      "--expected-roadmap-issue",
      "7",
      "--expected-roadmap-marker",
      "<!-- one-cli:cold-start-seed:07-extension-health:v1 -->",
    ]));
  });

  it("accepts only the structured gate-probe receipt contract", async () => {
    const runner: ProcessRunner = {
      run: async () => result({
        schema: "autonomy.one-cli/failure-gate-probe-v1",
        attemptId: "attempt-7",
        gate: "install",
        recovered: true,
        receipt: {
          schema: "autonomy.one-cli/failure-receipt-v1",
          source: "local-process",
          operation: "gate:install",
          gate: "install",
          exitCode: 0,
          signal: null,
          stdout: "ok",
          stderr: "",
          spawnError: null,
          timedOut: false,
          cancelled: false,
          outputLimitExceeded: false,
          timestamp: 123,
          fingerprint: "a".repeat(64),
          hash: "b".repeat(64),
        },
      }),
    };
    const client = new OneCliClient(
      runner,
      "/workspace",
      "/release/dist/index.js",
      {},
    );
    await expect(client.probeFailureGate(
      "attempt-7",
      "probe-operation",
      "normal",
    )).resolves.toMatchObject({
      gate: "install",
      recovered: true,
      receipt: { operation: "gate:install" },
    });
  });
});

function result(value: unknown): ProcessResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: JSON.stringify(value),
    stderr: "",
    durationMs: 1,
    timedOut: false,
    cancelled: false,
    outputLimitExceeded: false,
  };
}
