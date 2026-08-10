#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const SHA = /^[0-9a-f]{40}$/u;
const MAX_API_BYTES = 4 * 1024 * 1024;

export async function main(argv = process.argv.slice(2), environment = process.env) {
  const options = parseOptions(argv);
  const trustedRoot = canonicalDirectory(options.trustedRoot, "trusted root");
  const verifierModule = await import(pathToFileURL(
    path.join(trustedRoot, "harness", "dist", "verifier.js"),
  ).href);
  const policy = verifierModule.loadVerifierPolicy(path.join(trustedRoot, options.policy));
  const event = readEvent(options.event);
  const binding = eventBinding(event);
  verifierModule.validatePinnedPull(policy, binding);
  assertCheckout(trustedRoot, binding.baseSha, "trusted default-branch checkout");
  if (options.merge) {
    const github = githubClient(environment, policy);
    assertTrustedWorkflowPins(verifierModule, trustedRoot, policy, environment);
    await assertTrustedActionsContext(
      github,
      policy,
      binding,
      environment,
    );
    await waitForPinnedChecks(github, policy, binding, policy.requiredChecks, environment);
    await assertMergePreconditions(github, policy, binding, environment);
    await mergeExactHead(github, policy, binding);
    process.stdout.write(`${JSON.stringify({
      schema: "one-cli.independent-verifier/merge-v4",
      merged: true,
      pullNumber: binding.pullNumber,
      baseSha: binding.baseSha,
      headSha: binding.headSha,
    })}\n`);
    return 0;
  }

  const untrustedRoot = canonicalDirectory(options.untrustedRoot, "untrusted root");
  if (trustedRoot === untrustedRoot || isWithin(trustedRoot, untrustedRoot) || isWithin(untrustedRoot, trustedRoot)) {
    throw new Error("Trusted and untrusted checkouts must be separate roots");
  }
  const reviewModule = await import(pathToFileURL(
    path.join(trustedRoot, "harness", "dist", "verifier-review.js"),
  ).href);
  assertCheckout(untrustedRoot, binding.headSha, "untrusted pull-request checkout");
  assertGitObject(untrustedRoot, binding.baseSha);
  assertGitObject(untrustedRoot, binding.headSha);
  const changedPaths = changedPathInventory(
    untrustedRoot,
    binding.baseSha,
    binding.headSha,
    policy.limits.maxChangedFiles,
  );
  if (changedPaths.length === 0) throw new Error("Pull request has no exact base/head changes");
  const protectedChange = changedPaths.some((candidate) =>
    verifierModule.isProtectedPath(policy, candidate)
  );
  const fullDiff = exactDiff(untrustedRoot, binding.baseSha, binding.headSha, policy.limits.maxDiffBytes);
  if (!options.verify) {
    process.stdout.write(`${JSON.stringify({
      schema: "one-cli.independent-verifier/inspection-v4",
      applied: false,
      pullNumber: binding.pullNumber,
      baseRef: binding.baseRef,
      baseSha: binding.baseSha,
      headSha: binding.headSha,
      changedPaths,
      protectedChange,
      fullDiffBytes: Buffer.byteLength(fullDiff),
      note: "Dry-run inspection cannot publish reviews or merge",
    }, null, 2)}\n`);
    return 0;
  }

  const github = githubClient(environment, policy);
  assertTrustedWorkflowPins(verifierModule, trustedRoot, policy, environment);
  await assertTrustedActionsContext(
    github,
    policy,
    binding,
    environment,
  );
  const marker = operationMarker(binding);
  try {
    const prerequisiteChecks = policy.requiredChecks.filter((check) =>
      check.name !== policy.emittedCheck.name
    );
    await waitForPinnedChecks(github, policy, binding, prerequisiteChecks, environment);
    const semantic = await semanticReviews(
      policy,
      binding,
      changedPaths,
      fullDiff,
      reviewModule,
      environment,
    );
    const quorum = reviewModule.requireTwoProfileVetoQuorum(
      policy.semanticReview.profiles.map((profile) => profile.id),
      semantic,
    );
    if (!quorum.eligible) {
      const summary = boundedSummary(marker, {
        result: "changes_requested",
        baseSha: binding.baseSha,
        headSha: binding.headSha,
        protectedChange,
        semanticVetoes: quorum.vetoes.map((result) => ({
          profile: result.profile,
          findings: result.findings,
          summary: result.summary,
        })),
      });
      await submitFinalReview(
        github,
        policy,
        binding,
        marker,
        "REQUEST_CHANGES",
        summary,
        prerequisiteChecks,
        environment,
      );
      return 1;
    }
    const summary = boundedSummary(marker, {
      result: "eligible",
      baseSha: binding.baseSha,
      headSha: binding.headSha,
      requiredChecks: policy.requiredChecks,
      changedPaths,
      protectedChange,
      semanticProfiles: semantic.map((result) => ({
        profile: result.profile,
        veto: result.veto,
        summary: result.summary,
      })),
    });
    await submitFinalReview(
      github,
      policy,
      binding,
      marker,
      "APPROVE",
      summary,
      prerequisiteChecks,
      environment,
    );
    process.stdout.write(`${JSON.stringify({
      schema: "one-cli.independent-verifier/result-v4",
      applied: true,
      pullNumber: binding.pullNumber,
      baseSha: binding.baseSha,
      headSha: binding.headSha,
      protectedChange,
      conclusion: "success",
    })}\n`);
    return 0;
  } catch (error) {
    const summary = boundedSummary(marker, {
      result: "failure",
      baseSha: binding.baseSha,
      headSha: binding.headSha,
      detail: safeError(error),
    });
    const prerequisiteChecks = policy.requiredChecks.filter((check) =>
      check.name !== policy.emittedCheck.name
    );
    await submitFinalReview(
      github,
      policy,
      binding,
      marker,
      "REQUEST_CHANGES",
      summary,
      prerequisiteChecks,
      environment,
    )
      .catch((reviewError) => {
        process.stderr.write(`Unable to publish fail-closed review: ${safeError(reviewError)}\n`);
      });
    throw error;
  }
}

