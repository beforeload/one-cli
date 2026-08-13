#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const required = [
  ".github/workflows/governance.yml",
  ".github/workflows/autonomy-tick.yml",
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
  "harness/src/worker-policy.ts",
  "package.json",
  "package-lock.json",
  "scripts/bootstrap-verifier-runner.sh",
  "scripts/independent-verifier.mjs",
  "scripts/github-autonomy.mjs",
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
  "scripts/bootstrap-verifier-runner.sh",
  "scripts/independent-verifier.mjs",
  "scripts/github-autonomy.mjs",
  "scripts/validate-autonomy.mjs",
  "scripts/validate-harness.mjs",
  "tsconfig.json",
  "tsconfig.build.json",
  "harness/tsconfig.json",
  "src/agent.ts",
  "src/approval.ts",
  "src/autonomy/cli.ts",
  "src/autonomy/intake.ts",
  "src/autonomy/maintenance.ts",
  "src/autonomy/orchestrator.ts",
  "src/autonomy/roadmap-enforcement.ts",
  "src/autonomy/worker.ts",
  "src/policy.ts",
  "src/tools.ts",
  "src/workspace.ts",
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
  "safeEnvironment",
  "canonicalGhEnvironment",
  "tokenBearingEnvironmentNames",
  "WorkerReleaseReadiness",
  "GhGovernanceReadinessPort",
  "governance.inspect",
  "governanceFailureDetail",
]) {
  if (!harnessIndex.includes(expected)) failures.push(`harness doctor lacks ${expected}`);
}
if (/ONE_CLI_BUILDER_APP_ID|\/installation/u.test(harnessIndex)) {
  failures.push("harness still requires the obsolete local Builder App");
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
  !/^[0-9a-f]{64}$/u.test(policy?.workflow?.policyHash ?? "") ||
  policy?.emittedCheck?.name !== "one-cli/independent-verifier" ||
  policy?.emittedCheck?.appId !== 15368 ||
  policy?.requiredChecks?.length !== 2 ||
  policy.requiredChecks[0]?.name !== "verify" ||
  policy.requiredChecks[0]?.appId !== 15368 ||
  policy.requiredChecks[1]?.name !== "one-cli/independent-verifier" ||
  policy.requiredChecks[1]?.appId !== 15368 ||
  policy?.semanticReview?.quorum !== 2 ||
  policy?.semanticReview?.profiles?.length !== 2 ||
  policy?.workflow?.runnerLabels?.join("\n") !==
    ["self-hosted", "macOS", "one-cli-verifier"].join("\n") ||
  policy?.workflow?.toolchain?.nodeBinEnvironment !== "ONE_CLI_NODE_BIN" ||
  policy?.workflow?.toolchain?.nodeVersionRange !== ">=22.13.0 <25" ||
  policy?.workflow?.toolchain?.strictPathSuffix !==
    "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" ||
  policy?.workflow?.toolchain?.versionCommandTimeoutSeconds !== 10 ||
  policy?.workflow?.toolchain?.setupNodeAction !== "forbidden" ||
  policy?.workflow?.toolchain?.hostedToolDownload !== "forbidden" ||
  policy?.semanticReview?.baseUrlEnvironment !== "ONE_CLI_VERIFIER_BASE_URL" ||
  policy?.semanticReview?.repositoryBaseUrlEnvironment !==
    "ONE_CLI_VERIFIER_REPOSITORY_BASE_URL" ||
  policy?.semanticReview?.defaultBaseUrl !== "http://127.0.0.1:8085/v1" ||
  policy?.semanticReview?.apiKey !== "local-proxy" ||
  policy?.semanticReview?.profiles?.[0]?.defaultModel !== "claude-opus-4.8" ||
  policy?.semanticReview?.profiles?.[1]?.defaultModel !== "gpt-5.4"
) {
  failures.push("trusted verifier policy identity, binding, or quorum is invalid");
}
if (
  policy?.reviewIdentity?.actor !== "github-actions[bot]" ||
  policy?.reviewIdentity?.appId !== 15368 ||
  policy?.reviewIdentity?.actorId !== 41898282
) {
  failures.push("verifier review actor, user ID, and App ID are not pinned");
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

if (false) {
const workflow = read(".github/workflows/independent-verifier.yml");
if (!workflow) {
  // The independent verifier is retired from the active Actions graph. Keep
  // the legacy policy/runtime checks below for source compatibility only.
} else {
for (const expected of [
  "pull_request_target:",
  "ref: ${{ github.event.pull_request.base.sha }}",
  "ref: refs/pull/${{ github.event.pull_request.number }}/head",
  "path: trusted",
  "path: untrusted",
  "fetch-depth: 0",
  "persist-credentials: false",
  "ONE_CLI_VERIFIER_POLICY_VERSION: one-cli.independent-verifier/v4",
  `ONE_CLI_VERIFIER_POLICY_SHA256: ${policy.workflow.policyHash}`,
  "name: one-cli/independent-verifier",
  "runs-on: [self-hosted, macOS, one-cli-verifier]",
  "Validate preinstalled Node.js toolchain",
  'shell: /bin/bash --noprofile --norc -euo pipefail {0}',
  'expected_path="${ONE_CLI_NODE_BIN:?runner service must define ONE_CLI_NODE_BIN}:$strict_path_suffix"',
  '[[ "$PATH" == "$expected_path" ]]',
  'node_version="$(bounded_version node "$ONE_CLI_NODE_BIN/node")"',
  'npm_version="$(bounded_version npm "$ONE_CLI_NODE_BIN/npm")"',
  "Verifier Node.js must be >=22.13.0 and <25",
  "sleep 10",
  "ONE_CLI_VERIFIER_REPOSITORY_MODEL_A",
  "ONE_CLI_VERIFIER_REPOSITORY_MODEL_B",
  "ONE_CLI_VERIFIER_REPOSITORY_BASE_URL",
  "ONE_CLI_VERIFIER_API_KEY: local-proxy",
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
const workflowDocument = YAML.parse(workflow);
for (const jobName of ["verifier", "merge"]) {
  const steps = workflowDocument?.jobs?.[jobName]?.steps;
  const preflight = steps?.[0];
  if (
    !Array.isArray(steps) ||
    preflight?.name !== "Validate preinstalled Node.js toolchain" ||
    preflight?.shell !== "/bin/bash --noprofile --norc -euo pipefail {0}" ||
    typeof preflight?.run !== "string" ||
    !preflight.run.includes(
      'strict_path_suffix="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"',
    ) ||
    !preflight.run.includes(
      'expected_path="${ONE_CLI_NODE_BIN:?runner service must define ONE_CLI_NODE_BIN}:$strict_path_suffix"',
    ) ||
    !preflight.run.includes('[[ "$PATH" == "$expected_path" ]]') ||
    !preflight.run.includes('node_version="$(bounded_version node "$ONE_CLI_NODE_BIN/node")"') ||
    !preflight.run.includes('npm_version="$(bounded_version npm "$ONE_CLI_NODE_BIN/npm")"') ||
    !preflight.run.includes("sleep 10") ||
    !preflight.run.includes("node_major < 25") ||
    /\b(?:curl|wget|brew|nvm|npm\s+(?:install|ci)|corepack)\b/u.test(preflight.run)
  ) {
    failures.push(`${jobName} must begin with the exact bounded offline host toolchain preflight`);
  }
}
if (
  workflowDocument?.jobs?.verifier?.steps?.[0]?.run !==
  workflowDocument?.jobs?.merge?.steps?.[0]?.run
) {
  failures.push("verifier and merge jobs must use an identical toolchain preflight");
}
const exactPermissions = (actual, expected, label) => {
  if (
    actual === null ||
    typeof actual !== "object" ||
    Array.isArray(actual) ||
    JSON.stringify(Object.keys(actual).sort()) !== JSON.stringify(Object.keys(expected).sort()) ||
    Object.entries(expected).some(([key, value]) => actual[key] !== value)
  ) {
    failures.push(`${label} permissions are not the exact least-privilege set`);
  }
};
exactPermissions(workflowDocument?.permissions, { contents: "read" }, "workflow");
exactPermissions(workflowDocument?.jobs?.verifier?.permissions, {
  contents: "read",
  checks: "read",
  "pull-requests": "write",
}, "verifier job");
exactPermissions(workflowDocument?.jobs?.merge?.permissions, {
  contents: "write",
  checks: "read",
  "pull-requests": "read",
}, "merge job");
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
  "assertTrustedActionsContext",
  'environment.GITHUB_ACTIONS !== "true"',
  'environment.GITHUB_REPOSITORY !== expectedRepository',
  'github.request("GET", "/user", undefined, [403, 404])',
  "actor.id !== policy.reviewIdentity.actorId",
  "verifierModule.verifierPolicyHash(policy)",
  "verifierModule.inspectTrustedVerifier(trustedRoot, policy)",
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
if (/\/installation|\/actions\/permissions/u.test(verifierScript)) {
  failures.push("trusted workflow token must not call installation or administration APIs");
}
const verifierRuntimeSources = [
  harnessIndex,
  read("harness/src/github.ts"),
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
if (
  /process\.argv[\s\S]{0,300}\bapi\b/u.test(verifierRuntimeSources) ||
  /--api-(?:path|endpoint)/u.test(verifierRuntimeSources)
) {
  failures.push("harness exposes a user-controlled generic gh API path");
}
if (/create-github-app-token|ONE_CLI_VERIFIER_APP_PRIVATE_KEY|secrets\./u.test(workflow)) {
  failures.push("independent verifier workflow references a custom App or repository secret");
}
if (/ubuntu-latest|macos-latest/u.test(workflow)) {
  failures.push("independent verifier workflow references retired models or hosted runners");
}
if (/actions\/setup-node|actions\/download-artifact|node-version:|cache-dependency-path:/u.test(workflow)) {
  failures.push("independent verifier workflow may not download or provision a hosted Node toolchain");
}
const workflowActions = [...workflow.matchAll(/^\s*uses:\s*(\S+)/gmu)].map((match) => match[1]);
if (
  workflowActions.length !== 3 ||
  workflowActions.some(
    (action) =>
      action !== "actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5",
  )
) {
  failures.push("independent verifier workflow may use only the pinned checkout action");
}
if (
  workflow.match(/runs-on: \[self-hosted, macOS, one-cli-verifier\]/gu)?.length !== 2
) {
  failures.push("verifier and merge jobs must use only the exact dedicated runner labels");
}
}
}

const activeWorkflows = [read(".github/workflows/autonomy-tick.yml"), read(".github/workflows/verify.yml")];
for (const activeWorkflow of activeWorkflows) {
  if (!/runs-on:\s+ubuntu-latest/u.test(activeWorkflow)) failures.push("active workflow must use GitHub-hosted ubuntu-latest");
  if (/self-hosted|macos-latest|127\.0\.0\.1|launchd/u.test(activeWorkflow)) failures.push("active workflow contains local execution");
}
const autonomyWorkflow = read(".github/workflows/autonomy-tick.yml");
for (const expected of [
  "select-trusted-issue", "build-without-repository-credentials", "verify-generated-change",
  "publish-without-model-credentials", "actions/create-github-app-token@fee1f7d63c2ff003460e3d139729b119787bc349",
  "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
  "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
  "npm run check", "git apply --check", "gh pr merge",
]) if (!autonomyWorkflow.includes(expected)) failures.push(`autonomy workflow lacks ${expected}`);
if (autonomyWorkflow.includes("GH_TOKEN: ${{ github.token }}")) failures.push("model workflow must not receive repository token");

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
  "`runner-health`",
  "`claude-opus-4.8`",
  "`gpt-5.4`",
  "`http://127.0.0.1:8085/v1`",
]) {
  if (!readme.includes(expected)) failures.push(`harness verifier documentation lacks ${expected}`);
}

const runnerBootstrap = read("scripts/bootstrap-verifier-runner.sh");
for (const expected of [
  "Dry run; no files, registration, or services were changed.",
  "ONE_CLI_RUNNER_REGISTRATION_TOKEN",
  "shasum -a 256 --check",
  'REPOSITORY_URL="https://github.com/beforeload/one-cli"',
  'RUNNER_LABEL="one-cli-verifier"',
  'KNOWN_NODE_BIN="/Users/daniel/.nvm/versions/node/v24.14.1/bin"',
  'STRICT_PATH_SUFFIX="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"',
  'ONE_CLI_NODE_BIN="$(cd "$requested_node_bin" && pwd -P)"',
  'NODE_VERSION="$("$NODE_EXECUTABLE" --version)"',
  'NPM_VERSION="$("$NPM_EXECUTABLE" --version)"',
  "Verifier Node.js must be >=22.13.0 and <25",
  "node bin: $ONE_CLI_NODE_BIN",
  "node version: $NODE_VERSION",
  "npm version: $NPM_VERSION",
  "service PATH: $TOOLCHAIN_PATH",
  "} > \"$RUNNER_HOME/.env\"",
  "chmod 600 \"$RUNNER_HOME/.env\"",
  "./svc.sh install",
  "./svc.sh start",
]) {
  if (!runnerBootstrap.includes(expected)) failures.push(`runner bootstrap lacks ${expected}`);
}
if (/(?:printf|echo|cat).*\$ONE_CLI_RUNNER_REGISTRATION_TOKEN/u.test(runnerBootstrap)) {
  failures.push("runner bootstrap may persist or print the registration token");
}
const runnerEnvironmentWrite = runnerBootstrap.indexOf('} > "$RUNNER_HOME/.env"');
if (
  runnerBootstrap.indexOf('unset ONE_CLI_RUNNER_REGISTRATION_TOKEN') > runnerEnvironmentWrite ||
  runnerEnvironmentWrite < 0 ||
  runnerEnvironmentWrite > runnerBootstrap.indexOf("./svc.sh install") ||
  !runnerBootstrap.includes("printf 'ONE_CLI_NODE_BIN=%s\\n' \"$ONE_CLI_NODE_BIN\"") ||
  !runnerBootstrap.includes("printf 'PATH=%s\\n' \"$TOOLCHAIN_PATH\"")
) {
  failures.push("runner bootstrap must write only the strict toolchain environment before service install");
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
