import crypto from "node:crypto";

import type {
  DiagnosisProvenance,
  DiagnosisReceipt,
  DiagnosisReceiptSource,
  FailureClass,
} from "./domain.js";
import { redactAndBound } from "./process.js";

/**
 * Phase 1 of the PR self-heal loop: a deterministic, zero-LLM classifier that
 * attributes a CI/gate failure to a {@link FailureClass}. It is a *bypass
 * observation* — it never drives state transitions, never mutates business
 * code, and never triggers a repair. It only turns an opaque failure log into a
 * structured, content-addressed {@link DiagnosisReceipt} so humans (and later
 * self-heal phases) can act with a head start.
 *
 * Design mirrors the codex-security discipline the wider system already follows:
 * cheap deterministic rules run first; only a later phase (unknown / low
 * confidence) may escalate to a model. Phase 1 ships the rules only.
 */

export interface DiagnosisInput {
  /** Raw (already redaction-safe or not) CI/gate failure log text. */
  readonly log: string;
  /** Gate name that failed, when known (e.g. "unit", "build", "select-trusted-issue"). */
  readonly gate: string | null;
  /** Fingerprint of the FailureReceipt this diagnosis explains. */
  readonly failureFingerprint: string;
}

export interface ClassificationResult {
  readonly failureClass: FailureClass;
  readonly confidence: number;
  readonly rootCauseHypothesis: string;
  /** The specific lines that matched, joined — used as the bounded log excerpt. */
  readonly matchedExcerpt: string;
  readonly affectedFiles: readonly string[];
}

export interface CreateDiagnosisReceiptContext {
  readonly source: DiagnosisReceiptSource;
  readonly attemptId: string;
  readonly operationId: string;
  readonly gate: string | null;
  readonly failureFingerprint: string;
  readonly timestamp: number;
}

export interface DiagnosisReceiptLimits {
  readonly maxLogExcerptBytes: number;
  readonly maxAffectedFiles: number;
}

export const DEFAULT_DIAGNOSIS_LIMITS: DiagnosisReceiptLimits = {
  maxLogExcerptBytes: 4_096,
  maxAffectedFiles: 25,
};

/**
 * Ordered rule table. First rule whose pattern matches the log wins, so the
 * order encodes precedence: unambiguous data/credential failures are checked
 * before the noisier, more general gate categories (build/test), and the
 * generic transient net is checked late so it never masks a concrete cause.
 */
interface ClassificationRule {
  readonly failureClass: FailureClass;
  readonly pattern: RegExp;
  readonly confidence: number;
  readonly hypothesis: string;
}