function parseOptions(argv) {
  let event;
  let trustedRoot;
  let untrustedRoot;
  let policy = "harness/verifier-policy.yml";
  let verify = false;
  let merge = false;
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === "--event") event = requiredArg(argv, ++index, value);
    else if (value === "--trusted-root") trustedRoot = requiredArg(argv, ++index, value);
    else if (value === "--untrusted-root") untrustedRoot = requiredArg(argv, ++index, value);
    else if (value === "--policy") policy = requiredArg(argv, ++index, value);
    else if (value === "--verify") verify = true;
    else if (value === "--merge") merge = true;
    else if (value === "--dry-run") verify = false;
    else throw new Error(`Unknown verifier option: ${value}`);
  }
  if (!event || !trustedRoot || (!merge && !untrustedRoot)) {
    throw new Error("--event, --trusted-root, and verification --untrusted-root are required");
  }
  if (verify && merge) throw new Error("--verify and --merge are mutually exclusive");
  if (path.isAbsolute(policy) || policy.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("--policy must be a canonical trusted-root-relative path");
  }
  return {
    event: path.resolve(event),
    trustedRoot: path.resolve(trustedRoot),
    untrustedRoot: untrustedRoot === undefined ? undefined : path.resolve(untrustedRoot),
    policy,
    verify,
    merge,
  };
}

