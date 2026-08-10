import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { z } from "zod";

export const ROADMAP_SCHEMA = "one-cli.cold-start-roadmap/v1";
export const ROADMAP_PARENT_TITLE = "Production coding-agent CLI cold-start roadmap";
export const TRUSTED_EXECUTION_MARKER = "<!-- one-cli:trusted-execution:v1 -->";
export const APPROVED_PATHS_PREFIX = "Trusted approved paths (exact JSON): ";
export const NORMALIZED_FIELDS = [
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

export const EXPECTED_CHILDREN = [
  ["01-semantic-coherence", "Reliability semantic coherence and impossible attempts"],
  ["02-lease-heartbeat", "Deterministic lease heartbeat"],
  ["03-context-compaction", "Deterministic context compaction"],
  ["04-provider-profiles", "Provider profiles fallback and budget"],
  ["05-bounded-search", "Bounded glob regex and ignore rules"],
  ["06-interactive-session", "Interactive REPL and session picker"],
  ["07-extension-health", "Trust-gated MCP Hook health inventory"],
  ["08-linux-release", "Linux sandbox and cross-platform release"],
] as const;

const FieldsSchema = z.object(
  Object.fromEntries(
    NORMALIZED_FIELDS.map((field) => [field, z.string().trim().min(1).max(4_096)]),
  ) as Record<(typeof NORMALIZED_FIELDS)[number], z.ZodString>,
).strict();

const ParentSchema = z.object({
  title: z.literal(ROADMAP_PARENT_TITLE),
  labels: z.tuple([
    z.literal("enhancement"),
    z.literal("parent"),
    z.literal("priority:p2"),
  ]),
  seedMarker: z.string().regex(/^<!-- one-cli:cold-start-seed:parent:v1 -->$/u),
}).strict();

const ChildSchema = z.object({
  id: z.string().regex(/^[0-9]{2}-[a-z0-9-]+$/u),
  title: z.string().trim().min(1).max(160),
  labels: z.tuple([
    z.literal("enhancement"),
    z.literal("cold-start-roadmap"),
    z.literal("priority:p1"),
  ]),
  trustedExecutionMarker: z.literal(TRUSTED_EXECUTION_MARKER),
  seedMarker: z.string().regex(/^<!-- one-cli:cold-start-seed:[a-z0-9-]+:v1 -->$/u),
  approvedPaths: z.array(z.string().trim().min(1).max(512)).min(1).max(128),
  fields: FieldsSchema,
}).strict();

const RoadmapSchema = z.object({
  schema: z.literal(ROADMAP_SCHEMA),
  allowedNewPaths: z.array(z.string().trim().min(1).max(512)).max(128),
  parent: ParentSchema,
  children: z.array(ChildSchema).length(8),
}).strict();

export type Roadmap = z.infer<typeof RoadmapSchema>;
export type RoadmapChild = Roadmap["children"][number];

export function loadRoadmap(filePath: string): Roadmap {
  const before = fs.lstatSync(filePath);
  if (before.isSymbolicLink() || !before.isFile() || before.size > 512 * 1024) {
    throw new Error("Roadmap must be a bounded regular file");
  }
  const roadmap = RoadmapSchema.parse(YAML.parse(fs.readFileSync(filePath, "utf8")));
  const candidateRoot = path.resolve(path.dirname(filePath), "..");
  validateRoadmap(
    roadmap,
    fs.existsSync(path.join(candidateRoot, "package.json")) ? candidateRoot : undefined,
  );
  return roadmap;
}

export function validateRoadmap(roadmap: Roadmap, repositoryRoot?: string): void {
  if (
    roadmap.parent.labels.includes("agent-ready" as never) ||
    roadmap.parent.labels.some((label) => label.startsWith("source:")) ||
    roadmap.parent.seedMarker.includes("trusted-execution")
  ) {
    throw new Error("Roadmap parent must remain non-executable");
  }
  const markers = new Set([roadmap.parent.seedMarker]);
  const allowedNewPaths = canonicalApprovedPaths(roadmap.allowedNewPaths);
  if (new Set(allowedNewPaths).size !== allowedNewPaths.length) {
    throw new Error("Roadmap allowed-new paths contain duplicates");
  }
  roadmap.children.forEach((child, index) => {
    const expected = EXPECTED_CHILDREN[index]!;
    const expectedMarker = `<!-- one-cli:cold-start-seed:${expected[0]}:v1 -->`;
    if (
      child.id !== expected[0] ||
      child.title !== expected[1] ||
      child.seedMarker !== expectedMarker
    ) {
      throw new Error(`Roadmap child ${index + 1} does not match the accepted order`);
    }
    if (markers.has(child.seedMarker)) throw new Error("Roadmap seed markers must be unique");
    markers.add(child.seedMarker);
    const canonical = canonicalApprovedPaths(child.approvedPaths);
    if (canonical.some((value, pathIndex) => value !== child.approvedPaths[pathIndex])) {
      throw new Error(`Roadmap child ${child.id} approved paths are not canonical`);
    }
    if (new Set(child.approvedPaths).size !== child.approvedPaths.length) {
      throw new Error(`Roadmap child ${child.id} has duplicate approved paths`);
    }
    for (const approvedPath of child.approvedPaths) {
      assertUnprotected(approvedPath, child.id);
      const absolute = repositoryRoot ? path.join(repositoryRoot, approvedPath) : undefined;
      if (absolute && fs.existsSync(absolute)) {
        const stat = fs.lstatSync(absolute);
        if (stat.isSymbolicLink() || !stat.isFile()) {
          throw new Error(`Roadmap child ${child.id} path is not a regular file: ${approvedPath}`);
        }
      } else if (absolute) {
        if (!allowedNewPaths.includes(approvedPath)) {
          throw new Error(
            `Roadmap child ${child.id} path does not exist and is not allowed new: ${approvedPath}`,
          );
        }
        const parent = path.dirname(absolute);
        if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
          throw new Error(`Allowed new roadmap path has no existing parent: ${approvedPath}`);
        }
      }
    }
    const expectedParent = `Child ${index + 1} of ${ROADMAP_PARENT_TITLE}.`;
    if (child.fields.parentChildRelationship !== expectedParent) {
      throw new Error(`Roadmap child ${child.id} has an invalid parent relationship`);
    }
    const expectedDependency =
      index === 0 ? "First child; no roadmap dependency." : `Depends on child ${index} delivery.`;
    if (child.fields.dependencyOrder !== expectedDependency) {
      throw new Error(`Roadmap child ${child.id} has an invalid dependency order`);
    }
  });
  for (const allowedPath of allowedNewPaths) {
    assertUnprotected(allowedPath, "allowed-new");
    if (!roadmap.children.some((child) => child.approvedPaths.includes(allowedPath))) {
      throw new Error(`Allowed new roadmap path is unused: ${allowedPath}`);
    }
    if (repositoryRoot && fs.existsSync(path.join(repositoryRoot, allowedPath))) {
      throw new Error(`Allowed new roadmap path already exists: ${allowedPath}`);
    }
  }
}

