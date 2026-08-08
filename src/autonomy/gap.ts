import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { GapPolicy } from "./config.js";
import type { GapCategory, GapConfidence } from "./domain.js";
import {
  COMMUNITY_CAPABILITY_TOPICS,
  COMMUNITY_SOURCE_IDS,
  sanitizeUntrustedText,
  type CommunityRegistry,
} from "./intake.js";

export const GAP_CATEGORIES = COMMUNITY_CAPABILITY_TOPICS;
export const GAP_CONFIDENCES = ["speculative", "likely", "confirmed"] as const;
export const GAP_SUBCODES = [
  "monitoring.activity",
  "monitoring.delivery",
  "agent.interactive",
  "agent.tools",
  "sessions.resume",
  "context.compaction",
  "extensions.protocol",
  "parallel.agents",
  "providers.routing",
  "cost.budgets",
  "safety.permissions",
  "platform.compatibility",
  "testing.automation",
  "docs.guidance",
] as const;
export const NORMALIZED_GAP_FIELDS = [
  "sourceType",
  "sourceLinkOrEvidence",
  "problemStatement",
  "userValue",
  "scope",
  "nonGoals",
  "acceptanceCriteria",
  "testPlan",
  "dogfoodPlan",
  "riskAndSecurityNotes",
  "duplicateSearchEvidence",
  "parentChildRelationship",
  "dependencyOrder",
] as const;

export type GapSubcode = (typeof GAP_SUBCODES)[number];
export type NormalizedGapField = (typeof NORMALIZED_GAP_FIELDS)[number];

const TopicSchema = z.enum([
  "active-project-state",
  "delivery-status",
  "interactive-loop",
  "tool-use",
  "session-resume",
  "context-compaction",
  "extension-protocols",
  "parallel-agents",
  "provider-routing",
  "cost-budgets",
  "permission-safety",
  "platform-compatibility",
  "test-automation",
  "documentation-guidance",
]);
export type GapTopic = z.infer<typeof TopicSchema>;

export const GapClassificationSchema = z
  .object({
    category: z.enum(GAP_CATEGORIES),
    topic: TopicSchema,
    subcode: z.enum(GAP_SUBCODES),
  })
  .strict()
  .superRefine((value, context) => {
    const expected = TAXONOMY[value.subcode];
    if (value.category !== expected.category || value.topic !== expected.topic) {
      context.addIssue({
        code: "custom",
        message: `Subcode ${value.subcode} is not valid for ${value.category}/${value.topic}`,
      });
    }
  });

export const GapObservationSchema = z
  .object({
    sourceId: z.enum(COMMUNITY_SOURCE_IDS),
    sourceUrl: z.url(),
    kind: z.enum(["repository", "release", "discussion", "documentation"]),
    externalId: z.string().min(1).max(512),
    sha: z.string().min(1).max(128).optional(),
    title: z.string().min(1).max(1_000),
    body: z.string().min(1).max(32_768),
    observedAt: z.number().int().nonnegative(),
    incremental: z.boolean(),
  })
  .strict();
export type GapObservation = z.infer<typeof GapObservationSchema>;

export const LocalCapabilityEvidenceSchema = z
  .object({
    detectorId: z.enum(GAP_SUBCODES),
    status: z.enum(["absent", "partial", "present", "unknown"]),
    checkedPaths: z.array(z.string().min(1)).min(1).max(8),
    matchedPaths: z.array(z.string().min(1)).max(8),
    absentPaths: z.array(z.string().min(1)).max(8),
    summary: z.string().min(1).max(2_000),
  })
  .strict();
export type LocalCapabilityEvidence = z.infer<typeof LocalCapabilityEvidenceSchema>;

export const GapCandidateSchema = z
  .object({
    observation: GapObservationSchema,
    classification: GapClassificationSchema,
    externalEvidence: z.string().min(1).max(4_096),
    localEvidence: LocalCapabilityEvidenceSchema,
    confidence: z.enum(GAP_CONFIDENCES),
    score: z.number().int().min(0).max(100),
    testable: z.boolean(),
    dependencyStatus: z.enum(["ready", "blocked"]),
    proposedPaths: z.array(z.string().min(1).max(512)).min(1).max(128),
    expiresAt: z.number().int().nonnegative(),
  })
  .strict();
