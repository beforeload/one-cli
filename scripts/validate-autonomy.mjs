#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requiredFiles = [
  "AUTONOMY.md",
  ".autonomy/product.yml",
  ".autonomy/issue-policy.yml",
  ".autonomy/quality-gates.yml",
  ".autonomy/recovery-policy.yml",
  ".autonomy/community.yml",
  ".autonomy/gap-policy.yml",
  ".autonomy/prompts/coordinator.md",
  ".github/CODEOWNERS",
  ".github/workflows/verify.yml",
  ".github/workflows/governance.yml",
  ".github/ISSUE_TEMPLATE/bug.yml",
  ".github/ISSUE_TEMPLATE/feature.yml",
  ".github/ISSUE_TEMPLATE/config.yml",
  "harness/verifier-policy.yml",
];

const failures = [];
const documents = new Map();
const trustedVerifierExactPaths = [
  ".npmrc",
  "package.json",
  "package-lock.json",
  "scripts/independent-verifier.mjs",
  "scripts/validate-autonomy.mjs",
  "scripts/validate-harness.mjs",
  "tsconfig.json",
  "tsconfig.build.json",
];

for (const relativePath of requiredFiles) {
  const absolutePath = path.join(root, relativePath);
  if (!fs.existsSync(absolutePath)) {
    failures.push(`missing required file: ${relativePath}`);
    continue;
  }
  if (!fs.statSync(absolutePath).isFile()) {
    failures.push(`required path is not a regular file: ${relativePath}`);
    continue;
  }
  documents.set(relativePath, fs.readFileSync(absolutePath, "utf8"));
}

function requireText(relativePath, expected) {
  const content = documents.get(relativePath);
  if (content !== undefined && !content.includes(expected)) {
    failures.push(`${relativePath} must contain: ${JSON.stringify(expected)}`);
  }
}

function rejectText(relativePath, rejected) {
  const content = documents.get(relativePath);
  if (content !== undefined && content.includes(rejected)) {
    failures.push(`${relativePath} must not contain: ${JSON.stringify(rejected)}`);
  }
}

for (const file of [
  ".autonomy/product.yml",
  ".autonomy/issue-policy.yml",
  ".autonomy/quality-gates.yml",
]) {
  requireText(file, "schema: autonomy.one-cli/v1");
}
requireText(".autonomy/community.yml", "schema: autonomy.one-cli/community-v2");
requireText(".autonomy/gap-policy.yml", "schema: autonomy.one-cli/gap-policy-v1");
requireText(".autonomy/recovery-policy.yml", "schema: autonomy.one-cli/recovery-policy-v1");

for (const [file, values] of Object.entries({
  ".autonomy/product.yml": [
    "owner: beforeload",
    "name: one-cli",
    "defaultBranch: main",
    "mergeStrategy: merge",
    "author: beforeload",
    'node: ">=22.13.0"',
    "mode: auto-merge",
    "install: npm ci",
    "build: npm run build",
    "typecheck: npm run typecheck",
    "unit: npm test",
    "integration: npm run test:integration",
    "smoke: npm run smoke",
  ],
  ".autonomy/issue-policy.yml": [
    "executionAuthor: beforeload",
    "apiAuthorExactMatch: beforeload",
    "maximumActiveIssues: 1",
    "identicalCodeFailureLimit: 3",
    "thirdFailureAction: quarantine-preserve-evidence-release-lease-and-alert",
    "source:user",
    "source:community",
    "source:self-discovery",
  ],
  ".autonomy/quality-gates.yml": [
    "    - verify",
    "    - AUTONOMY.md",
    "    - .autonomy/**",
    "    - .github/workflows/**",
    "    - .github/CODEOWNERS",
    "    - harness/**",
    ...trustedVerifierExactPaths.map((candidate) => `    - ${candidate}`),
    "exceptionMode: fail-closed",
    "strategy: merge",
    "detachedExactMergeWorktree: true",
    "runBeforeLeaseRelease: true",
  ],
  ".autonomy/gap-policy.yml": [
    "confidenceThreshold: likely",
    "minimumScore: 70",
    "maximumPromotionsPerTick: 1",
    "findingTtlDays: 30",
    "governance: forbidden",
    "speculative: forbidden",
  ],
  ".autonomy/recovery-policy.yml": [
    "redaction: strict",
    "maxReceiptsPerAttempt: 20",
    "requireOperationId: true",
    "requireFailureFingerprint: true",
    "deduplicateByHash: true",
    "requireNovelEvidence: true",
  ],
  ".autonomy/prompts/coordinator.md": [
    "Execute exactly one bounded tick per invocation.",
    "## Reconcile first",
    "choose exactly one action",
    "`user.login` is exactly `beforeload`",
    "third, quarantine the work",
    "targeted post-merge dogfood",
  ],
})) {
  for (const value of values) requireText(file, value);
}

