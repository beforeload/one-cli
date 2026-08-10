import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

const SHA = /^[0-9a-f]{40}$/u;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/+\-[\]]{0,255}$/u;

export interface SemanticProfilePolicy {
  readonly id: string;
  readonly modelEnvironment: string;
  readonly repositoryModelEnvironment: string;
  readonly defaultModel: string;
}

export interface IndependentVerifierPolicy {
  readonly schema: "one-cli.independent-verifier/v4";
  readonly repository: {
    readonly owner: string;
    readonly name: string;
    readonly defaultBranch: string;
  };
  readonly workflow: {
    readonly path: ".github/workflows/independent-verifier.yml";
    readonly event: "pull_request_target";
    readonly runnerLabels: readonly ["self-hosted", "macOS", "one-cli-verifier"];
    readonly blobSha: string;
    readonly policyVersion: "one-cli.independent-verifier/v4";
    readonly policyHash: string;
  };
  readonly requiredChecks: readonly {
    readonly name: string;
    readonly appId: number;
  }[];
  readonly emittedCheck: {
    readonly name: "one-cli/independent-verifier";
    readonly appId: 15368;
  };
  readonly reviewIdentity: {
    readonly appId: 15368;
    readonly actor: "github-actions[bot]";
    readonly actorId: 41898282;
  };
  readonly protectedPaths: {
    readonly exact: readonly string[];
    readonly prefixes: readonly string[];
  };
  readonly semanticReview: {
    readonly quorum: 2;
    readonly baseUrlEnvironment: "ONE_CLI_VERIFIER_BASE_URL";
    readonly repositoryBaseUrlEnvironment: "ONE_CLI_VERIFIER_REPOSITORY_BASE_URL";
    readonly defaultBaseUrl: "http://127.0.0.1:8085/v1";
    readonly apiKey: "local-proxy";
    readonly profiles: readonly [SemanticProfilePolicy, SemanticProfilePolicy];
  };
  readonly limits: {
    readonly maxChangedFiles: number;
    readonly maxDiffBytes: number;
    readonly maxModelOutputBytes: number;
    readonly requestTimeoutMs: number;
    readonly verifyWaitMs: number;
  };
  readonly merge: {
    readonly enabled: boolean;
    readonly method: "merge" | "squash" | "rebase";
  };
}

export interface PinnedPull {
  readonly repository: string;
  readonly baseRepository: string;
  readonly baseRef: string;
  readonly baseSha: string;
  readonly headSha: string;
}

export interface TrustedVerifierReadiness {
  readonly schema: "one-cli.harness/verifier-status-v4";
  readonly configured: boolean;
  readonly ready: boolean;
  readonly execution: "trusted-actions-only";
  readonly checkName: string;
  readonly detail: string;
}