export type GapCandidate = z.infer<typeof GapCandidateSchema>;

interface TaxonomyEntry {
  category: GapCategory;
  topic: GapTopic;
  keywords: readonly string[];
  localPaths: readonly string[];
  localPattern: RegExp;
  proposedPaths: readonly string[];
  testable: true;
  dependencyStatus: "ready";
}

const TAXONOMY: Readonly<Record<GapSubcode, TaxonomyEntry>> = {
  "monitoring.activity": {
    category: "project-monitoring",
    topic: "active-project-state",
    keywords: ["monitor", "activity", "active task", "dashboard", "status"],
    localPaths: ["src/autonomy/schedule.ts", "src/autonomy/orchestrator.ts", "src/reporter.ts"],
    localPattern: /schedule|status|event|active/iu,
    proposedPaths: ["src/reporter.ts", "tests/unit/reporter.test.ts"],
    testable: true,
    dependencyStatus: "ready",
  },
  "monitoring.delivery": {
    category: "project-monitoring",
    topic: "delivery-status",
    keywords: ["delivery", "pull request", "ci status", "merge", "progress"],
    localPaths: ["src/autonomy/release.ts", "src/autonomy/github.ts"],
    localPattern: /delivery|pull request|merge|check/iu,
    proposedPaths: ["src/autonomy/release.ts", "tests/unit/autonomy-release.test.ts"],
    testable: true,
    dependencyStatus: "ready",
  },
  "agent.interactive": {
    category: "interactive-coding-agent",
    topic: "interactive-loop",
    keywords: ["interactive", "terminal ui", "tui", "prompt", "chat"],
    localPaths: ["src/cli.ts", "src/agent.ts", "src/reporter.ts"],
    localPattern: /interactive|prompt|stream|report/iu,
    proposedPaths: ["src/cli.ts", "tests/unit/cli.test.ts"],
    testable: true,
    dependencyStatus: "ready",
  },
  "agent.tools": {
    category: "interactive-coding-agent",
    topic: "tool-use",
    keywords: ["tool call", "edit file", "shell command", "coding agent", "agent tool"],
    localPaths: ["src/tools.ts", "src/agent.ts", "src/policy.ts"],
    localPattern: /tool|edit|shell|command/iu,
    proposedPaths: ["src/tools.ts", "tests/unit/tools.test.ts"],
    testable: true,
    dependencyStatus: "ready",
  },
  "sessions.resume": {
    category: "long-sessions-context",
    topic: "session-resume",
    keywords: ["resume", "long session", "checkpoint", "transcript", "session"],
    localPaths: ["src/session.ts", "src/cli.ts"],
    localPattern: /resume|session|checkpoint|transcript/iu,
    proposedPaths: ["src/session.ts", "tests/unit/session.test.ts"],
    testable: true,
    dependencyStatus: "ready",
  },
  "context.compaction": {
    category: "long-sessions-context",
    topic: "context-compaction",
    keywords: ["context window", "compact", "compaction", "summarize history", "token limit"],
    localPaths: ["src/session.ts", "src/agent.ts", "src/domain.ts"],
    localPattern: /context|token|message|history/iu,
    proposedPaths: ["src/session.ts", "tests/unit/session.test.ts"],
    testable: true,
    dependencyStatus: "ready",
  },
  "extensions.protocol": {
    category: "extensions-parallelism",
    topic: "extension-protocols",
    keywords: ["extension", "plugin", "mcp", "hook", "protocol"],
    localPaths: ["src/tools.ts", "src/config.ts"],
    localPattern: /tool|config|provider/iu,
    proposedPaths: ["src/tools.ts", "tests/unit/tools.test.ts"],
    testable: true,
    dependencyStatus: "ready",
  },
  "parallel.agents": {
    category: "extensions-parallelism",
    topic: "parallel-agents",
    keywords: ["parallel", "subagent", "multi-agent", "worktree", "concurrent"],
    localPaths: ["src/autonomy/worker.ts", "src/autonomy/lease.ts", "src/agent.ts"],
    localPattern: /worker|lease|agent|concurrent/iu,
    proposedPaths: ["src/autonomy/worker.ts", "tests/unit/autonomy-orchestrator.test.ts"],
    testable: true,
    dependencyStatus: "ready",
  },
  "providers.routing": {
    category: "provider-cost-governance",
    topic: "provider-routing",
    keywords: ["provider", "model routing", "openai compatible", "model selection", "fallback"],
    localPaths: ["src/provider.ts", "src/config.ts", "src/cli.ts"],
    localPattern: /provider|model|openai/iu,
    proposedPaths: ["src/provider.ts", "tests/unit/provider.test.ts"],
    testable: true,
    dependencyStatus: "ready",
  },
  "cost.budgets": {
    category: "provider-cost-governance",
    topic: "cost-budgets",
    keywords: ["cost", "budget", "usage", "token spend", "rate limit"],
    localPaths: ["src/agent.ts", "src/domain.ts", "src/cli.ts"],
    localPattern: /budget|usage|token|limit/iu,
    proposedPaths: ["src/agent.ts", "tests/unit/agent.test.ts"],
    testable: true,
    dependencyStatus: "ready",
  },
  "safety.permissions": {
    category: "safety-platform-testing-docs",
    topic: "permission-safety",
    keywords: ["permission", "approval", "sandbox", "safety", "security"],
    localPaths: ["src/approval.ts", "src/policy.ts", "src/autonomy/sandbox.ts"],
    localPattern: /approval|policy|sandbox|safety|security/iu,
    proposedPaths: ["src/policy.ts", "tests/unit/policy.test.ts"],
    testable: true,
    dependencyStatus: "ready",
  },
  "platform.compatibility": {
    category: "safety-platform-testing-docs",
    topic: "platform-compatibility",
    keywords: ["windows", "macos", "linux", "platform", "cross-platform"],
    localPaths: ["src/cli.ts", "src/workspace.ts", "package.json"],
    localPattern: /platform|win32|darwin|linux|path/iu,
    proposedPaths: ["src/workspace.ts", "tests/unit/workspace.test.ts"],
    testable: true,
    dependencyStatus: "ready",
  },
  "testing.automation": {
    category: "safety-platform-testing-docs",
    topic: "test-automation",
    keywords: ["test", "testing", "ci", "verification", "quality gate"],
    localPaths: ["package.json", "src/autonomy/review.ts", "src/autonomy/release.ts"],
    localPattern: /test|verify|check|quality/iu,
    proposedPaths: ["src/autonomy/review.ts", "tests/unit/autonomy-review.test.ts"],
    testable: true,
    dependencyStatus: "ready",
  },
  "docs.guidance": {
    category: "safety-platform-testing-docs",
    topic: "documentation-guidance",
    keywords: ["documentation", "docs", "guide", "tutorial", "troubleshooting"],
    localPaths: ["README.md", "AUTONOMY.md"],
    localPattern: /guide|usage|install|troubleshoot|documentation/iu,
    proposedPaths: ["README.md", "tests/unit/documentation.test.ts"],
    testable: true,
    dependencyStatus: "ready",
  },
};