const RULES: readonly ClassificationRule[] = [
  {
    // Real case: select-trusted-issue "Roadmap marker must identify an issue: <marker>".
    failureClass: "roadmap-marker",
    pattern: /roadmap marker (?:must identify an issue|is duplicated|not found|has no|cannot)|no issue (?:found )?for (?:roadmap )?marker|dangling roadmap marker|marker .* (?:has no|without) (?:an? )?issue/iu,
    confidence: 0.95,
    hypothesis:
      "A roadmap marker does not resolve to a GitHub issue (data gap, not a code defect). Safety boundary: not auto-fixable — add the missing issue or correct the roadmap marker by hand.",
  },
  {
    // Real case: CODEBUDDY_API_KEY / "Set repository secret/variable ... before enabling".
    failureClass: "credential",
    pattern: /set repository (?:secret|variable)[^.\n]*before enabling|\b[A-Z][A-Z0-9]*_(?:API_KEY|TOKEN|SECRET|KEY)\b|missing (?:required )?(?:secret|credential|api key)|secret .* is not set|environment variable .* (?:is )?(?:not set|required|missing)|CODEBUDDY_API_KEY/u,
    confidence: 0.9,
    hypothesis:
      "A required secret / credential / configuration variable is missing or unset. Safety boundary: machines must never guess credentials — route to a human to provision the secret.",
  },
  {
    failureClass: "dependency",
    pattern: /\bnpm err|ELOCKVERIFY|lockfile|npm ci can only install|ERESOLVE|peer dep|could not resolve dependency|yarn install|pnpm .*ERR_PNPM|package-lock\.json|integrity check(?:sum)? failed|npm warn using --force/iu,
    confidence: 0.85,
    hypothesis:
      "Dependency installation or lockfile resolution failed (lockfile drift, integrity, or unresolved peer). Candidate fix: reinstall / regenerate the lockfile.",
  },
  {
    failureClass: "typecheck",
    pattern: /\berror TS\d+\b|tsc(?:\s|:).*error|type ?check(?:ing)? failed|is not assignable to type|has no exported member|Cannot find name/u,
    confidence: 0.9,
    hypothesis:
      "TypeScript type checking reported one or more errors (error TS####). Candidate fix: correct the types or missing exports.",
  },
  {
    failureClass: "lint",
    pattern: /\b(?:eslint|oxlint|biome|prettier)\b|lint(?:ing)? (?:failed|error)|\d+ problems? \(\d+ errors?|✖ \d+ problems/iu,
    confidence: 0.85,
    hypothesis:
      "A linter/formatter reported violations. Candidate fix: run the auto-fixer or correct the flagged rules.",
  },
  {
    failureClass: "e2e",
    pattern: /\b(?:playwright|cypress|puppeteer|e2e|end-to-end)\b|browser (?:test|context)|page\.(?:goto|click)|selector .* (?:not found|timed out)/iu,
    confidence: 0.75,
    hypothesis:
      "An end-to-end / browser test failed. Candidate fix: inspect the failing scenario; may be a real UI regression or an environment issue.",
  },
  {
    failureClass: "unit-test",
    pattern: /\bvitest\b|\bjest\b|\bmocha\b|(?:tests?|test files?) failed|\d+ failed(?:,| \()|✖ .*test|AssertionError|expect\(.*\)(?:\.[a-zA-Z]+)+|FAIL /iu,
    confidence: 0.8,
    hypothesis:
      "A unit test suite reported failing assertions. Candidate fix: address the failing expectations or the code under test.",
  },
  {
    failureClass: "build",
    pattern: /\bbuild failed\b|failed to (?:build|compile|bundle)|compilation (?:error|failed)|\b(?:webpack|vite|rollup|esbuild|tsc -p)\b.*(?:error|failed)|module not found|cannot find module/iu,
    confidence: 0.75,
    hypothesis:
      "The build/compile/bundle step failed. Candidate fix: resolve the missing module or compilation error.",
  },
  {
    failureClass: "flaky-transient",
    pattern: /\b(?:econnreset|econnrefused|enetunreach|eai_again|etimedout)\b|socket hang up|network (?:error|timeout|unreachable)|(?:connection|request) timed? ?out|rate limit|too many requests|http 429|http 5\d\d|service unavailable|temporar(?:y|ily)/iu,
    confidence: 0.6,
    hypothesis:
      "A transient/infrastructure error (network, timeout, rate limit, 5xx). Safety boundary: do not chase with code changes — a plain re-run is the correct response.",
  },
];

const AFFECTED_FILE_PATTERN =
  /(?:^|[\s(“"'`])((?:[\w.@-]+\/)*[\w.@-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|yml|yaml|mts|cts|md|lock))(?::\d+(?::\d+)?)?/gu;

/**
 * Deterministically classify a failure log into a {@link FailureClass}.
 * Total function: always returns a result, defaulting to `unknown` with low
 * confidence when no rule matches.
 */
export function classifyFailure(input: DiagnosisInput): ClassificationResult {
  const log = input.log ?? "";
  const gate = input.gate ?? "";
  // Gate name is a strong prior for otherwise-ambiguous logs, so fold it into
  // the text the rules see (without letting it override an explicit log signal
  // for the concrete data/credential classes, which are matched on log body).
  const haystack = `${gate}\n${log}`;

  for (const rule of RULES) {
    const match = rule.pattern.exec(haystack);
    if (match) {
      const excerpt = collectMatchingLines(log, rule.pattern, gate);
      return {
        failureClass: rule.failureClass,
        confidence: rule.confidence,
        rootCauseHypothesis: rule.hypothesis,
        matchedExcerpt: excerpt || match[0],
        affectedFiles: extractAffectedFiles(log),
      };
    }
  }

  return {
    failureClass: "unknown",
    confidence: 0.1,
    rootCauseHypothesis:
      "No deterministic rule matched the failure log. Manual triage required; a later self-heal phase may escalate this to model-assisted diagnosis.",
    matchedExcerpt: firstNonEmptyLines(log, 5),
    affectedFiles: extractAffectedFiles(log),
  };
}

/** Build a full, content-addressed {@link DiagnosisReceipt} from a classification. */
export function createDiagnosisReceipt(
  context: CreateDiagnosisReceiptContext,
  classification: ClassificationResult,
  limits: DiagnosisReceiptLimits = DEFAULT_DIAGNOSIS_LIMITS,
): DiagnosisReceipt {
  if (!context.attemptId.trim() || !context.operationId.trim()) {
    throw new Error("Diagnosis receipt requires attemptId and operationId");
  }
  const provenance: DiagnosisProvenance = {
    producer: "one-cli",
    attemptId: context.attemptId,
    operationId: context.operationId,
  };
  const logExcerpt = redactAndBound(classification.matchedExcerpt, limits.maxLogExcerptBytes);
  const affectedFiles = classification.affectedFiles
    .slice(0, limits.maxAffectedFiles)
    .map((file) => redactAndBound(file, 512));
  const confidence = clampConfidence(classification.confidence);
  const withoutHashes = {
    schema: "autonomy.one-cli/diagnosis-receipt-v1" as const,
    source: context.source,
    provenance,
    failureClass: classification.failureClass,
    gate: context.gate ?? null,
    affectedFiles,
    rootCauseHypothesis: redactAndBound(classification.rootCauseHypothesis, 2_048),
    confidence,
    logExcerpt,
    failureFingerprint: context.failureFingerprint,
    timestamp: boundedNonNegativeInteger(context.timestamp),
  };
  const fingerprint = diagnosisFingerprint(withoutHashes);
  return {
    ...withoutHashes,
    fingerprint,
    hash: sha256(stableJson({ ...withoutHashes, fingerprint })),
  };
}

/**
 * Content-addressed fingerprint excluding timing/provenance so equivalent
 * diagnoses (same class + gate + cause + failure) dedupe across attempts.
 */
export function diagnosisFingerprint(
  receipt: Omit<DiagnosisReceipt, "fingerprint" | "hash">,
): string {
  return sha256(
    stableJson({
      failureClass: receipt.failureClass,
      gate: receipt.gate,
      rootCauseHypothesis: receipt.rootCauseHypothesis,
      affectedFiles: [...receipt.affectedFiles].sort((a, b) => a.localeCompare(b)),
      failureFingerprint: receipt.failureFingerprint,
    }),
  );
}

/** Render a diagnosis as a human-readable, marker-tagged PR comment body. */
export function renderDiagnosisComment(receipt: DiagnosisReceipt, marker: string): string {
  const files =
    receipt.affectedFiles.length > 0
      ? receipt.affectedFiles.map((file) => `- \`${file}\``).join("\n")
      : "_none identified_";
  const excerpt = receipt.logExcerpt.trim() || "_no excerpt captured_";
  const advice = ADVICE[receipt.failureClass];
  const confidencePct = Math.round(receipt.confidence * 100);
  return [
    marker,
    "### 🔎 CI failure diagnosis (automated, Phase 1 — analysis only)",
    "",
    `- **Failure class:** \`${receipt.failureClass}\` (confidence ${confidencePct}%)`,
    `- **Gate:** ${receipt.gate ? `\`${receipt.gate}\`` : "_unknown_"}`,
    `- **Root-cause hypothesis:** ${receipt.rootCauseHypothesis}`,
    `- **Suggested action:** ${advice}`,
    "",
    "**Affected files (best-effort):**",
    files,
    "",
    "<details><summary>Log excerpt</summary>",
    "",
    "```",
    excerpt,
    "```",
    "",
    "</details>",
    "",
    `<sub>Diagnosis fingerprint: \`${receipt.fingerprint.slice(0, 16)}\` · failure fingerprint: \`${receipt.failureFingerprint.slice(0, 16)}\`. This is a bypass observation — no code was changed and no repair was attempted.</sub>`,
  ].join("\n");
}

const ADVICE: Readonly<Record<FailureClass, string>> = {
  dependency: "Regenerate/reinstall the lockfile and re-run; check for peer/integrity drift.",
  typecheck: "Fix the reported TS errors (types / missing exports), then re-run typecheck.",
  lint: "Run the linter's auto-fix or correct the flagged rules.",
  "unit-test": "Address the failing assertions or the code under test.",
  e2e: "Inspect the failing scenario — could be a real UI regression or an env issue.",
  build: "Resolve the missing module / compilation error and rebuild.",
  credential:
    "**Human action required** — provision the missing secret/variable. Machines must not guess credentials.",
  "roadmap-marker":
    "**Human action required** — add the missing issue or correct the roadmap marker; not auto-fixable.",
  "flaky-transient": "Likely transient — re-run the failed job before making any code change.",
  unknown: "Manual triage required; no deterministic rule matched.",
};

function collectMatchingLines(log: string, pattern: RegExp, gate: string): string {
  const lines = log.split(/\r?\n/u);
  const perLine = new RegExp(pattern.source, pattern.flags.replace(/g/gu, ""));
  const matched = lines.filter((line) => perLine.test(line)).slice(0, 12);
  if (matched.length > 0) return matched.join("\n");
  // Fall back to gate-only signal when the match came from the gate name.
  return perLine.test(gate) ? `gate: ${gate}` : firstNonEmptyLines(log, 5);
}

function extractAffectedFiles(log: string): readonly string[] {
  const found = new Set<string>();
  const pattern = new RegExp(AFFECTED_FILE_PATTERN.source, AFFECTED_FILE_PATTERN.flags);
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(log)) !== null) {
    const file = match[1];
    if (file && !file.startsWith("node_modules/")) found.add(file);
  }
  return [...found];
}

function firstNonEmptyLines(log: string, count: number): string {
  return log
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, count)
    .join("\n");
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function boundedNonNegativeInteger(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.trunc(value);
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return `{${entries
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