export function childBody(child: RoadmapChild, parentNumber: number): string {
  const approved = canonicalApprovedPaths(child.approvedPaths);
  const binding = `${APPROVED_PATHS_PREFIX}${JSON.stringify(approved)}`;
  const fields = {
    ...child.fields,
    scope: `${binding}\n${child.fields.scope}`,
    acceptanceCriteria: `${binding}\n${child.fields.acceptanceCriteria}`,
    sourceLinkOrEvidence: `${child.fields.sourceLinkOrEvidence}\n${child.seedMarker}`,
    parentChildRelationship:
      `${child.fields.parentChildRelationship}\nParent: #${positiveInteger(parentNumber)}`,
  };
  return [
    child.trustedExecutionMarker,
    child.seedMarker,
    ...NORMALIZED_FIELDS.flatMap((field) => [
      `## ${heading(field)}`,
      fields[field],
    ]),
  ].join("\n\n");
}

export function parentBody(roadmap: Roadmap): string {
  return [
    roadmap.parent.seedMarker,
    "Tracks the dependency-ordered production coding-agent CLI cold-start.",
    "This parent is intentionally non-executable and must never receive agent-ready, source labels, or a trusted execution marker.",
    ...roadmap.children.map((child, index) => `${index + 1}. ${child.title}`),
  ].join("\n\n");
}

export function assertRoadmapParent(issue: {
  title: string;
  body: string;
  labels: readonly string[];
  state: "open" | "closed";
}, roadmap: Roadmap): void {
  const base = parentBody(roadmap);
  const deliveryPrefix = `${base}\n\n## Delivery evidence\n`;
  const deliveryLines = issue.body.startsWith(deliveryPrefix)
    ? issue.body.slice(deliveryPrefix.length).split("\n")
    : [];
  const bodyValid = issue.state === "open"
    ? issue.body === base
    : deliveryLines.length === roadmap.children.length &&
      deliveryLines.every((line) =>
        /^- #[1-9][0-9]* via PR #[1-9][0-9]* at [0-9a-f]{40,64}$/u.test(line)
      );
  if (
    issue.title !== roadmap.parent.title ||
    !sameStrings(issue.labels, roadmap.parent.labels) ||
    !bodyValid ||
    issue.body.includes(TRUSTED_EXECUTION_MARKER) ||
    issue.labels.includes("agent-ready") ||
    issue.labels.some((label) => label.startsWith("source:"))
  ) {
    throw new Error(
      "Roadmap parent invariant drifted; exact non-executable labels and body are required",
    );
  }
}

export function defaultRoadmapPath(moduleUrl: string): string {
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), "../roadmap.yml");
}

function canonicalApprovedPaths(paths: readonly string[]): string[] {
  return paths.map((candidate) => {
    const value = candidate.replace(/\\/gu, "/").replace(/^\.\//u, "");
    if (
      !value ||
      value.startsWith("/") ||
      value.startsWith("-") ||
      /^[A-Za-z]:\//u.test(value) ||
      value.split("/").some((segment) => !segment || segment === "." || segment === "..")
    ) {
      throw new Error(`Unsafe roadmap approved path: ${candidate}`);
    }
    return value;
  });
}

function assertUnprotected(candidate: string, childId: string): void {
  if (
    candidate === "AUTONOMY.md" ||
    candidate === ".github/CODEOWNERS" ||
    candidate === ".autonomy" ||
    candidate.startsWith(".autonomy/") ||
    candidate === ".github/workflows" ||
    candidate.startsWith(".github/workflows/") ||
    candidate === "harness" ||
    candidate.startsWith("harness/") ||
    [
      "src/autonomy/cli.ts",
      "src/autonomy/intake.ts",
      "src/autonomy/maintenance.ts",
      "src/autonomy/orchestrator.ts",
      "src/autonomy/roadmap-enforcement.ts",
    ].includes(candidate)
  ) {
    throw new Error(`Roadmap ${childId} contains protected path: ${candidate}`);
  }
}

function heading(value: string): string {
  return value.replace(/[A-Z]/gu, (letter) => ` ${letter}`).replace(/^./u, (letter) =>
    letter.toUpperCase());
}

function positiveInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Issue number must be positive");
  return value;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length &&
    [...left].sort().every((value, index) => value === [...right].sort()[index]);
}