export function parseGapClassification(input: unknown): z.infer<typeof GapClassificationSchema> {
  return GapClassificationSchema.parse(input);
}

export function classifyGapObservation(
  input: Pick<GapObservation, "title" | "body">,
): z.infer<typeof GapClassificationSchema> {
  const text = normalize(`${sanitizeUntrustedText(input.title)} ${sanitizeUntrustedText(input.body)}`);
  const ranked = GAP_SUBCODES.map((subcode) => ({
    subcode,
    hits: TAXONOMY[subcode].keywords.reduce(
      (count, keyword) => count + (text.includes(normalize(keyword)) ? 1 : 0),
      0,
    ),
  })).sort((left, right) => right.hits - left.hits || left.subcode.localeCompare(right.subcode));
  const selected = ranked[0];
  if (!selected || selected.hits === 0) {
    throw new Error("Observation does not match the closed gap taxonomy");
  }
  const taxonomy = TAXONOMY[selected.subcode];
  return {
    category: taxonomy.category,
    topic: taxonomy.topic,
    subcode: selected.subcode,
  };
}

export const classifyGap = classifyGapObservation;

export function collectLocalCapabilityEvidence(
  repoRoot: string,
  classificationInput: unknown,
): LocalCapabilityEvidence {
  const classification = parseGapClassification(classificationInput);
  const canonicalRoot = fs.realpathSync(repoRoot);
  const entry = TAXONOMY[classification.subcode];
  const checkedPaths: string[] = [];
  const matchedPaths: string[] = [];
  const absentPaths: string[] = [];
  for (const relativePath of entry.localPaths.slice(0, 8)) {
    checkedPaths.push(relativePath);
    const absolutePath = path.resolve(canonicalRoot, relativePath);
    if (!isWithin(canonicalRoot, absolutePath) || !fs.existsSync(absolutePath)) {
      absentPaths.push(relativePath);
      continue;
    }
    const stat = fs.statSync(absolutePath);
    if (!stat.isFile() || stat.size > 256 * 1024) {
      absentPaths.push(relativePath);
      continue;
    }
    const bounded = fs.readFileSync(absolutePath, "utf8").slice(0, 64 * 1024);
    if (entry.localPattern.test(bounded)) matchedPaths.push(relativePath);
    else absentPaths.push(relativePath);
  }
  const status =
    matchedPaths.length === 0
      ? "absent"
      : absentPaths.length > 0
        ? "partial"
        : "present";
  return LocalCapabilityEvidenceSchema.parse({
    detectorId: classification.subcode,
    status,
    checkedPaths,
    matchedPaths,
    absentPaths,
    summary:
      status === "present"
        ? `The closed ${classification.subcode} detector found all required local capability signals.`
        : `The closed ${classification.subcode} detector found ${status} capability evidence; ` +
          `missing signals: ${absentPaths.join(", ")}.`,
  });
}

