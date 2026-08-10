#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const required = [
  ".github/workflows/governance.yml",
  ".github/workflows/independent-verifier.yml",
  "harness/README.md",
  "harness/roadmap.yml",
  "harness/verifier-policy.yml",
  "harness/tsconfig.json",
  "harness/launchd/com.beforeload.one-cli-harness.plist",
  "harness/src/github.ts",
  "harness/src/governance.ts",
  "harness/src/executable.ts",
  "harness/src/host.ts",
  "harness/src/index.ts",
  "harness/src/launchd.ts",
  "harness/src/one-cli.ts",
  "harness/src/release.ts",
  "harness/src/roadmap.ts",
  "harness/src/runner.ts",
  "harness/src/seed.ts",
  "harness/src/seed-state.ts",
  "harness/src/supervisor.ts",
  "harness/src/verifier-review.ts",
  "harness/src/verifier.ts",
  "package.json",
  "package-lock.json",
  "scripts/independent-verifier.mjs",
  "scripts/validate-autonomy.mjs",
  "scripts/validate-harness.mjs",
  "tsconfig.json",
  "tsconfig.build.json",
];
const trustedVerifierExactPaths = [
  "AUTONOMY.md",
  ".github/CODEOWNERS",
  ".npmrc",
  "package.json",
  "package-lock.json",
  "scripts/independent-verifier.mjs",
  "scripts/validate-autonomy.mjs",
  "scripts/validate-harness.mjs",
  "tsconfig.json",
  "tsconfig.build.json",
  "harness/tsconfig.json",
];
for (const relative of required) {
  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    failures.push(`missing regular file: ${relative}`);
  }
}

const roadmap = YAML.parse(read("harness/roadmap.yml"));
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
  JSON.stringify(roadmap?.children?.map((child) => child.id)) !== JSON.stringify(ids)
) {
  failures.push("roadmap parent or ordered child contract is invalid");
}
for (const [index, child] of (roadmap?.children ?? []).entries()) {
  if (
    JSON.stringify(Object.keys(child.fields ?? {})) !== JSON.stringify(fields) ||
    Object.values(child.fields ?? {}).some((value) => typeof value !== "string" || !value.trim()) ||
    child.trustedExecutionMarker !== "<!-- one-cli:trusted-execution:v1 -->" ||
    !Array.isArray(child.approvedPaths) ||
    child.approvedPaths.length === 0
  ) {
    failures.push(`child ${index + 1} strict execution contract is invalid`);
  }
}

const plist = read("harness/launchd/com.beforeload.one-cli-harness.plist");
for (const expected of [
  "__NODE_EXECUTABLE__",
  "__REPOSITORY__/harness/dist/index.js",
  "__GH_EXECUTABLE__",
  "ONE_CLI_HARNESS_ENV_FILE",
  "ONE_CLI_GH_EXECUTABLE",
]) {
  if (!plist.includes(expected)) failures.push(`launchd template lacks ${expected}`);
}
if (
  /(?:OPENAI_API_KEY|GH_TOKEN|GITHUB_TOKEN|ONE_CLI_GITHUB_APP_|ONE_CLI_VERIFIER_)\s*<\/key>/u
    .test(plist)
) {
  failures.push("launchd template embeds a secret environment key");
}
if (
  !/<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>\s*<\/dict>/u
    .test(plist) ||
  !/<key>ThrottleInterval<\/key>\s*<integer>300<\/integer>/u.test(plist)
) {
  failures.push("launchd restart policy is invalid");
}