function eventBinding(event) {
  if (event.action === "closed") throw new Error("Closed pull requests are not verifiable");
  const repository = record(event.repository, "event repository");
  const pull = record(event.pull_request, "pull request event");
  const base = record(pull.base, "pull request base");
  const head = record(pull.head, "pull request head");
  const baseRepository = record(base.repo, "pull request base repository");
  return {
    pullNumber: positiveInteger(pull.number, "pull request number"),
    repository: nonEmptyString(repository.full_name, "event repository name"),
    baseRepository: nonEmptyString(baseRepository.full_name, "base repository name"),
    baseRef: nonEmptyString(base.ref, "pull request base ref"),
    baseSha: exactSha(nonEmptyString(base.sha, "pull request base SHA")),
    headSha: exactSha(nonEmptyString(head.sha, "pull request head SHA")),
  };
}

function assertCheckout(root, expectedSha, label) {
  const observed = git(root, ["rev-parse", "--verify", "HEAD^{commit}"], 128).trim();
  if (observed !== expectedSha) throw new Error(`${label} is not at the exact pinned SHA`);
}

function assertGitObject(root, sha) {
  git(root, ["cat-file", "-e", `${sha}^{commit}`], 0);
}

function changedPathInventory(root, baseSha, headSha, maxFiles) {
  const value = gitBuffer(
    root,
    ["diff", "--name-only", "-z", "--no-renames", baseSha, headSha, "--"],
    1024 * 1024,
  );
  const paths = value.toString("utf8").split("\0").filter(Boolean).map(repositoryPath);
  const canonical = [...new Set(paths)].sort();
  if (canonical.length !== paths.length) throw new Error("Exact changed-path inventory is ambiguous");
  if (canonical.length > maxFiles) throw new Error("Changed-file inventory exceeds its strict bound");
  return canonical;
}

function exactDiff(root, baseSha, headSha, maxBytes) {
  const bytes = gitBuffer(root, [
    "diff",
    "--binary",
    "--full-index",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    baseSha,
    headSha,
    "--",
  ], maxBytes);
  if (bytes.length === 0) throw new Error("Protected pull request exact diff is empty");
  if (bytes.includes(0)) throw new Error("Protected pull request diff contains a NUL byte");
  return bytes.toString("utf8");
}