export function gapTaxonomyAuthority(classificationInput: unknown): {
  proposedPaths: readonly string[];
  testable: true;
  dependencyStatus: "ready";
} {
  const classification = parseGapClassification(classificationInput);
  const entry = TAXONOMY[classification.subcode];
  return {
    proposedPaths: entry.proposedPaths,
    testable: entry.testable,
    dependencyStatus: entry.dependencyStatus,
  };
}

export function stableGapFingerprint(input: {
  sourceId: string;
  sourceUrl: string;
  externalId: string;
  classification: unknown;
  need: string;
}): string {
  const classification = parseGapClassification(input.classification);
  const canonical = {
    category: classification.category,
    externalId: normalize(input.externalId),
    need: normalize(sanitizeUntrustedText(input.need)),
    sourceId: normalize(input.sourceId),
    sourceUrl: canonicalUrl(input.sourceUrl),
    subcode: classification.subcode,
    topic: classification.topic,
  };
  return crypto.createHash("sha256").update(stableJson(canonical)).digest("hex");
}

export const gapFingerprint = stableGapFingerprint;

export function scoreGap(input: {
  incremental: boolean;
  allowlistedSource: boolean;
  localEvidence: LocalCapabilityEvidence;
  confidence: GapConfidence;
  testable: boolean;
  dependencyReady: boolean;
}): number {
  const confidencePoints =
    input.confidence === "confirmed" ? 25 : input.confidence === "likely" ? 15 : 0;
  return Math.min(
    100,
    (input.incremental ? 15 : 0) +
      (input.allowlistedSource ? 15 : 0) +
      (["absent", "partial"].includes(input.localEvidence.status) ? 20 : 0) +
      confidencePoints +
      (input.testable ? 15 : 0) +
      (input.dependencyReady ? 10 : 0),
  );
}

export interface GapEligibility {
  directEligible: boolean;
  status: "eligible" | "queued";
  reasons: readonly string[];
}