const community = YAML.parse(documents.get(".autonomy/community.yml") ?? "");
if (
  community?.monitoring?.intervalMinutes !== 120 ||
  community?.monitoring?.maximumLatenessMinutes !== 60
) {
  failures.push(".autonomy/community.yml must enforce a two-hour scan and one-hour maximum lateness");
}
const expectedSources = [
  "qwen-code",
  "claude-code",
  "openai-codex",
  "gemini-cli",
  "opencode",
  "aider",
  "goose",
  "continue-cli",
  "oh-my-cli",
];
const expectedCategories = [
  "project-monitoring",
  "interactive-coding-agent",
  "long-sessions-context",
  "extensions-parallelism",
  "provider-cost-governance",
  "safety-platform-testing-docs",
];
if (
  !Array.isArray(community?.sources) ||
  community.sources.length !== expectedSources.length ||
  expectedSources.some((id, index) => community.sources[index]?.id !== id)
) {
  failures.push(".autonomy/community.yml must contain the closed ordered nine-source registry");
}
if (
  !Array.isArray(community?.capabilityTopics) ||
  community.capabilityTopics.join("\n") !== expectedCategories.join("\n")
) {
  failures.push(".autonomy/community.yml must contain the closed capability topic taxonomy");
}
for (const source of community?.sources ?? []) {
  for (const key of ["repository", "releases", "discussions"]) {
    if (typeof source[key] !== "string" || !source[key].startsWith("https://github.com/")) {
      failures.push(`community source ${String(source.id)} has invalid official ${key} URL`);
    }
  }
  if (
    source.documentation?.kind !== "official-documentation" ||
    typeof source.documentation?.url !== "string"
  ) {
    failures.push(`community source ${String(source.id)} lacks documentation metadata`);
  }
  if (
    !Array.isArray(source.topics) ||
    source.topics.some((topic) => !expectedCategories.includes(topic))
  ) {
    failures.push(`community source ${String(source.id)} has an unknown capability topic`);
  }
}

const gapPolicy = YAML.parse(documents.get(".autonomy/gap-policy.yml") ?? "");
if (
  !Array.isArray(gapPolicy?.categories) ||
  gapPolicy.categories.join("\n") !== expectedCategories.join("\n")
) {
  failures.push(".autonomy/gap-policy.yml must use the closed ordered category taxonomy");
}

const recoveryPolicy = YAML.parse(documents.get(".autonomy/recovery-policy.yml") ?? "");
const exactKeys = (value, expected, location) => {
  const actual =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? Object.keys(value).sort()
      : [];
  if (actual.join("\n") !== [...expected].sort().join("\n")) {
    failures.push(`${location} must use the strict closed recovery policy schema`);
  }
};
exactKeys(
  recoveryPolicy,
  ["schema", "receipts", "machineEvidence", "manualBreakGlass"],
  ".autonomy/recovery-policy.yml",
);
exactKeys(
  recoveryPolicy?.receipts,
  [
    "maxStdoutBytes",
    "maxStderrBytes",
    "maxSpawnErrorBytes",
    "maxReceiptsPerAttempt",
    "redaction",
  ],
  ".autonomy/recovery-policy.yml receipts",
);
exactKeys(
  recoveryPolicy?.machineEvidence,
  [
    "maxSummaryBytes",
    "allowedSources",
    "requireOperationId",
    "requireFailureFingerprint",
    "deduplicateByHash",
  ],
  ".autonomy/recovery-policy.yml machineEvidence",
);
exactKeys(
  recoveryPolicy?.manualBreakGlass,
  ["maxEvidenceBytes", "requireNovelEvidence"],
  ".autonomy/recovery-policy.yml manualBreakGlass",
);
if (
  recoveryPolicy?.receipts?.redaction !== "strict" ||
  recoveryPolicy?.machineEvidence?.allowedSources?.join("\n") !==
    ["local-process", "worker", "github-check", "reconciler"].join("\n")
) {
  failures.push(".autonomy/recovery-policy.yml must enforce strict redaction and closed sources");
}

