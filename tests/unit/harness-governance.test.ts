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
const WORKFLOW = fs.readFileSync(
  path.join(ROOT, ".github/workflows/independent-verifier.yml"),
  "utf8",
);

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
      await expect(readiness.inspect()).resolves.toMatchObject({ ready: true });
      const product = { tick: vi.fn(async () => ({
        action: "issue-7",
        state: "idle",
        phase: "roadmap" as const,
        detail: "executed",
      })) };
      const lanes = automaticLanes(
        readiness,
        product,
        { tick: async () => ({ action: "verifier", state: "idle", detail: "ok" }) },
        new HostJournal(path.join(root, "journal.jsonl")),
      );

      await expect(lanes.tick()).resolves.toMatchObject({
        action: "issue-7",
        state: "idle",
      });
      expect(product.tick).toHaveBeenCalledOnce();
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
      "runtime-no-protection-write",
      "runner-health",
    ]));
  });
});

function port(
  protection: Record<string, unknown>,
  canApprovePullRequestReviews = true,
  runners: unknown[] = [healthyRunner()],
): GhGovernanceReadinessPort {
  const responses: Record<string, unknown> = {
    "repos/beforeload/one-cli": { default_branch: "main" },
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
    installation: {
      app_id: 99,
      permissions: {
        administration: "read",
        contents: "write",
        issues: "write",
        pull_requests: "write",
      },
    },
    "repos/beforeload/one-cli/actions/runners?per_page=100": {
      total_count: runners.length,
      runners,
    },
  };
  const runner: ProcessRunner = {
    run: async (request: ProcessRequest) => {
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