export function evaluateDirectEligibility(input: {
  candidate: GapCandidate;
  registry: CommunityRegistry;
  policy: GapPolicy;
  promotionsThisTick?: number;
  now?: number;
}): GapEligibility {
  const candidate = GapCandidateSchema.parse(input.candidate);
  const now = input.now ?? Date.now();
  const reasons: string[] = [];
  const source = input.registry.sources.find(
    (registered) => registered.id === candidate.observation.sourceId,
  );
  if (!candidate.observation.incremental) reasons.push("observation is not incremental");
  if (
    !source ||
    !source.topics.includes(candidate.classification.category) ||
    ![
      source.repository,
      source.releases,
      source.discussions,
      source.documentation.url,
    ].some((allowed) => isUrlWithin(candidate.observation.sourceUrl, allowed))
  ) {
    reasons.push("source is not allowlisted for the category");
  }
  const authority = gapTaxonomyAuthority(candidate.classification);
  const entry = TAXONOMY[candidate.classification.subcode];
  if (
    candidate.localEvidence.detectorId !== candidate.classification.subcode ||
    !sameStrings(candidate.localEvidence.checkedPaths, entry.localPaths) ||
    !["absent", "partial"].includes(candidate.localEvidence.status)
  ) {
    reasons.push("independent local absence or partial evidence is missing");
  }
  if (confidenceRank(candidate.confidence) < confidenceRank(input.policy.confidenceThreshold)) {
    reasons.push("confidence is below policy threshold");
  }
  if (candidate.score < input.policy.minimumScore) reasons.push("score is below policy minimum");
  if (candidate.testable !== authority.testable) {
    reasons.push("testability is not derived from the closed taxonomy");
  }
  if (candidate.dependencyStatus !== authority.dependencyStatus) {
    reasons.push("dependency status is not derived from the closed taxonomy");
  }
  if (!sameStrings(candidate.proposedPaths, authority.proposedPaths)) {
    reasons.push("proposed paths are unknown to the closed taxonomy");
  }
  if (
    candidate.proposedPaths.some(
      (candidatePath) =>
        path.isAbsolute(candidatePath) ||
        candidatePath.split(/[\\/]/u).includes("..") ||
        candidatePath.startsWith("-"),
    )
  ) {
    reasons.push("proposed paths are unsafe");
  }
  if (candidate.expiresAt <= now) reasons.push("finding has expired");
  if (
    candidate.proposedPaths.some((candidatePath) =>
      input.policy.protectedGovernancePaths.some((protectedPath) =>
        matchesProtectedPath(candidatePath, protectedPath),
      ),
    )
  ) {
    reasons.push("proposed change touches protected governance");
  }
  if ((input.promotionsThisTick ?? 0) >= input.policy.maximumPromotionsPerTick) {
    reasons.push("promotion limit for this tick is reached");
  }
  if (candidate.confidence === "speculative") reasons.push("speculative findings cannot execute");
  return {
    directEligible: reasons.length === 0,
    status: reasons.length === 0 ? "eligible" : "queued",
    reasons,
  };
}

export const directGapEligibility = evaluateDirectEligibility;

export const GapDraftInputSchema = z
  .object({
    sourceUrl: z.url(),
    sourceEvidence: z.string().min(1).max(8_192),
    problemStatement: z.string().min(1).max(8_192),
    userValue: z.string().min(1).max(4_096),
    scope: z.string().min(1).max(4_096),
    nonGoals: z.string().min(1).max(4_096),
    acceptanceCriteria: z.string().min(1).max(8_192),
    testPlan: z.string().min(1).max(8_192),
    dogfoodPlan: z.string().min(1).max(4_096),
    riskAndSecurityNotes: z.string().min(1).max(4_096),
    duplicateSearchEvidence: z.string().min(1).max(4_096),
    parentChildRelationship: z.string().min(1).max(2_000),
    dependencyOrder: z.string().min(1).max(2_000),
  })
  .strict();