async function waitForPinnedChecks(
  github,
  policy,
  binding,
  requiredChecks,
  environment,
  overrideWaitMs,
) {
  const waitMs = overrideWaitMs ?? numericEnvironment(
    environment,
    "ONE_CLI_VERIFY_WAIT_MS",
    policy.limits.verifyWaitMs,
  );
  const deadline = Date.now() + waitMs;
  while (true) {
    const response = record(
      await github.request(
        "GET",
        `/repos/${binding.repository}/commits/${binding.headSha}/check-runs?per_page=100`,
      ),
      "check-runs response",
    );
    if (!Array.isArray(response.check_runs)) throw new Error("Check-run inventory is malformed");
    const total = nonNegativeInteger(response.total_count, "check-run count");
    if (total !== response.check_runs.length || total >= 100) {
      throw new Error("Check-run inventory is truncated or exceeds its strict bound");
    }
    const pending = [];
    for (const required of requiredChecks) {
      const matches = response.check_runs.filter((candidate) => {
        const check = record(candidate, "required check");
        const app = record(check.app, "required check App");
        return check.name === required.name &&
          app.id === required.appId &&
          check.head_sha === binding.headSha;
      });
      if (matches.length !== 1) {
        throw new Error(`Required check ${required.name} is missing, duplicated, or has wrong provenance`);
      }
      const check = record(matches[0], "required check");
      if (check.status !== "completed") pending.push(required.name);
      else if (check.conclusion !== "success") {
        throw new Error(`Required check ${required.name} did not succeed`);
      }
    }
    if (pending.length === 0) return;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for required checks: ${pending.join(", ")}`);
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(10_000, deadline - Date.now())));
  }
}

async function semanticReviews(policy, binding, changedPaths, diff, reviewModule, environment) {
  const token = requiredEnvironment(environment, policy.semanticReview.tokenEnvironment);
  const baseUrl = httpsOrigin(policy.semanticReview.baseUrl);
  const configured = policy.semanticReview.profiles.map((profile) => ({
    profile,
    model: optionalEnvironment(environment, profile.modelEnvironment, profile.defaultModel),
  }));
  if (configured[0].model === configured[1].model) {
    throw new Error("Semantic verifier profiles must use two distinct GitHub Models IDs");
  }
  const prompt = reviewModule.semanticVetoPrompt({
    repository: binding.repository,
    pullNumber: binding.pullNumber,
    baseSha: binding.baseSha,
    headSha: binding.headSha,
    changedPaths,
    diff,
  });
  return await Promise.all(configured.map(async ({ profile, model }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), policy.limits.requestTimeoutMs);
    try {
      const response = await fetch(new URL("chat/completions", baseUrl), {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [{ role: "user", content: prompt }],
        }),
      });
      const payload = await boundedJson(response, policy.limits.maxModelOutputBytes, "semantic model");
      if (!response.ok) throw new Error(`Semantic profile ${profile.id} returned HTTP ${response.status}`);
      const root = record(payload, "semantic model response");
      if (!Array.isArray(root.choices) || root.choices.length !== 1) {
        throw new Error(`Semantic profile ${profile.id} returned an invalid choice inventory`);
      }
      const choice = record(root.choices[0], "semantic model choice");
      const message = record(choice.message, "semantic model message");
      const content = nonEmptyString(message.content, "semantic model content");
      let parsed;
      try {
        parsed = JSON.parse(content);
      } catch {
        throw new Error(`Semantic profile ${profile.id} returned malformed JSON`);
      }
      return reviewModule.parseSemanticVeto(profile.id, parsed);
    } finally {
      clearTimeout(timer);
    }
  }));
}

async function revalidatePull(github, policy, binding, requireMergeable = false) {
  const expectedRepository = `${policy.repository.owner}/${policy.repository.name}`;
  if (
    binding.repository !== expectedRepository ||
    binding.baseRepository !== expectedRepository ||
    binding.baseRef !== policy.repository.defaultBranch
  ) {
    throw new Error("Pinned event repository or default branch differs from verifier policy");
  }
  const repository = record(
    await github.request("GET", `/repos/${binding.repository}`),
    "current repository",
  );
  if (
    repository.full_name !== expectedRepository ||
    repository.default_branch !== policy.repository.defaultBranch
  ) {
    throw new Error("Repository identity or default branch changed before privileged verifier write");
  }
  const current = record(
    await github.request("GET", `/repos/${binding.repository}/pulls/${binding.pullNumber}`),
    "current pull request",
  );
  const base = record(current.base, "current pull base");
  const head = record(current.head, "current pull head");
  const baseRepository = record(base.repo, "current base repository");
  const currentBinding = {
    repository: expectedRepository,
    baseRepository: nonEmptyString(baseRepository.full_name, "current base repository"),
    baseRef: nonEmptyString(base.ref, "current base ref"),
    baseSha: exactSha(nonEmptyString(base.sha, "current base SHA")),
    headSha: exactSha(nonEmptyString(head.sha, "current head SHA")),
  };
  if (
    currentBinding.repository !== binding.repository ||
    currentBinding.baseRepository !== expectedRepository ||
    currentBinding.baseRef !== policy.repository.defaultBranch ||
    currentBinding.baseSha !== binding.baseSha ||
    currentBinding.headSha !== binding.headSha ||
    current.state !== "open" ||
    current.draft === true ||
    (requireMergeable && current.mergeable !== true)
  ) {
    throw new Error("Pull request binding changed before privileged verifier write");
  }
  const branch = record(
    await github.request(
      "GET",
      `/repos/${binding.repository}/branches/${
        encodeURIComponent(binding.baseRef)
      }`,
    ),
    "current default branch",
  );
  const branchCommit = record(branch.commit, "current default branch head");
  if (
    branch.name !== policy.repository.defaultBranch ||
    branchCommit.sha !== binding.baseSha
  ) {
    throw new Error("Default branch advanced after verification; a new workflow run is required");
  }
}

function assertTrustedWorkflowPins(verifierModule, trustedRoot, policy, environment) {
  if (
    requiredEnvironment(environment, "ONE_CLI_VERIFIER_POLICY_VERSION") !==
      policy.workflow.policyVersion ||
    requiredEnvironment(environment, "ONE_CLI_VERIFIER_POLICY_SHA256") !==
      policy.workflow.policyHash ||
    verifierModule.verifierPolicyHash(policy) !== policy.workflow.policyHash
  ) {
    throw new Error("Trusted workflow policy version or hash does not match the loaded policy");
  }
  const readiness = verifierModule.inspectTrustedVerifier(trustedRoot, policy);
  if (readiness.ready !== true) {
    throw new Error(`Trusted workflow blob or policy pin is invalid: ${readiness.detail}`);
  }
}

export async function assertTrustedActionsContext(github, policy, binding, environment) {
  const expectedRepository = `${policy.repository.owner}/${policy.repository.name}`;
  if (
    environment.GITHUB_ACTIONS !== "true" ||
    environment.GITHUB_REPOSITORY !== expectedRepository ||
    environment.GITHUB_REPOSITORY !== binding.repository ||
    environment.GITHUB_EVENT_NAME !== policy.workflow.event
  ) {
    throw new Error("Applied verifier is not running in the exact trusted GitHub Actions context");
  }
  const identity = await github.request("GET", "/user", undefined, [403, 404]);
  if (identity === undefined) return;
  const actor = record(identity, "workflow token actor");
  if (
    actor.login !== policy.reviewIdentity.actor ||
    actor.id !== policy.reviewIdentity.actorId ||
    actor.type !== "Bot"
  ) {
    throw new Error("Workflow token actor does not match the pinned GitHub Actions bot");
  }
}

async function submitFinalReview(
  github,
  policy,
  binding,
  marker,
  event,
  body,
  requiredChecks,
  environment,
) {
  await waitForPinnedChecks(
    github,
    policy,
    binding,
    requiredChecks,
    environment,
    0,
  );
  await submitBoundReview(
    github,
    policy,
    binding,
    marker,
    event,
    body,
    () => revalidatePull(github, policy, binding),
  );
}

async function submitBoundReview(
  github,
  policy,
  binding,
  marker,
  event,
  body,
  beforeReview,
) {
  const reviews = await github.request(
    "GET",
    `/repos/${binding.repository}/pulls/${binding.pullNumber}/reviews?per_page=100`,
  );
  if (!Array.isArray(reviews) || reviews.length >= 100) {
    throw new Error("Pull review inventory is malformed or exceeds its strict bound");
  }
  const matches = reviews.filter((candidate) => {
    const review = record(candidate, "pull review");
    return typeof review.body === "string" && review.body.includes(marker);
  });
  if (matches.length > 1) throw new Error("Duplicate exact verifier reviews exist");
  const expectedState = event === "APPROVE" ? "APPROVED" : "CHANGES_REQUESTED";
  if (matches[0]) {
    const review = record(matches[0], "existing verifier review");
    const actor = record(review.user, "existing review actor");
    if (
      review.commit_id !== binding.headSha ||
      review.state !== expectedState ||
      review.body !== body ||
      actor.login !== policy.reviewIdentity.actor ||
      actor.type !== "Bot"
    ) {
      throw new Error("Existing verifier review conflicts with the exact operation");
    }
    await beforeReview();
    return;
  }
  await beforeReview();
  const created = record(await github.request(
    "POST",
    `/repos/${binding.repository}/pulls/${binding.pullNumber}/reviews`,
    { commit_id: binding.headSha, event, body },
  ), "created pull review");
  const actor = record(created.user, "created review actor");
  if (
    created.commit_id !== binding.headSha ||
    actor.login !== policy.reviewIdentity.actor ||
    actor.type !== "Bot"
  ) {
    throw new Error("Created review is not bound to the pinned verifier actor and SHA");
  }
}

export async function assertBoundApproval(github, policy, binding) {
  const reviews = await github.request(
    "GET",
    `/repos/${binding.repository}/pulls/${binding.pullNumber}/reviews?per_page=100`,
  );
  if (!Array.isArray(reviews) || reviews.length >= 100) {
    throw new Error("Pull review inventory is malformed or exceeds its strict bound");
  }
  const marker = operationMarker(binding);
  const matches = reviews.filter((candidate) => {
    const review = record(candidate, "pull review");
    const actor = record(review.user, "review actor");
    return review.state === "APPROVED" &&
      review.commit_id === binding.headSha &&
      actor.login === policy.reviewIdentity.actor &&
      actor.type === "Bot" &&
      typeof review.body === "string" &&
      review.body.includes(marker);
  });
  if (matches.length !== 1) {
    throw new Error("Exact head lacks one pinned github-actions[bot] approval");
  }
}

export async function assertMergePreconditions(
  github,
  policy,
  binding,
  environment = {},
) {
  await waitForPinnedChecks(
    github,
    policy,
    binding,
    policy.requiredChecks,
    environment,
    0,
  );
  await assertBoundApproval(github, policy, binding);
  const comparison = record(
    await github.request(
      "GET",
      `/repos/${binding.repository}/compare/${binding.baseSha}...${binding.headSha}`,
    ),
    "base/head comparison",
  );
  const mergeBase = record(comparison.merge_base_commit, "merge-base commit");
  if (mergeBase.sha !== binding.baseSha) {
    throw new Error("Pull request head is not exactly up to date with the verified base");
  }
  await revalidatePull(github, policy, binding, true);
}

async function mergeExactHead(github, policy, binding) {
  const response = record(await github.request(
    "PUT",
    `/repos/${binding.repository}/pulls/${binding.pullNumber}/merge`,
    { sha: binding.headSha, merge_method: policy.merge.method },
  ), "merge response");
  if (response.merged !== true || !SHA.test(response.sha)) {
    throw new Error("GitHub did not merge the exact independently verified head");
  }
}

function operationMarker(binding) {
  return `one-cli-independent-verifier:v4:${binding.pullNumber}:${binding.baseSha}:${binding.headSha}`;
}

function boundedSummary(marker, value) {
  const summary = `${marker}\n\n${JSON.stringify(value, null, 2)}`;
  if (Buffer.byteLength(summary) > 60 * 1024) throw new Error("Verifier summary exceeds its bound");
  return summary;
}

class GitHubApi {
  constructor(token, baseUrl, timeoutMs) {
    this.token = token;
    this.baseUrl = httpsOrigin(baseUrl);
    this.timeoutMs = timeoutMs;
  }

  async request(method, apiPath, body, allowedStatuses = []) {
    if (!apiPath.startsWith("/") || apiPath.startsWith("//") || /[\0\r\n]/u.test(apiPath)) {
      throw new Error("GitHub API path is invalid");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(new URL(apiPath, this.baseUrl), {
        method,
        redirect: "error",
        signal: controller.signal,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
          "User-Agent": "one-cli-independent-verifier",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const value = await boundedJson(response, MAX_API_BYTES, "GitHub API");
      if (!response.ok) {
        if (allowedStatuses.includes(response.status)) return undefined;
        throw new Error(`GitHub API ${method} ${apiPath} returned HTTP ${response.status}`);
      }
      return value;
    } finally {
      clearTimeout(timer);
    }
  }
}

function githubClient(environment, policy) {
  return new GitHubApi(
    requiredEnvironment(environment, "GITHUB_TOKEN"),
    environment.GITHUB_API_URL ?? "https://api.github.com",
    policy.limits.requestTimeoutMs,
  );
}

async function boundedJson(response, maxBytes, label) {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) throw new Error(`${label} response is oversized`);
  if (response.body === null) return null;
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    total += result.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`${label} response is oversized`);
    }
    chunks.push(Buffer.from(result.value));
  }
  const bytes = Buffer.concat(chunks, total);
  if (bytes.length > maxBytes) throw new Error(`${label} response is oversized`);
  if (bytes.length === 0) return null;
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} returned malformed JSON`);
  }
}

