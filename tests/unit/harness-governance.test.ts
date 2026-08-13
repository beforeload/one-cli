import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { GhGovernanceReadinessPort } from "../../harness/src/governance.js";
import { HostJournal } from "../../harness/src/host.js";
import { automaticLanes } from "../../harness/src/index.js";
import type {
  ProcessRequest,
  ProcessResult,
  ProcessRunner,
} from "../../harness/src/runner.js";
import { loadVerifierPolicy } from "../../harness/src/verifier.js";
import { makeTempDir, removeTempDir } from "../helpers.js";

const ROOT = path.resolve(import.meta.dirname, "../..");
const POLICY = loadVerifierPolicy(path.join(ROOT, "harness/verifier-policy.yml"));
const WORKFLOW = [
  "name: independent-verifier",
  "on:",
  "  pull_request_target:",
  "ONE_CLI_VERIFIER_POLICY_VERSION: one-cli.independent-verifier/v4",
  `ONE_CLI_VERIFIER_POLICY_SHA256: ${POLICY.workflow.policyHash}`,
].join("\n");
const RELEASE = {
  bootstrap: false,
  sha: "a".repeat(40),
  entrypoint: "/immutable/release/dist/index.js",
  entrypointSha256: "b".repeat(64),
  manifestSha256: "c".repeat(64),
  moduleHashes: {
    "dist/index.js": "b".repeat(64),
    "dist/autonomy/worker.js": "d".repeat(64),
  },
} as const;

