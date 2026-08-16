import { describe, expect, it } from "vitest";

import { FAILURE_CLASSES } from "../../src/autonomy/domain.js";
import {
  classifyFailure,
  createDiagnosisReceipt,
  diagnosisFingerprint,
  renderDiagnosisComment,
  type ClassificationResult,
} from "../../src/autonomy/diagnosis.js";

function classify(log: string, gate: string | null = null): ClassificationResult {
  return classifyFailure({ log, gate, failureFingerprint: "f".repeat(64) });
}

describe("deterministic failure classifier", () => {
  it("classifies the real roadmap-marker failure (select-trusted-issue)", () => {
    const result = classify(
      "Error: Roadmap marker must identify an issue: 03-context-compaction:v1\n    at selectTrustedIssue (scripts/github-autonomy.mjs:48:11)",
      "select-trusted-issue",
    );
    expect(result.failureClass).toBe("roadmap-marker");
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
    expect(result.matchedExcerpt).toMatch(/Roadmap marker must identify an issue/u);
  });

  it("classifies the real credential failure (CODEBUDDY_API_KEY / repository secret)", () => {
    const result = classify(
      "Set repository secret CODEBUDDY_API_KEY before enabling the autonomy workflow.",
      "select-trusted-issue",
    );
    expect(result.failureClass).toBe("credential");
    expect(result.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it("classifies a bare secret-name credential failure", () => {
    const result = classify("Error: OPENAI_API_KEY is not set in the environment");
    expect(result.failureClass).toBe("credential");
  });

  it("classifies dependency / lockfile failures", () => {
    expect(classify("npm ERR! ELOCKVERIFY Errors were found in your package-lock.json").failureClass).toBe(
      "dependency",
    );
    expect(classify("npm ERR! code ERESOLVE\nnpm ERR! could not resolve dependency").failureClass).toBe(
      "dependency",
    );
  });

  it("classifies typecheck failures", () => {
    const result = classify(
      "src/autonomy/orchestrator.ts(2450,9): error TS2322: Type 'string' is not assignable to type 'number'.",
      "typecheck",
    );
    expect(result.failureClass).toBe("typecheck");
    expect(result.affectedFiles).toContain("src/autonomy/orchestrator.ts");
  });

  it("classifies lint failures", () => {
    expect(classify("oxlint found 3 problems (3 errors, 0 warnings)", "lint").failureClass).toBe("lint");
    expect(classify("eslint: 12 problems (12 errors, 0 warnings)").failureClass).toBe("lint");
  });

  it("classifies unit-test failures", () => {
    const result = classify(
      "FAIL tests/unit/foo.test.ts\n  × sums numbers\n  2 failed, 40 passed\nAssertionError: expected 3 to be 4",
      "unit",
    );
    expect(result.failureClass).toBe("unit-test");
  });

  it("classifies e2e failures ahead of generic build/test", () => {
    const result = classify("playwright test failed: selector '.btn' timed out after 30000ms");
    expect(result.failureClass).toBe("e2e");
  });

  it("classifies build failures", () => {
    expect(classify("vite build failed: Cannot find module './missing'", "build").failureClass).toBe(
      "build",
    );
  });

  it("classifies flaky/transient failures", () => {
    expect(classify("Error: connect ECONNRESET 140.82.113.3:443").failureClass).toBe("flaky-transient");
    expect(classify("Request failed: HTTP 503 service unavailable").failureClass).toBe("flaky-transient");
  });

  it("falls back to unknown with low confidence when nothing matches", () => {
    const result = classify("some entirely unrelated message with no known signal");
    expect(result.failureClass).toBe("unknown");
    expect(result.confidence).toBeLessThan(0.5);
  });

  it("prioritizes roadmap-marker/credential over generic categories", () => {
    // A log mentioning both a test failure and a roadmap marker resolves to the
    // higher-precedence data-gap class.
    const result = classify(
      "Roadmap marker must identify an issue: x\n2 failed, 1 passed\nerror TS2322",
    );
    expect(result.failureClass).toBe("roadmap-marker");
  });

  it("only emits classes from the closed FailureClass taxonomy", () => {
    const samples = [
      "npm ERR! lockfile",
      "error TS2322",
      "eslint problems",
      "vitest 1 failed",
      "playwright timed out",
      "vite build failed",
      "OPENAI_API_KEY is not set",
      "Roadmap marker must identify an issue",
      "ECONNRESET",
      "nothing matches here",
    ];
    for (const sample of samples) {
      expect(FAILURE_CLASSES).toContain(classify(sample).failureClass);
    }
  });
});

describe("diagnosis receipt", () => {
  const baseContext = {
    source: "github-check" as const,
    attemptId: "attempt-1",
    operationId: "diagnosis:attempt-1:abc",
    gate: "select-trusted-issue" as string | null,
    failureFingerprint: "a".repeat(64),
    timestamp: 1_700_000_000_000,
  };

  it("produces a content-addressed, bounded receipt", () => {
    const classification = classify(
      "Roadmap marker must identify an issue: 03-context-compaction:v1",
      "select-trusted-issue",
    );
    const receipt = createDiagnosisReceipt(baseContext, classification);
    expect(receipt.schema).toBe("autonomy.one-cli/diagnosis-receipt-v1");
    expect(receipt.failureClass).toBe("roadmap-marker");
    expect(receipt.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(receipt.hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(receipt.confidence).toBeGreaterThan(0);
    expect(receipt.confidence).toBeLessThanOrEqual(1);
    expect(receipt.provenance.producer).toBe("one-cli");
    expect(receipt.failureFingerprint).toBe(baseContext.failureFingerprint);
  });

  it("is deterministic: same input yields same fingerprint and hash", () => {
    const classification = classify("error TS2322: bad", "typecheck");
    const a = createDiagnosisReceipt(baseContext, classification);
    const b = createDiagnosisReceipt(baseContext, classification);
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.hash).toBe(b.hash);
  });

  it("fingerprint excludes timing so equivalent diagnoses dedupe", () => {
    const classification = classify("error TS2322: bad", "typecheck");
    const a = createDiagnosisReceipt(baseContext, classification);
    const b = createDiagnosisReceipt({ ...baseContext, timestamp: baseContext.timestamp + 999 }, classification);
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  it("clamps confidence and bounds affected files", () => {
    const receipt = createDiagnosisReceipt(
      baseContext,
      {
        failureClass: "unknown",
        confidence: 5,
        rootCauseHypothesis: "x",
        matchedExcerpt: "y",
        affectedFiles: Array.from({ length: 100 }, (_, i) => `src/file-${i}.ts`),
      },
      { maxLogExcerptBytes: 256, maxAffectedFiles: 10 },
    );
    expect(receipt.confidence).toBe(1);
    expect(receipt.affectedFiles.length).toBe(10);
  });

  it("recomputes fingerprint via diagnosisFingerprint helper", () => {
    const classification = classify("npm ERR! lockfile", "install");
    const receipt = createDiagnosisReceipt(baseContext, classification);
    const { fingerprint: _f, hash: _h, ...rest } = receipt;
    expect(diagnosisFingerprint(rest)).toBe(receipt.fingerprint);
  });

  it("rejects blank provenance", () => {
    const classification = classify("error TS2322", "typecheck");
    expect(() => createDiagnosisReceipt({ ...baseContext, attemptId: "  " }, classification)).toThrow();
  });

  it("renders a marker-tagged PR comment with class, cause and files", () => {
    const classification = classify(
      "src/foo.ts(1,1): error TS2322: nope",
      "typecheck",
    );
    const receipt = createDiagnosisReceipt(baseContext, classification);
    const marker = `<!-- one-cli:diagnosis:${receipt.provenance.attemptId}:${receipt.fingerprint} -->`;
    const body = renderDiagnosisComment(receipt, marker);
    expect(body.startsWith(marker)).toBe(true);
    expect(body).toMatch(/Failure class:.*typecheck/u);
    expect(body).toMatch(/Suggested action/u);
    expect(body).toContain("src/foo.ts");
    expect(body).toMatch(/bypass observation/u);
  });
});
