import crypto from "node:crypto";
import type { Attempt, JsonValue } from "./domain.js";
import type { GitHubIssue } from "./github.js";
import {
  COLD_START_ROADMAP_LABEL,
  EXECUTION_MARKER,
  parseApprovedPathBinding,
} from "./intake.js";

export const COLD_START_ROADMAP_IDS = [
  "01-semantic-coherence",
  "02-lease-heartbeat",
  "03-context-compaction",
  "04-provider-profiles",
  "05-bounded-search",
  "06-interactive-session",
  "07-extension-health",
  "08-linux-release",
] as const;
export const COLD_START_ROADMAP_MARKERS = COLD_START_ROADMAP_IDS.map(
  (id) => `<!-- one-cli:cold-start-seed:${id}:v1 -->`,
);
const ACCEPTED_MARKERS = new Set<string>(COLD_START_ROADMAP_MARKERS);
const CONTROL_PATHS = new Set([
  "AUTONOMY.md",
  ".github/CODEOWNERS",
  "src/autonomy/cli.ts",
  "src/autonomy/intake.ts",
  "src/autonomy/maintenance.ts",
  "src/autonomy/orchestrator.ts",
  "src/autonomy/roadmap-enforcement.ts",
]);

export interface RoadmapScopeBinding {
  version: 1;
  issueNumber: number;
  issueDigest: string;
  seedMarker: string;
  executionMarker: typeof EXECUTION_MARKER;
  approvedPaths: readonly string[];
}

export interface ExpectedRoadmapBinding {
  issueNumber: number;
  seedMarker: string;
}

export function createRoadmapScopeBinding(input: {
  issue: GitHubIssue;
  issueDigest: string;
  fields: Readonly<Record<string, string>>;
  approvedPaths: readonly string[];
  expected: ExpectedRoadmapBinding;
}): RoadmapScopeBinding {
  const seedMarker = validateRoadmapSource(input.issue, input.fields, input.expected);
  assertRoadmapApprovedPaths(input.approvedPaths);
  return {
    version: 1,
    issueNumber: input.issue.number,
    issueDigest: input.issueDigest,
    seedMarker,
    executionMarker: EXECUTION_MARKER,
    approvedPaths: [...input.approvedPaths],
  };
}

/**
 * This check is intentionally local and read-only. Roadmap-only recovery must
 * reject legacy/non-roadmap attempts before any remote reconciliation write.
 */
export function requireRoadmapScopeBinding(
  attempt: Attempt,
  expected: ExpectedRoadmapBinding,
): RoadmapScopeBinding {
  const detail = object(attempt.detail);
  const binding = object(detail.roadmapScopeBinding);
  const fields = stringRecord(detail.issueFields);
  const approvedPaths = parseApprovedPathBinding(fields);
  const marker = typeof binding.seedMarker === "string" ? binding.seedMarker : "";
  const issueNumber = binding.issueNumber;
  const storedPaths = stringArray(binding.approvedPaths);
  if (
    binding.version !== 1 ||
    typeof issueNumber !== "number" ||
    !Number.isSafeInteger(issueNumber) ||
    issueNumber <= 0 ||
    attempt.issueId !== `github-${issueNumber}` ||
    typeof binding.issueDigest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(binding.issueDigest) ||
    binding.issueDigest !== object(detail.claimRequest).digest ||
    !ACCEPTED_MARKERS.has(marker) ||
    issueNumber !== expected.issueNumber ||
    marker !== expected.seedMarker ||
    binding.executionMarker !== EXECUTION_MARKER ||
    fields.sourceType !== "cold-start-roadmap" ||
    !fields.sourceLinkOrEvidence?.includes(marker) ||
    approvedPaths === undefined ||
    storedPaths === undefined ||
    !sameStrings(storedPaths, approvedPaths)
  ) {
    throw new Error(
      "Roadmap-only active attempt lacks an exact durable cold-start scope binding",
    );
  }
  assertRoadmapApprovedPaths(storedPaths);
  return {
    version: 1,
    issueNumber,
    issueDigest: binding.issueDigest,
    seedMarker: marker,
    executionMarker: EXECUTION_MARKER,
    approvedPaths: storedPaths,
  };
}

export function assertRoadmapApprovedPaths(paths: readonly string[]): void {
  if (paths.length === 0) throw new Error("Roadmap child has no approved paths");
  for (const candidate of paths) {
    if (
      candidate === "harness" ||
      candidate.startsWith("harness/") ||
      candidate === ".autonomy" ||
      candidate.startsWith(".autonomy/") ||
      candidate === ".github/workflows" ||
      candidate.startsWith(".github/workflows/") ||
      CONTROL_PATHS.has(candidate)
    ) {
      throw new Error(`Roadmap child approved path is protected: ${candidate}`);
    }
  }
}

export function roadmapIssueDigest(issue: GitHubIssue): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({
      number: issue.number,
      title: issue.title,
      body: issue.body,
      author: issue.user?.login ?? null,
      state: issue.state,
      labels: [...issue.labels].sort(),
    }))
    .digest("hex");
}

function validateRoadmapSource(
  issue: GitHubIssue,
  fields: Readonly<Record<string, string>>,
  expected: ExpectedRoadmapBinding,
): string {
  const declaredMarkers = [
    ...(fields.sourceLinkOrEvidence ?? "").matchAll(
      /<!-- one-cli:cold-start-seed:[a-z0-9-]+:v1 -->/gu,
    ),
  ].map((match) => match[0]);
  const marker = declaredMarkers.length === 1 ? declaredMarkers[0] : undefined;
  if (
    issue.number !== expected.issueNumber ||
    marker !== expected.seedMarker ||
    !ACCEPTED_MARKERS.has(expected.seedMarker) ||
    !issue.labels.includes(COLD_START_ROADMAP_LABEL) ||
    fields.sourceType !== "cold-start-roadmap" ||
    !marker ||
    !issue.body?.includes(marker) ||
    !issue.body.includes(EXECUTION_MARKER) ||
    [...issue.body.matchAll(/<!-- one-cli:cold-start-seed:[a-z0-9-]+:v1 -->/gu)]
        .map((match) => match[0])
        .some((candidate) => candidate !== marker)
  ) {
    throw new Error("Roadmap issue lacks the trusted cold-start source and markers");
  }
  return marker;
}

function object(value: JsonValue | undefined | null): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, JsonValue>) }
    : {};
}

function stringRecord(value: JsonValue | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, nested] of Object.entries(object(value))) {
    if (typeof nested === "string") result[key] = nested;
  }
  return result;
}

function stringArray(value: JsonValue | undefined): string[] | undefined {
  return Array.isArray(value) && value.length > 0 &&
      value.every((item) => typeof item === "string")
    ? [...value]
    : undefined;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length &&
    left.every((candidate, index) => candidate === right[index]);
}