describe("live governance readiness gate", () => {
  it("blocks roadmap product #7 under the old protection with zero product calls", async () => {
    const root = makeTempDir("governance-old-protection");
    try {
      const readiness = port(oldProtection());
      const journal = new HostJournal(path.join(root, "journal.jsonl"));
      const product = { tick: vi.fn(async () => ({
        action: "issue-7",
        state: "idle",
        phase: "roadmap" as const,
        detail: "would execute",
      })) };
      const lanes = automaticLanes(
        readiness,
        product,
        { tick: async () => ({ action: "verifier", state: "idle", detail: "ok" }) },
        journal,
      );

      await expect(lanes.tick()).resolves.toMatchObject({
        action: "governance-readiness",
        state: "blocked",
        detail: expect.stringContaining("protection-strict"),
      });
      expect(product.tick).not.toHaveBeenCalled();
    } finally {
      removeTempDir(root);
    }
  });

  it("allows the product lane only when every live invariant is ready", async () => {
    const root = makeTempDir("governance-ready");
    try {
      const readiness = port(readyProtection());
      const inspected = await readiness.inspect();
      expect(inspected).toMatchObject({ ready: true });
      expect(inspected.checks).toEqual(expect.arrayContaining([
        {
          name: "builder-keyring-auth",
          ok: true,
          detail: "canonical gh executable and config authenticated without exported tokens",
        },
        {
          name: "builder-login",
          ok: true,
          detail: "authenticated host builder login is exactly beforeload",
        },
        {
          name: "worker-tool-policy",
          ok: true,
          detail: "shell/network tools disabled; exact write paths and protected control closure enforced",
        },
      ]));
      const product = { tick: vi.fn(async () => ({
        action: "issue-7",
        state: "idle",
        phase: "roadmap" as const,
        detail: "executed",
      })) };
      const journal = new HostJournal(path.join(root, "journal.jsonl"));
      const lanes = automaticLanes(
        readiness,
        product,
        { tick: async () => ({ action: "verifier", state: "idle", detail: "ok" }) },
        journal,
      );

      await expect(lanes.tick()).resolves.toMatchObject({
        action: "issue-7",
        state: "idle",
      });
      expect(product.tick).toHaveBeenCalledOnce();
      expect(
        journal.read().find((event) => event.type === "harness.governance-readiness")?.data,
      ).toMatchObject({ ready: true, release: RELEASE });
    } finally {
      removeTempDir(root);
    }
  });

  it("blocks product execution when Actions cannot approve pull requests", async () => {
    const result = await port(readyProtection(), false).inspect();
    expect(result.ready).toBe(false);
    expect(result.checks).toContainEqual({
      name: "actions-can-approve-pull-request-reviews",
      ok: false,
      detail: "Repository Actions workflows cannot approve pull request reviews",
    });
  });

  it("blocks product execution without last-push approval protection", async () => {
    const protection = readyProtection();
    const reviews = protection.required_pull_request_reviews as Record<string, unknown>;
    reviews.require_last_push_approval = false;
    const result = await port(protection).inspect();
    expect(result.ready).toBe(false);
    expect(result.checks).toContainEqual({
      name: "last-push-approval",
      ok: false,
      detail: "Last-push approval is not required",
    });
  });

  it("blocks product execution without an online idle verifier runner", async () => {
    const result = await port(readyProtection(), true, [{
      id: 7,
      status: "offline",
      busy: false,
      labels: [
        { name: "self-hosted" },
        { name: "macOS" },
        { name: "one-cli-verifier" },
      ],
    }]).inspect();
    expect(result.ready).toBe(false);
    expect(result.checks).toContainEqual({
      name: "runner-health",
      ok: false,
      detail: "No online, non-busy repository runner has exact self-hosted, macOS, one-cli-verifier labels",
    });
  });

  it("rejects the wrong authenticated host login", async () => {
    const result = await port(readyProtection(), true, [healthyRunner()], {
      login: "somebody-else",
    }).inspect();
    expect(result.ready).toBe(false);
    expect(result.checks).toContainEqual({
      name: "builder-login",
      ok: false,
      detail: "Authenticated gh login must exactly match repository owner beforeload",
    });
  });

  it("rejects token-bearing host environments even when gh auth succeeds", async () => {
    const result = await port(
      readyProtection(),
      true,
      [healthyRunner()],
      { login: "beforeload" },
      ["GH_TOKEN"],
    ).inspect();
    expect(result.ready).toBe(false);
    expect(result.checks).toContainEqual({
      name: "builder-no-token-environment",
      ok: false,
      detail: "Token-bearing environment variables are forbidden: GH_TOKEN",
    });
  });

  it("uses only the code-fixed read-only governance API inventory", async () => {
    const requests: ProcessRequest[] = [];
    await port(
      readyProtection(),
      true,
      [healthyRunner()],
      { login: "beforeload" },
      [],
      requests,
    ).inspect();
    expect(requests.map((request) => request.args)).toEqual([
      ["auth", "status", "--hostname", "github.com"],
      ["api", "--method", "GET", "user"],
      ["api", "--method", "GET", "repos/beforeload/one-cli"],
      ["api", "--method", "GET", "repos/beforeload/one-cli/issues?state=all&per_page=1"],
      ["api", "--method", "GET", "repos/beforeload/one-cli/pulls?state=all&per_page=1"],
      ["api", "--method", "GET", "repos/beforeload/one-cli/actions/workflows/independent-verifier.yml"],
      [
        "api",
        "--method",
        "GET",
        "repos/beforeload/one-cli/contents/.github/workflows/independent-verifier.yml?ref=main",
      ],
      ["api", "--method", "GET", "repos/beforeload/one-cli/actions/permissions/workflow"],
      ["api", "--method", "GET", "repos/beforeload/one-cli/branches/main/protection"],
      ["api", "--method", "GET", "repos/beforeload/one-cli/actions/runners?per_page=100"],
    ]);
    expect(requests.every((request) =>
      request.env?.GH_TOKEN === undefined && request.env?.GITHUB_TOKEN === undefined
    )).toBe(true);
  });

  it("resolves and inspects the executable release before live governance", async () => {
    const order: string[] = [];
    await port(
      readyProtection(),
      true,
      [healthyRunner()],
      { login: "beforeload" },
      [],
      undefined,
      order,
    ).inspect();
    expect(order[0]).toBe("release");
    expect(order).toContain("governance");
  });

  it("reports every invariant instead of collapsing readiness into one healthy flag", async () => {
    const result = await port(oldProtection()).inspect();
    expect(result.ready).toBe(false);
    expect(result.checks.map((check) => check.name)).toEqual(expect.arrayContaining([
      "default-branch",
      "workflow-path",
      "workflow-blob",
      "workflow-policy-version",
      "workflow-policy-hash",
      "actions-can-approve-pull-request-reviews",
      "protection-strict",
      "protection-enforce-admins",
      "protection-force-pushes-disabled",
      "protection-deletions-disabled",
      "required-check-verify",
      "required-check-independent-verifier",
      "required-checks-exact",
      "stale-review-dismissal",
      "required-approvals",
      "last-push-approval",
      "builder-no-token-environment",
      "builder-keyring-auth",
      "builder-login",
      "builder-repository-push",
      "builder-issues-capability",
      "builder-pull-request-capability",
      "worker-tool-policy",
      "runner-health",
    ]));
  });
});