function git(root, args, maxBytes) {
  return gitBuffer(root, args, maxBytes).toString("utf8");
}

function gitBuffer(root, args, maxBytes) {
  const result = spawnSync("git", args, {
    cwd: root,
    env: {
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      HOME: "/dev/null",
      LANG: "C",
      LC_ALL: "C",
      PATH: process.env.PATH ?? "/usr/bin:/bin",
    },
    encoding: null,
    maxBuffer: maxBytes + 1,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    if (result.error.code === "ENOBUFS") throw new Error("Git evidence exceeds its strict byte bound");
    throw new Error(`Git evidence command failed: ${safeError(result.error)}`);
  }
  if (result.status !== 0) {
    throw new Error(`Git evidence command exited ${result.status}`);
  }
  const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.alloc(0);
  if (stdout.length > maxBytes) throw new Error("Git evidence exceeds its strict byte bound");
  return stdout;
}

function readEvent(filePath) {
  const before = fs.lstatSync(filePath);
  if (before.isSymbolicLink() || !before.isFile() || before.size > 2 * 1024 * 1024) {
    throw new Error("GitHub event must be a bounded non-symlink regular file");
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function canonicalDirectory(candidate, label) {
  const before = fs.lstatSync(candidate);
  if (before.isSymbolicLink() || !before.isDirectory()) throw new Error(`${label} must be a real directory`);
  const canonical = fs.realpathSync(candidate);
  if (canonical !== path.resolve(candidate)) throw new Error(`${label} must be canonical`);
  return canonical;
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function httpsOrigin(value) {
  const parsed = new URL(value);
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("Remote endpoint must be a credential-free HTTPS URL");
  }
  if (!parsed.pathname.endsWith("/")) parsed.pathname += "/";
  return parsed;
}

function repositoryPath(value) {
  if (
    !value ||
    value.startsWith("/") ||
    value.startsWith("-") ||
    value.endsWith("/") ||
    value.includes("\\") ||
    /[\0\r\n]/u.test(value) ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("Git changed path is not canonical and repository-relative");
  }
  return value;
}

function requiredEnvironment(environment, name) {
  const value = environment[name];
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    throw new Error(`${name} is required for applied trusted verification`);
  }
  return value;
}

function optionalEnvironment(environment, name, fallback) {
  const value = environment[name];
  if (value === undefined || value === "") return fallback;
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function numericEnvironment(environment, name, fallback) {
  if (environment[name] === undefined) return fallback;
  const value = Number(environment[name]);
  if (!Number.isSafeInteger(value) || value < 0 || value > 30 * 60_000) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function exactSha(value) {
  if (!SHA.test(value)) throw new Error("Expected an exact lowercase 40-character SHA");
  return value;
}

function positiveInteger(value, label) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function nonNegativeInteger(value, label) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function nonEmptyString(value, label) {
  if (typeof value !== "string" || !value || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty NUL-free string`);
  }
  return value;
}

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requiredArg(argv, index, flag) {
  const value = argv[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function safeError(error) {
  const detail = error instanceof Error ? error.message : String(error);
  return detail.replace(/Bearer\s+\S+/gu, "Bearer [REDACTED]").slice(0, 2_000);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main();
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      schema: "one-cli.independent-verifier/error-v4",
      error: safeError(error),
    })}\n`);
    process.exitCode = 1;
  }
}