const packageJson = JSON.parse(read("package.json"));
if (packageJson.files?.includes("harness") || packageJson.files?.includes("harness/**")) {
  failures.push("harness must not be included in npm published files");
}
const harnessIndex = read("harness/src/index.ts");
for (const command of ["doctor", "verifier-status", "seed", "run", "status", "install", "uninstall"]) {
  if (!harnessIndex.includes(`"${command}"`)) failures.push(`harness CLI lacks ${command}`);
}
if (!harnessIndex.includes('options.command === "run" && options.dryRun')) {
  failures.push("run --dry-run is not intercepted before mutable runtime setup");
}
for (const expected of [
  "probeLeastPrivilegeBuilder",
  "ONE_CLI_BUILDER_APP_ID",
  "Builder App has forbidden write permissions",
  "GhGovernanceReadinessPort",
  "governance.inspect",
  "governanceFailureDetail",
]) {
  if (!harnessIndex.includes(expected)) failures.push(`harness doctor lacks ${expected}`);
}

const policy = YAML.parse(read("harness/verifier-policy.yml"));
if (
  policy?.schema !== "one-cli.independent-verifier/v4" ||
  policy?.repository?.owner !== "beforeload" ||
  policy?.repository?.name !== "one-cli" ||
  policy?.repository?.defaultBranch !== "main" ||
  policy?.workflow?.event !== "pull_request_target" ||
  !/^[0-9a-f]{40}$/u.test(policy?.workflow?.blobSha ?? "") ||
  policy?.workflow?.policyVersion !== "one-cli.independent-verifier/v4" ||
  policy?.emittedCheck?.name !== "one-cli/independent-verifier" ||
  policy?.emittedCheck?.appId !== 15368 ||
  policy?.requiredChecks?.length !== 2 ||
  policy.requiredChecks[0]?.name !== "verify" ||
  policy.requiredChecks[0]?.appId !== 15368 ||
  policy.requiredChecks[1]?.name !== "one-cli/independent-verifier" ||
  policy.requiredChecks[1]?.appId !== 15368 ||
  policy?.semanticReview?.quorum !== 2 ||
  policy?.semanticReview?.profiles?.length !== 2
) {
  failures.push("trusted verifier policy identity, binding, or quorum is invalid");
}
if (
  policy?.reviewIdentity?.actor !== "github-actions[bot]" ||
  policy?.reviewIdentity?.appSlug !== "github-actions" ||
  policy?.reviewIdentity?.appId !== 15368
) {
  failures.push("verifier review actor and App ID are not pinned");
}
for (const protectedPath of trustedVerifierExactPaths) {
  if (!policy?.protectedPaths?.exact?.includes(protectedPath)) {
    failures.push(`trusted verifier policy does not protect exact path: ${protectedPath}`);
  }
}
for (const protectedPrefix of [".autonomy/", ".github/workflows/", "harness/"]) {
  if (!policy?.protectedPaths?.prefixes?.includes(protectedPrefix)) {
    failures.push(`trusted verifier policy does not protect prefix: ${protectedPrefix}`);
  }
}