export function loadVerifierPolicy(filePath: string): IndependentVerifierPolicy {
  const raw = readBoundedRegularFile(filePath, "verifier policy");
  const root = exactRecord(YAML.parse(raw), [
    "schema",
    "repository",
    "workflow",
    "requiredChecks",
    "emittedCheck",
    "reviewIdentity",
    "protectedPaths",
    "semanticReview",
    "limits",
    "merge",
  ], "verifier policy");
  if (root.schema !== "one-cli.independent-verifier/v4") {
    throw new Error("Verifier policy schema is invalid");
  }
  const repository = exactRecord(root.repository, [
    "owner",
    "name",
    "defaultBranch",
  ], "verifier repository");
  const workflow = exactRecord(
    root.workflow,
    ["path", "event", "runnerLabels", "blobSha", "policyVersion", "policyHash"],
    "verifier workflow",
  );
  if (
    workflow.path !== ".github/workflows/independent-verifier.yml" ||
    workflow.event !== "pull_request_target" ||
    !Array.isArray(workflow.runnerLabels) ||
    workflow.runnerLabels.join("\n") !== ["self-hosted", "macOS", "one-cli-verifier"].join("\n") ||
    typeof workflow.blobSha !== "string" ||
    !SHA.test(workflow.blobSha) ||
    workflow.policyVersion !== "one-cli.independent-verifier/v4" ||
    typeof workflow.policyHash !== "string" ||
    !/^[0-9a-f]{64}$/u.test(workflow.policyHash)
  ) {
    throw new Error("Verifier workflow path, event, blob, or policy version is invalid");
  }
  if (!Array.isArray(root.requiredChecks) || root.requiredChecks.length === 0) {
    throw new Error("Verifier required checks must be a non-empty array");
  }
  const requiredChecks = root.requiredChecks.map((value) => {
    const check = exactRecord(value, ["name", "appId"], "required check");
    return {
      name: safeName(check.name, "required check name"),
      appId: boundedInteger(check.appId, 1, Number.MAX_SAFE_INTEGER, "required check App ID"),
    };
  });
  if (new Set(requiredChecks.map((check) => check.name)).size !== requiredChecks.length) {
    throw new Error("Verifier required check names must be unique");
  }
  const emittedCheck = exactRecord(
    root.emittedCheck,
    ["name", "appId"],
    "emitted check",
  );
  if (
    emittedCheck.name !== "one-cli/independent-verifier" ||
    emittedCheck.appId !== 15368
  ) {
    throw new Error("Emitted verifier check identity is invalid");
  }
  if (
    requiredChecks.length !== 2 ||
    requiredChecks.some((check) => check.appId !== 15368) ||
    !requiredChecks.some((check) => check.name === "verify") ||
    !requiredChecks.some((check) => check.name === emittedCheck.name)
  ) {
    throw new Error("Required checks must be exactly verify and the built-in verifier identity");
  }
  const reviewIdentity = exactRecord(
    root.reviewIdentity,
    ["appId", "actor", "actorId"],
    "review identity",
  );
  const actor = safeName(reviewIdentity.actor, "review actor");
  if (
    reviewIdentity.appId !== 15368 ||
    actor !== "github-actions[bot]" ||
    reviewIdentity.actorId !== 41898282
  ) {
    throw new Error("Review identity must be the built-in GitHub Actions App");
  }
  const protectedPaths = exactRecord(root.protectedPaths, ["exact", "prefixes"], "protected paths");
  const exact = canonicalPaths(stringArray(protectedPaths.exact, "exact protected paths"), false);
  const prefixes = canonicalPaths(stringArray(protectedPaths.prefixes, "protected prefixes"), true);
  const semanticReview = exactRecord(
    root.semanticReview,
    [
      "quorum",
      "baseUrlEnvironment",
      "repositoryBaseUrlEnvironment",
      "defaultBaseUrl",
      "apiKey",
      "profiles",
    ],
    "semantic review policy",
  );
  if (semanticReview.quorum !== 2) throw new Error("Semantic review quorum must be exactly 2");
  if (
    semanticReview.baseUrlEnvironment !== "ONE_CLI_VERIFIER_BASE_URL" ||
    semanticReview.repositoryBaseUrlEnvironment !== "ONE_CLI_VERIFIER_REPOSITORY_BASE_URL" ||
    semanticReview.defaultBaseUrl !== "http://127.0.0.1:8085/v1" ||
    semanticReview.apiKey !== "local-proxy"
  ) {
    throw new Error("Semantic review must use the pinned local OpenAI-compatible proxy");
  }
  if (!Array.isArray(semanticReview.profiles) || semanticReview.profiles.length !== 2) {
    throw new Error("Semantic review requires exactly two profiles");
  }
  const profiles = semanticReview.profiles.map(parseProfile) as [
    SemanticProfilePolicy,
    SemanticProfilePolicy,
  ];
  if (new Set(profiles.map((profile) => profile.id)).size !== 2) {
    throw new Error("Semantic review profile IDs must be independent");
  }
  for (const key of ["modelEnvironment", "repositoryModelEnvironment", "defaultModel"] as const) {
    if (profiles[0][key] === profiles[1][key]) {
      throw new Error(`Semantic review profiles must use distinct ${key} bindings`);
    }
  }
  if (
    profiles[0]?.modelEnvironment !== "ONE_CLI_VERIFIER_MODEL_A" ||
    profiles[0]?.repositoryModelEnvironment !== "ONE_CLI_VERIFIER_REPOSITORY_MODEL_A" ||
    profiles[0]?.defaultModel !== "claude-opus-4.8" ||
    profiles[1]?.modelEnvironment !== "ONE_CLI_VERIFIER_MODEL_B" ||
    profiles[1]?.repositoryModelEnvironment !== "ONE_CLI_VERIFIER_REPOSITORY_MODEL_B" ||
    profiles[1]?.defaultModel !== "gpt-5.4"
  ) {
    throw new Error("Semantic review must pin the two approved local proxy model profiles");
  }
  const limits = exactRecord(root.limits, [
    "maxChangedFiles",
    "maxDiffBytes",
    "maxModelOutputBytes",
    "requestTimeoutMs",
    "verifyWaitMs",
  ], "verifier limits");
  const merge = exactRecord(root.merge, ["enabled", "method"], "verifier merge");
  if (typeof merge.enabled !== "boolean") throw new Error("Verifier merge enabled must be boolean");
  if (merge.method !== "merge" && merge.method !== "squash" && merge.method !== "rebase") {
    throw new Error("Verifier merge method is invalid");
  }
  const policy: IndependentVerifierPolicy = {
    schema: "one-cli.independent-verifier/v4",
    repository: {
      owner: repositorySlug(repository.owner, "repository owner"),
      name: repositorySlug(repository.name, "repository name"),
      defaultBranch: branchName(repository.defaultBranch),
    },
    workflow: {
      path: ".github/workflows/independent-verifier.yml",
      event: "pull_request_target",
      runnerLabels: ["self-hosted", "macOS", "one-cli-verifier"],
      blobSha: workflow.blobSha,
      policyVersion: "one-cli.independent-verifier/v4",
      policyHash: workflow.policyHash,
    },
    requiredChecks,
    emittedCheck: {
      name: "one-cli/independent-verifier",
      appId: 15368,
    },
    reviewIdentity: {
      appId: 15368,
      actor: "github-actions[bot]",
      actorId: 41898282,
    },
    protectedPaths: { exact, prefixes },
    semanticReview: {
      quorum: 2,
      baseUrlEnvironment: "ONE_CLI_VERIFIER_BASE_URL",
      repositoryBaseUrlEnvironment: "ONE_CLI_VERIFIER_REPOSITORY_BASE_URL",
      defaultBaseUrl: "http://127.0.0.1:8085/v1",
      apiKey: "local-proxy",
      profiles,
    },
    limits: {
      maxChangedFiles: boundedInteger(limits.maxChangedFiles, 1, 1_000, "changed-file limit"),
      maxDiffBytes: boundedInteger(limits.maxDiffBytes, 1_024, 16 * 1024 * 1024, "diff byte limit"),
      maxModelOutputBytes: boundedInteger(
        limits.maxModelOutputBytes,
        256,
        64 * 1024,
        "model output limit",
      ),
      requestTimeoutMs: boundedInteger(
        limits.requestTimeoutMs,
        1_000,
        5 * 60_000,
        "request timeout",
      ),
      verifyWaitMs: boundedInteger(limits.verifyWaitMs, 0, 30 * 60_000, "verify wait"),
    },
    merge: { enabled: merge.enabled, method: merge.method },
  };
  if (verifierPolicyHash(policy) !== policy.workflow.policyHash) {
    throw new Error("Verifier policy hash does not match its canonical trusted fields");
  }
  return policy;
}

