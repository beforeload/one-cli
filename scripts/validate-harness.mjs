#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const required = [
  "harness/README.md",
  "harness/roadmap.yml",
  "harness/tsconfig.json",
  "harness/launchd/com.beforeload.one-cli-harness.plist",
  "harness/src/github.ts",
  "harness/src/executable.ts",
  "harness/src/host.ts",
  "harness/src/index.ts",
  "harness/src/launchd.ts",
  "harness/src/one-cli.ts",
  "harness/src/roadmap.ts",
  "harness/src/release.ts",
  "harness/src/runner.ts",
  "harness/src/seed.ts",
  "harness/src/seed-state.ts",
  "harness/src/supervisor.ts",
];
const failures = [];
for (const relative of required) {
  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    failures.push(`missing regular file: ${relative}`);
  }
}

const roadmap = YAML.parse(
  fs.readFileSync(path.join(root, "harness/roadmap.yml"), "utf8"),
);
const fields = [
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
];
const titles = [
  "Reliability semantic coherence and impossible attempts",
  "Deterministic lease heartbeat",
  "Deterministic context compaction",
  "Provider profiles fallback and budget",
  "Bounded glob regex and ignore rules",
  "Interactive REPL and session picker",
  "Trust-gated MCP Hook health inventory",
  "Linux sandbox and cross-platform release",
];
const ids = [
  "01-semantic-coherence",
  "02-lease-heartbeat",
  "03-context-compaction",
  "04-provider-profiles",
  "05-bounded-search",
  "06-interactive-session",
  "07-extension-health",
  "08-linux-release",
];
if (
  roadmap?.schema !== "one-cli.cold-start-roadmap/v1" ||
  roadmap?.parent?.title !== "Production coding-agent CLI cold-start roadmap" ||
  JSON.stringify(roadmap?.parent?.labels) !==
    JSON.stringify(["enhancement", "parent", "priority:p2"])
) {
  failures.push("roadmap parent contract is invalid");
}
if (
  JSON.stringify(roadmap?.children?.map((child) => child.title)) !== JSON.stringify(titles)
) {
  failures.push("roadmap must contain the exact ordered eight children");
}
if (
  JSON.stringify(roadmap?.children?.map((child) => child.id)) !== JSON.stringify(ids) ||
  JSON.stringify(roadmap?.children?.map((child) => child.seedMarker)) !==
    JSON.stringify(ids.map((id) => `<!-- one-cli:cold-start-seed:${id}:v1 -->`))
) {
  failures.push("roadmap must contain the exact accepted child IDs and markers");
}
const markers = new Set();
const protectedPaths = new Set([
  "AUTONOMY.md",
  ".github/CODEOWNERS",
  "src/autonomy/cli.ts",
  "src/autonomy/intake.ts",
  "src/autonomy/maintenance.ts",
  "src/autonomy/orchestrator.ts",
  "src/autonomy/roadmap-enforcement.ts",
]);
const allowedNewPaths = roadmap?.allowedNewPaths ?? [];
for (const [index, child] of (roadmap?.children ?? []).entries()) {
  if (
    JSON.stringify(Object.keys(child.fields ?? {})) !== JSON.stringify(fields) ||
    Object.values(child.fields ?? {}).some((value) => typeof value !== "string" || !value.trim())
  ) {
    failures.push(`child ${index + 1} must contain exactly 13 non-empty normalized fields`);
  }
  if (
    child.trustedExecutionMarker !== "<!-- one-cli:trusted-execution:v1 -->" ||
    JSON.stringify(child.labels) !==
      JSON.stringify(["enhancement", "cold-start-roadmap", "priority:p1"]) ||
    !Array.isArray(child.approvedPaths) ||
    child.approvedPaths.length === 0
  ) {
    failures.push(`child ${index + 1} execution binding is invalid`);
  }
  if (markers.has(child.seedMarker)) failures.push(`child ${index + 1} seed marker is duplicate`);
  markers.add(child.seedMarker);
  for (const approvedPath of child.approvedPaths ?? []) {
    const protectedPath =
      protectedPaths.has(approvedPath) ||
      approvedPath === ".autonomy" ||
      approvedPath.startsWith(".autonomy/") ||
      approvedPath === ".github/workflows" ||
      approvedPath.startsWith(".github/workflows/") ||
      approvedPath === "harness" ||
      approvedPath.startsWith("harness/");
    if (protectedPath) failures.push(`child ${index + 1} approved path is protected: ${approvedPath}`);
    const absolute = path.join(root, approvedPath);
    if (fs.existsSync(absolute) && (!fs.lstatSync(absolute).isFile() || fs.lstatSync(absolute).isSymbolicLink())) {
      failures.push(`child ${index + 1} approved path is not a regular file: ${approvedPath}`);
    }
    if (!fs.existsSync(absolute) && !allowedNewPaths.includes(approvedPath)) {
      failures.push(`child ${index + 1} approved path does not exist: ${approvedPath}`);
    }
  }
}
for (const allowedPath of allowedNewPaths) {
  const parent = path.dirname(path.join(root, allowedPath));
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
    failures.push(`allowed new path has no existing parent: ${allowedPath}`);
  }
}

const plist = fs.readFileSync(
  path.join(root, "harness/launchd/com.beforeload.one-cli-harness.plist"),
  "utf8",
);
for (const expected of [
  "__NODE_EXECUTABLE__",
  "__REPOSITORY__/harness/dist/index.js",
  "__GH_EXECUTABLE__",
  "ONE_CLI_HARNESS_ENV_FILE",
  "ONE_CLI_GH_EXECUTABLE",
]) {
  if (!plist.includes(expected)) failures.push(`launchd template lacks ${expected}`);
}
if (/(?:OPENAI_API_KEY|GH_TOKEN|GITHUB_TOKEN)\s*<\/key>/u.test(plist)) {
  failures.push("launchd template embeds a secret environment key");
}

const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
if (packageJson.files?.includes("harness") || packageJson.files?.includes("harness/**")) {
  failures.push("harness must not be included in npm published files");
}
for (const command of ["doctor", "seed", "run", "status", "install", "uninstall"]) {
  const source = fs.readFileSync(path.join(root, "harness/src/index.ts"), "utf8");
  if (!source.includes(`"${command}"`)) failures.push(`harness CLI lacks ${command}`);
}

if (failures.length) {
  console.error("Harness validation failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Harness contract valid (${required.length} files checked).`);
}