const workflow = read(".github/workflows/independent-verifier.yml");
for (const expected of [
  "pull_request_target:",
  "ref: ${{ github.event.pull_request.base.sha }}",
  "ref: refs/pull/${{ github.event.pull_request.number }}/head",
  "path: trusted",
  "path: untrusted",
  "fetch-depth: 0",
  "persist-credentials: false",
  "ONE_CLI_VERIFIER_POLICY_VERSION: one-cli.independent-verifier/v4",
  "name: one-cli/independent-verifier",
  "models: read",
  "GITHUB_TOKEN: ${{ github.token }}",
  "needs: verifier",
  "if: needs.verifier.result == 'success'",
  'node "$TRUSTED_ROOT/scripts/independent-verifier.mjs"',
  "--verify",
  "--merge",
  "one-cli/independent-verifier",
]) {
  if (!workflow.includes(expected)) failures.push(`independent verifier workflow lacks ${expected}`);
}
const untrustedCheckout = workflow.indexOf("Check out untrusted pull data");
const verifierExecution = workflow.indexOf("Verify exact pull and publish App evidence");
if (
  untrustedCheckout < 0 ||
  workflow.indexOf("Verify exact pull and submit bound review") < untrustedCheckout
) {
  failures.push("untrusted pull checkout is not isolated before trusted verifier execution");
}
if (/\b(?:run|working-directory):\s*(?:untrusted|\$\{\{[^}]*head)/u.test(workflow)) {
  failures.push("independent verifier workflow executes untrusted pull code");
}

const verifierScript = read("scripts/independent-verifier.mjs");
for (const expected of [
  '"cat-file", "-e"',
  '"--binary"',
  '"--full-index"',
  "waitForPinnedChecks",
  "required.appId",
  "submitBoundReview",
  "commit_id: binding.headSha",
  "assertBoundApproval",
  "mergeExactHead",
  "sha: binding.headSha",
  "assertInstallationIdentity",
  "assertMergePreconditions",
  "Default branch advanced after verification",
  "repository.default_branch",
  "submitFinalReview",
  "requireTwoProfileVetoQuorum",
  "if (!options.verify)",
]) {
  if (!verifierScript.includes(expected)) failures.push(`trusted verifier script lacks ${expected}`);
}
if (/branches\/[^/]+\/protection|\/rulesets/u.test(verifierScript)) {
  failures.push("trusted workflow token must not call branch-protection or ruleset APIs");
}
const verifierRuntimeSources = [
  harnessIndex,
  read("harness/src/governance.ts"),
  read("harness/src/verifier.ts"),
  read("scripts/independent-verifier.mjs"),
].join("\n");
if (
  /["'](?:PUT|PATCH|DELETE)["'][\s\S]{0,300}(?:branches\/[^/]+\/protection|\/rulesets)/u
    .test(verifierRuntimeSources) ||
  /(?:branches\/[^/]+\/protection|\/rulesets)[\s\S]{0,300}["'](?:PUT|PATCH|DELETE)["']/u
    .test(verifierRuntimeSources)
) {
  failures.push("runtime verifier code can mutate or requests branch protection authority");
}
if (/create-github-app-token|ONE_CLI_VERIFIER_APP_PRIVATE_KEY|secrets\./u.test(workflow)) {
  failures.push("independent verifier workflow references a custom App or repository secret");
}

const governance = read(".github/workflows/governance.yml");
if (
  !governance.includes("name: protected-paths") ||
  !governance.includes("This job is informational") ||
  /^\s*exit 1\s*$/mu.test(governance)
) {
  failures.push("protected-paths must remain informational and non-required");
}
const qualityGates = read(".autonomy/quality-gates.yml");
const codeowners = read(".github/CODEOWNERS");
for (const protectedPath of trustedVerifierExactPaths) {
  const coveredByHarnessPrefix = protectedPath.startsWith("harness/");
  if (
    !coveredByHarnessPrefix &&
    !qualityGates.includes(`    - ${protectedPath}`)
  ) {
    failures.push(`quality gates do not protect trusted verifier path: ${protectedPath}`);
  }
  if (
    !coveredByHarnessPrefix &&
    !governance.includes(protectedPath)
  ) {
    failures.push(`governance workflow does not inventory trusted verifier path: ${protectedPath}`);
  }
  if (
    !coveredByHarnessPrefix &&
    !codeowners.includes(`/${protectedPath} @beforeload`)
  ) {
    failures.push(`CODEOWNERS does not protect trusted verifier path: ${protectedPath}`);
  }
}

const readme = read("harness/README.md");
for (const expected of [
  "`pull_request_target`",
  "`one-cli/independent-verifier`",
  "Two independent",
  "`github-actions[bot]`",
  "App ID `15368`",
  "default branch",
  "can_approve_pull_request_reviews=true",
  "require_last_push_approval",
]) {
  if (!readme.includes(expected)) failures.push(`harness verifier documentation lacks ${expected}`);
}

if (failures.length > 0) {
  console.error("Harness validation failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Harness contract valid (${required.length} files checked).`);
}

function read(relative) {
  return fs.readFileSync(path.join(root, relative), "utf8");
}