export function verifierPolicyHash(policy: IndependentVerifierPolicy): string {
  const canonical = {
    schema: policy.schema,
    repository: policy.repository,
    workflow: {
      path: policy.workflow.path,
      event: policy.workflow.event,
      runnerLabels: policy.workflow.runnerLabels,
      policyVersion: policy.workflow.policyVersion,
    },
    requiredChecks: policy.requiredChecks,
    emittedCheck: policy.emittedCheck,
    reviewIdentity: policy.reviewIdentity,
    protectedPaths: policy.protectedPaths,
    semanticReview: policy.semanticReview,
    limits: policy.limits,
    merge: policy.merge,
  };
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function validatePinnedPull(
  policy: IndependentVerifierPolicy,
  pull: PinnedPull,
): void {
  const expectedRepository = `${policy.repository.owner}/${policy.repository.name}`;
  if (pull.repository !== expectedRepository || pull.baseRepository !== expectedRepository) {
    throw new Error("Pull request is not bound to the pinned base repository");
  }
  if (pull.baseRef !== policy.repository.defaultBranch) {
    throw new Error("Pull request does not target the pinned default branch");
  }
  exactSha(pull.baseSha, "pull base SHA");
  exactSha(pull.headSha, "pull head SHA");
  if (pull.baseSha === pull.headSha) throw new Error("Pull base and head SHAs must differ");
}

export function isProtectedPath(
  policy: IndependentVerifierPolicy,
  candidate: string,
): boolean {
  const checked = repositoryPath(candidate, false);
  return policy.protectedPaths.exact.includes(checked) ||
    policy.protectedPaths.prefixes.some((prefix) => checked.startsWith(prefix));
}

export function inspectTrustedVerifier(
  workspace: string,
  policy: IndependentVerifierPolicy,
): TrustedVerifierReadiness {
  const workflowPath = path.join(workspace, policy.workflow.path);
  let detail = "Trusted pull_request_target verifier workflow and policy are present";
  let ready = true;
  try {
    const workflow = readBoundedRegularFile(workflowPath, "independent verifier workflow");
    for (const expected of [
      "pull_request_target:",
      "persist-credentials: false",
      "scripts/independent-verifier.mjs",
      "one-cli/independent-verifier",
      "runs-on: [self-hosted, macOS, one-cli-verifier]",
      "ONE_CLI_VERIFIER_REPOSITORY_BASE_URL",
      "ONE_CLI_VERIFIER_API_KEY: local-proxy",
      `ONE_CLI_VERIFIER_POLICY_VERSION: ${policy.workflow.policyVersion}`,
      `ONE_CLI_VERIFIER_POLICY_SHA256: ${policy.workflow.policyHash}`,
    ]) {
      if (!workflow.includes(expected)) throw new Error(`workflow lacks ${expected}`);
    }
    for (const rejected of ["ubuntu-latest", "macos-latest"]) {
      if (workflow.includes(rejected)) throw new Error(`workflow contains retired verifier setting ${rejected}`);
    }
    const blobSha = crypto
      .createHash("sha1")
      .update(`blob ${Buffer.byteLength(workflow)}\0`)
      .update(workflow)
      .digest("hex");
    if (blobSha !== policy.workflow.blobSha) {
      throw new Error("local independent verifier workflow blob does not match policy");
    }
  } catch (error) {
    ready = false;
    detail = error instanceof Error ? error.message : String(error);
  }
  return {
    schema: "one-cli.harness/verifier-status-v4",
    configured: true,
    ready,
    execution: "trusted-actions-only",
    checkName: policy.emittedCheck.name,
    detail,
  };
}

function parseProfile(value: unknown): SemanticProfilePolicy {
  const profile = exactRecord(value, [
    "id",
    "modelEnvironment",
    "repositoryModelEnvironment",
    "defaultModel",
  ], "semantic profile");
  return {
    id: safeName(profile.id, "semantic profile ID"),
    modelEnvironment: environmentName(profile.modelEnvironment, "profile model environment"),
    repositoryModelEnvironment: environmentName(
      profile.repositoryModelEnvironment,
      "profile repository model environment",
    ),
    defaultModel: safeName(profile.defaultModel, "profile default model"),
  };
}

function readBoundedRegularFile(filePath: string, label: string): string {
  const absolute = path.resolve(filePath);
  const before = fs.lstatSync(absolute);
  if (before.isSymbolicLink() || !before.isFile() || before.size > 1024 * 1024) {
    throw new Error(`${label} must be a bounded non-symlink regular file`);
  }
  const descriptor = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size
    ) {
      throw new Error(`${label} changed while opening`);
    }
    return fs.readFileSync(descriptor, "utf8");
  } finally {
    fs.closeSync(descriptor);
  }
}

function exactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const object = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(object).sort()) !== JSON.stringify([...keys].sort())) {
    throw new Error(`${label} must contain exactly the approved fields`);
  }
  return object;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every((item) => typeof item === "string")) {
    throw new Error(`${label} must be a non-empty string array`);
  }
  return value;
}

function canonicalPaths(values: readonly string[], prefix: boolean): readonly string[] {
  const checked = values.map((value) => repositoryPath(value, prefix));
  if (new Set(checked).size !== checked.length) throw new Error("Protected paths contain duplicates");
  return [...checked].sort();
}

function repositoryPath(value: string, prefix: boolean): string {
  const partsValue = prefix && value.endsWith("/") ? value.slice(0, -1) : value;
  if (
    !value ||
    value.length > 512 ||
    value.startsWith("/") ||
    value.startsWith("-") ||
    value.includes("\\") ||
    /[\0\r\n]/u.test(value) ||
    partsValue.split("/").some((part) => !part || part === "." || part === "..") ||
    (prefix ? !value.endsWith("/") : value.endsWith("/"))
  ) {
    throw new Error("Protected path must be canonical and repository-relative");
  }
  return value;
}

function repositorySlug(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.-]+$/u.test(value) || value === "." || value === "..") {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function branchName(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.startsWith("-") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    /[\0\r\n~^:?*[\\]/u.test(value)
  ) {
    throw new Error("Default branch name is invalid");
  }
  return value;
}

function safeName(value: unknown, label: string): string {
  if (typeof value !== "string" || !SAFE_NAME.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function environmentName(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Z][A-Z0-9_]{2,127}$/u.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function boundedInteger(value: unknown, minimum: number, maximum: number, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function exactSha(value: string, label: string): void {
  if (!SHA.test(value)) throw new Error(`${label} must be an exact lowercase 40-character SHA`);
}