const packageJson = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
);
for (const script of [
  "autonomy:validate",
  "build",
  "typecheck",
  "test",
  "test:integration",
  "smoke",
  "check",
]) {
  if (typeof packageJson.scripts?.[script] !== "string") {
    failures.push(`package.json must define the ${script} script used by governance`);
  }
}
if (packageJson.engines?.node !== ">=22.13.0") {
  failures.push("package.json Node engine must be >=22.13.0 for unflagged node:sqlite");
}
for (const required of [
  "npm run autonomy:validate",
  "npm run typecheck",
  "npm test",
  "npm run test:integration",
  "npm run smoke",
  "npm run build",
]) {
  if (!packageJson.scripts?.check?.includes(required)) {
    failures.push(`package.json check must include ${required}`);
  }
}
if (packageJson.scripts?.prepublishOnly !== "npm run check && npm run build") {
  failures.push("package.json prepublishOnly safety contract changed");
}

for (const command of [
  "npm ci",
  "npm run check",
]) {
  requireText(".github/workflows/verify.yml", `run: ${command}`);
}
requireText(".github/workflows/verify.yml", "name: verify");
requireText(".github/workflows/verify.yml", "branches: [main]");
requireText(
  ".github/workflows/verify.yml",
  "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
);
rejectText(".github/workflows/verify.yml", "actions/setup-node@v4");

for (const protectedPath of [
  "AUTONOMY.md",
  ".autonomy/*",
  ".github/workflows/*",
  ".github/CODEOWNERS",
  "harness/*",
  ...trustedVerifierExactPaths,
]) {
  requireText(".github/workflows/governance.yml", protectedPath);
}
requireText(
  ".github/workflows/governance.yml",
  'if [[ "$PR_AUTHOR" == "beforeload" && "$protected" == "true" ]]',
);
requireText(".github/workflows/governance.yml", "exit 1");
rejectText(".github/workflows/governance.yml", "pull_request_target");
rejectText(".github/workflows/governance.yml", "contains(github.event.pull_request.labels");

for (const codeownerPath of [
  "/AUTONOMY.md @beforeload",
  "/.autonomy/** @beforeload",
  "/.github/workflows/** @beforeload",
  "/.github/CODEOWNERS @beforeload",
  "/harness/** @beforeload",
  ...trustedVerifierExactPaths.map((candidate) => `/${candidate} @beforeload`),
]) {
  requireText(".github/CODEOWNERS", codeownerPath);
}

const verifierPolicy = YAML.parse(documents.get("harness/verifier-policy.yml") ?? "");
for (const protectedPath of [
  "AUTONOMY.md",
  ".github/CODEOWNERS",
  "harness/tsconfig.json",
  ...trustedVerifierExactPaths,
]) {
  if (!verifierPolicy?.protectedPaths?.exact?.includes(protectedPath)) {
    failures.push(`harness/verifier-policy.yml must protect exact path: ${protectedPath}`);
  }
}
for (const protectedPrefix of [".autonomy/", ".github/workflows/", "harness/"]) {
  if (!verifierPolicy?.protectedPaths?.prefixes?.includes(protectedPrefix)) {
    failures.push(`harness/verifier-policy.yml must protect prefix: ${protectedPrefix}`);
  }
}

for (const template of [
  ".github/ISSUE_TEMPLATE/bug.yml",
  ".github/ISSUE_TEMPLATE/feature.yml",
]) {
  requireText(template, "source:user");
  requireText(template, "author login is exactly `beforeload`");
}

for (const [relativePath, content] of documents) {
  if (content.includes(`${path.sep}Users${path.sep}`)) {
    failures.push(`${relativePath} contains a host-private absolute path`);
  }
  if (/\b(?:api[_-]?key|token|password)\s*[:=]\s*["']?[A-Za-z0-9+/=_-]{12,}/i.test(content)) {
    failures.push(`${relativePath} appears to contain a credential`);
  }
}

if (failures.length > 0) {
  console.error("Autonomy contract validation failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Autonomy contract valid (${requiredFiles.length} files checked).`);
}