function port(
  protection: Record<string, unknown>,
  canApprovePullRequestReviews = true,
  runners: unknown[] = [healthyRunner()],
  user: Record<string, unknown> = { login: "beforeload" },
  tokenEnvironmentNames: readonly string[] = [],
  requests?: ProcessRequest[],
  order?: string[],
): GhGovernanceReadinessPort {
  const responses: Record<string, unknown> = {
    user,
    "repos/beforeload/one-cli": {
      default_branch: "main",
      full_name: "beforeload/one-cli",
      owner: { login: "beforeload" },
      permissions: { push: true },
      has_issues: true,
    },
    "repos/beforeload/one-cli/issues?state=all&per_page=1": [],
    "repos/beforeload/one-cli/pulls?state=all&per_page=1": [],
      "repos/beforeload/one-cli/actions/workflows/independent-verifier.yml": {
      state: "active",
      path: ".github/workflows/independent-verifier.yml",
    },
    "repos/beforeload/one-cli/contents/.github/workflows/independent-verifier.yml?ref=main": {
      type: "file",
      path: ".github/workflows/independent-verifier.yml",
      sha: POLICY.workflow.blobSha,
      encoding: "base64",
      content: Buffer.from(WORKFLOW).toString("base64"),
    },
    "repos/beforeload/one-cli/actions/permissions/workflow": {
      default_workflow_permissions: "read",
      can_approve_pull_request_reviews: canApprovePullRequestReviews,
    },
    "repos/beforeload/one-cli/branches/main/protection": protection,
    "repos/beforeload/one-cli/actions/runners?per_page=100": {
      total_count: runners.length,
      runners,
    },
  };
  const runner: ProcessRunner = {
    run: async (request: ProcessRequest) => {
      order?.push("governance");
      requests?.push(request);
      if (request.args[0] === "auth") return result({});
      const apiPath = request.args.at(-1)!;
      if (!(apiPath in responses)) return failedResult(`unknown ${apiPath}`);
      return result(responses[apiPath]);
    },
  };
  return new GhGovernanceReadinessPort({
    runner,
    ghExecutable: "/usr/bin/gh",
    environment: {},
    repository: {
      owner: "beforeload",
      repo: "one-cli",
      defaultBranch: "main",
    },
    policy: POLICY,
    tokenEnvironmentNames,
    workerPolicy: {
      inspect: async () => {
        order?.push("release");
        return {
          ready: true,
          detail: "shell/network tools disabled; exact write paths and protected control closure enforced",
          release: RELEASE,
        };
      },
    },
  });
}

function healthyRunner(): Record<string, unknown> {
  return {
    id: 7,
    status: "online",
    busy: false,
    labels: [
      { name: "self-hosted" },
      { name: "macOS" },
      { name: "ARM64" },
      { name: "one-cli-verifier" },
    ],
  };
}

function readyProtection(): Record<string, unknown> {
  return {
    required_status_checks: {
      strict: true,
      checks: [
        { context: "verify", app_id: 15368 },
        { context: "one-cli/independent-verifier", app_id: 15368 },
      ],
    },
    enforce_admins: { enabled: true },
    allow_force_pushes: { enabled: false },
    allow_deletions: { enabled: false },
    required_pull_request_reviews: {
      dismiss_stale_reviews: true,
      require_last_push_approval: true,
      required_approving_review_count: 1,
    },
  };
}

function oldProtection(): Record<string, unknown> {
  return {
    required_status_checks: {
      strict: false,
      checks: [{ context: "verify", app_id: 15368 }],
    },
    enforce_admins: { enabled: false },
    allow_force_pushes: { enabled: true },
    allow_deletions: { enabled: true },
    required_pull_request_reviews: {
      dismiss_stale_reviews: false,
      require_last_push_approval: false,
      required_approving_review_count: 0,
    },
  };
}

function result(value: unknown): ProcessResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: JSON.stringify(value),
    stderr: "",
    durationMs: 1,
    timedOut: false,
    cancelled: false,
    outputLimitExceeded: false,
  };
}

function failedResult(stderr: string): ProcessResult {
  return {
    ...result({}),
    exitCode: 1,
    stderr,
  };
}