export function buildNormalizedGapDraft(
  input: z.infer<typeof GapDraftInputSchema>,
): Readonly<Record<NormalizedGapField, string>> {
  const parsed = GapDraftInputSchema.parse(input);
  const draft: Record<NormalizedGapField, string> = {
    sourceType: "community",
    sourceLinkOrEvidence: sanitizeRequired(
      `${parsed.sourceUrl}\n${parsed.sourceEvidence}`,
      "source evidence",
    ),
    problemStatement: sanitizeRequired(parsed.problemStatement, "problem statement"),
    userValue: sanitizeRequired(parsed.userValue, "user value"),
    scope: sanitizeRequired(parsed.scope, "scope"),
    nonGoals: sanitizeRequired(parsed.nonGoals, "non-goals"),
    acceptanceCriteria: sanitizeRequired(parsed.acceptanceCriteria, "acceptance criteria"),
    testPlan: sanitizeRequired(parsed.testPlan, "test plan"),
    dogfoodPlan: sanitizeRequired(parsed.dogfoodPlan, "dogfood plan"),
    riskAndSecurityNotes: sanitizeRequired(
      parsed.riskAndSecurityNotes,
      "risk and security notes",
    ),
    duplicateSearchEvidence: sanitizeRequired(
      parsed.duplicateSearchEvidence,
      "duplicate search evidence",
    ),
    parentChildRelationship: sanitizeRequired(
      parsed.parentChildRelationship,
      "parent-child relationship",
    ),
    dependencyOrder: sanitizeRequired(parsed.dependencyOrder, "dependency order"),
  };
  if (
    Object.keys(draft).length !== NORMALIZED_GAP_FIELDS.length ||
    NORMALIZED_GAP_FIELDS.some((field) => !(field in draft))
  ) {
    throw new Error("Normalized gap draft does not contain the exact field contract");
  }
  return draft;
}

export const buildGapDraft = buildNormalizedGapDraft;

export function findingExpiry(observedAt: number, policy: GapPolicy): number {
  if (!Number.isSafeInteger(observedAt) || observedAt < 0) {
    throw new Error("Observed timestamp must be a non-negative integer");
  }
  const expiry = observedAt + policy.findingTtlDays * 24 * 60 * 60 * 1_000;
  if (!Number.isSafeInteger(expiry)) throw new Error("Finding expiry is out of range");
  return expiry;
}

function sanitizeRequired(value: string, label: string): string {
  const sanitized = sanitizeUntrustedText(value);
  if (!sanitized) throw new Error(`${label} is empty after sanitization`);
  return sanitized;
}

function normalize(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();
}

function canonicalUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
  return url.toString();
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function confidenceRank(value: GapConfidence): number {
  return GAP_CONFIDENCES.indexOf(value);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function matchesProtectedPath(candidateValue: string, protectedValue: string): boolean {
  const candidate = candidateValue.replace(/\\/gu, "/").replace(/^\.\//u, "");
  const protectedPath = protectedValue.replace(/\\/gu, "/").replace(/^\.\//u, "");
  if (protectedPath.endsWith("/**")) {
    const prefix = protectedPath.slice(0, -3);
    return candidate === prefix || candidate.startsWith(`${prefix}/`);
  }
  if (protectedPath.endsWith("/*")) {
    const prefix = protectedPath.slice(0, -2);
    return candidate.startsWith(`${prefix}/`) && !candidate.slice(prefix.length + 1).includes("/");
  }
  return candidate === protectedPath;
}

function isUrlWithin(candidateValue: string, allowedValue: string): boolean {
  const candidate = new URL(candidateValue);
  const allowed = new URL(allowedValue);
  const allowedPath = allowed.pathname.replace(/\/+$/u, "");
  return (
    candidate.protocol === "https:" &&
    !candidate.username &&
    !candidate.password &&
    !candidate.port &&
    candidate.origin === allowed.origin &&
    (candidate.pathname === allowedPath ||
      candidate.pathname.startsWith(`${allowedPath}/`) ||
      (allowedPath === "" && candidate.pathname.startsWith("/")))
  );
}
