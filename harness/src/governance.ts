import type { ProcessRunner } from "./runner.js";
import { requireSuccess } from "./runner.js";
import type { IndependentVerifierPolicy } from "./verifier.js";
import type {
  WorkerPolicyReadiness,
  WorkerPolicyReadinessPort,
  WorkerReleaseInspection,
} from "./worker-policy.js";

export interface GovernanceReadinessCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface GovernanceReadiness {
  readonly schema: "one-cli.harness/governance-readiness-v1";
  readonly ready: boolean;
  readonly checks: readonly GovernanceReadinessCheck[];
  readonly release: WorkerReleaseInspection | null;
}

export interface GovernanceReadinessPort {
  inspect(signal?: AbortSignal): Promise<GovernanceReadiness>;
}

interface ReadinessInput {
  readonly runner: ProcessRunner;
  readonly ghExecutable: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly repository: {
    readonly owner: string;
    readonly repo: string;
    readonly defaultBranch: string;
  };
  readonly policy: IndependentVerifierPolicy;
  readonly tokenEnvironmentNames: readonly string[];
  readonly workerPolicy: WorkerPolicyReadinessPort;
}

interface ApiResult {
  readonly value?: unknown;
  readonly error?: string;
}

export class GhGovernanceReadinessPort implements GovernanceReadinessPort {
  constructor(private readonly input: ReadinessInput) {}

  async inspect(signal?: AbortSignal): Promise<GovernanceReadiness> {
    const { repository, policy } = this.input;
    let workerPolicy: WorkerPolicyReadiness;
    try {
      workerPolicy = await this.input.workerPolicy.inspect(signal);
    } catch (error) {
      workerPolicy = {
        ready: false,
        detail: message(error),
        release: null,
      };
    }
    const repositoryPath = `repos/${encodeURIComponent(repository.owner)}/${
      encodeURIComponent(repository.repo)
    }`;
    const defaultBranchPath = `${repositoryPath}/branches/${
      encodeURIComponent(repository.defaultBranch)
    }`;
    const workflowApiPath = policy.workflow.path
      .split("/")
      .map(encodeURIComponent)
      .join("/");
    const [
      authResult,
      userResult,
      repoResult,
      issuesResult,
      pullsResult,
      workflowResult,
      contentResult,
      actionsWorkflowResult,
      protectionResult,
      runnersResult,
    ] =
      await Promise.all([
        this.auth(signal),
        this.get("user", signal),
        this.get(repositoryPath, signal),
        this.get(`${repositoryPath}/issues?state=all&per_page=1`, signal),
        this.get(`${repositoryPath}/pulls?state=all&per_page=1`, signal),
        this.get(
          `${repositoryPath}/actions/workflows/${
            encodeURIComponent(policy.workflow.path.split("/").at(-1)!)
          }`,
          signal,
        ),
        this.get(
          `${repositoryPath}/contents/${workflowApiPath}?ref=${
            encodeURIComponent(repository.defaultBranch)
          }`,
          signal,
        ),
        this.get(`${repositoryPath}/actions/permissions/workflow`, signal),
        this.get(`${defaultBranchPath}/protection`, signal),
        this.get(`${repositoryPath}/actions/runners?per_page=100`, signal),
      ]);

    const checks: GovernanceReadinessCheck[] = [];
    const add = (name: string, ok: boolean, detail: string): void => {
      checks.push({ name, ok, detail });
    };
    const repositoryMatches =
      repository.owner === policy.repository.owner &&
      repository.repo === policy.repository.name &&
      repository.defaultBranch === policy.repository.defaultBranch;
    add(
      "repository-identity",
      repositoryMatches,
      repositoryMatches
        ? `${repository.owner}/${repository.repo}`
        : "Tracked repository identity differs from verifier policy",
    );

    const tokenEnvironmentNames = [...new Set([
      ...this.input.tokenEnvironmentNames,
      ...Object.keys(this.input.environment).filter((name) =>
        name === "GH_TOKEN" || name === "GITHUB_TOKEN"
      ),
    ])].sort();
    const noTokenEnvironment = tokenEnvironmentNames.length === 0;
    add(
      "builder-no-token-environment",
      noTokenEnvironment,
      noTokenEnvironment
        ? "GH_TOKEN and GITHUB_TOKEN are absent; gh must use its canonical keyring config"
        : `Token-bearing environment variables are forbidden: ${tokenEnvironmentNames.join(", ")}`,
    );
    add(
      "builder-keyring-auth",
      authResult.error === undefined && noTokenEnvironment,
      authResult.error === undefined && noTokenEnvironment
        ? "canonical gh executable and config authenticated without exported tokens"
        : authResult.error ?? "Token-bearing environment bypasses keyring authentication",
    );
    const user = resultRecord(userResult, "authenticated user");
    const builderLoginOk =
      repository.owner === "beforeload" &&
      user.value?.login === repository.owner;
    add(
      "builder-login",
      builderLoginOk,
      builderLoginOk
        ? "authenticated host builder login is exactly beforeload"
        : user.error ?? "Authenticated gh login must exactly match repository owner beforeload",
    );

    const repo = resultRecord(repoResult, "repository");
    const repoOwner = nestedRecord(repo.value, "owner");
    const repoPermissions = nestedRecord(repo.value, "permissions");
    const pushCapabilityOk =
      builderLoginOk &&
      repo.value?.full_name === `${repository.owner}/${repository.repo}` &&
      repoOwner.value?.login === repository.owner &&
      repoPermissions.value?.push === true;
    add(
      "builder-repository-push",
      pushCapabilityOk,
      pushCapabilityOk
        ? "repository metadata grants beforeload push capability"
        : repo.error ??
          repoOwner.error ??
          repoPermissions.error ??
          "Authenticated builder lacks repository push capability",
    );
    const issuesCapabilityOk =
      pushCapabilityOk &&
      repo.value?.has_issues === true &&
      Array.isArray(issuesResult.value);
    add(
      "builder-issues-capability",
      issuesCapabilityOk,
      issuesCapabilityOk
        ? "issues are enabled and the authenticated builder can probe the fixed issue endpoint"
        : issuesResult.error ?? "Authenticated builder issue capability probe failed",
    );
    const pullsCapabilityOk = pushCapabilityOk && Array.isArray(pullsResult.value);
    add(
      "builder-pull-request-capability",
      pullsCapabilityOk,
      pullsCapabilityOk
        ? "authenticated builder can probe the fixed pull-request endpoint"
        : pullsResult.error ?? "Authenticated builder pull-request capability probe failed",
    );

    const defaultBranchOk =
      repositoryMatches &&
      repo.value?.default_branch === policy.repository.defaultBranch;
    add(
      "default-branch",
      defaultBranchOk,
      defaultBranchOk
        ? policy.repository.defaultBranch
        : repo.error ?? "GitHub default branch is not exactly the policy default branch",
    );

    const workflow = resultRecord(workflowResult, "workflow");
    const workflowPathOk =
      workflow.value?.state === "active" &&
      workflow.value.path === policy.workflow.path;
    add(
      "workflow-path",
      workflowPathOk,
      workflowPathOk
        ? `${policy.workflow.path} is active`
        : workflow.error ?? "Trusted verifier workflow is absent, inactive, or at the wrong path",
    );

    const content = resultRecord(contentResult, "workflow content");
    const workflowBlobOk =
      content.value?.type === "file" &&
      content.value.path === policy.workflow.path &&
      content.value.sha === policy.workflow.blobSha;
    add(
      "workflow-blob",
      workflowBlobOk,
      workflowBlobOk
        ? policy.workflow.blobSha
        : content.error ?? "Default-branch workflow blob does not match the pinned blob",
    );
    let decodedWorkflow = "";
    try {
      decodedWorkflow = decodeContent(content.value);
    } catch (error) {
      if (!content.error) content.error = message(error);
    }
    const policyMarker = `ONE_CLI_VERIFIER_POLICY_VERSION: ${policy.workflow.policyVersion}`;
    const workflowPolicyOk = workflowBlobOk && decodedWorkflow.includes(policyMarker);
    add(
      "workflow-policy-version",
      workflowPolicyOk,
      workflowPolicyOk
        ? policy.workflow.policyVersion
        : content.error ?? "Pinned workflow does not declare the expected verifier policy version",
    );
    const policyHashMarker = `ONE_CLI_VERIFIER_POLICY_SHA256: ${policy.workflow.policyHash}`;
    const workflowPolicyHashOk = workflowBlobOk && decodedWorkflow.includes(policyHashMarker);
    add(
      "workflow-policy-hash",
      workflowPolicyHashOk,
      workflowPolicyHashOk
        ? policy.workflow.policyHash
        : content.error ?? "Pinned workflow does not declare the expected verifier policy hash",
    );

    const actionsWorkflow = resultRecord(
      actionsWorkflowResult,
      "Actions workflow permissions",
    );
    const actionsApprovalOk =
      actionsWorkflow.value?.can_approve_pull_request_reviews === true;
    add(
      "actions-can-approve-pull-request-reviews",
      actionsApprovalOk,
      actionsApprovalOk
        ? "GitHub Actions may approve pull request reviews"
        : actionsWorkflow.error ??
          "Repository Actions workflows cannot approve pull request reviews",
    );

    const protection = resultRecord(protectionResult, "branch protection");
    const status = nestedRecord(protection.value, "required_status_checks");
    const reviews = nestedRecord(protection.value, "required_pull_request_reviews");
    const strictOk = status.value?.strict === true;
    add(
      "protection-strict",
      strictOk,
      strictOk
        ? "required status checks are strict"
        : protection.error ?? status.error ?? "Branch protection strict mode is disabled",
    );
    const admins = nestedRecord(protection.value, "enforce_admins");
    const adminsOk = admins.value?.enabled === true;
    add(
      "protection-enforce-admins",
      adminsOk,
      adminsOk
        ? "administrators are enforced"
        : protection.error ?? admins.error ?? "Branch protection does not enforce administrators",
    );
    const forcePushes = nestedRecord(protection.value, "allow_force_pushes");
    const forcePushOk = forcePushes.value?.enabled === false;
    add(
      "protection-force-pushes-disabled",
      forcePushOk,
      forcePushOk
        ? "force pushes are disabled"
        : protection.error ?? forcePushes.error ?? "Force pushes are not explicitly disabled",
    );
    const deletions = nestedRecord(protection.value, "allow_deletions");
    const deletionsOk = deletions.value?.enabled === false;
    add(
      "protection-deletions-disabled",
      deletionsOk,
      deletionsOk
        ? "branch deletions are disabled"
        : protection.error ?? deletions.error ?? "Branch deletions are not explicitly disabled",
    );

    const expectedChecks = [...policy.requiredChecks];
    const actualChecks = Array.isArray(status.value?.checks)
      ? status.value.checks
        .map((value) => record(value))
        .filter((value): value is Record<string, unknown> => value !== undefined)
      : [];
    for (const expected of policy.requiredChecks) {
      const matches = actualChecks.filter((candidate) =>
        candidate.context === expected.name && candidate.app_id === expected.appId
      );
      const ok = matches.length === 1;
      add(
        expected.name === policy.emittedCheck.name
          ? "required-check-independent-verifier"
          : `required-check-${expected.name}`,
        ok,
        ok
          ? `${expected.name} is pinned to App ${String(expected.appId)}`
          : `Required check ${expected.name} is not uniquely pinned to App ${String(expected.appId)}`,
      );
    }
    const checksExact =
      expectedChecks.length > 0 &&
      actualChecks.length === expectedChecks.length &&
      expectedChecks.every((expected) =>
        actualChecks.filter((candidate) =>
          candidate.context === expected.name && candidate.app_id === expected.appId
        ).length === 1
      );
    add(
      "required-checks-exact",
      checksExact,
      checksExact
        ? "required checks exactly match policy"
        : status.error ?? "Branch protection required checks contain missing, extra, or unpinned entries",
    );

    const staleReviewsOk = reviews.value?.dismiss_stale_reviews === true;
    add(
      "stale-review-dismissal",
      staleReviewsOk,
      staleReviewsOk
        ? "stale reviews are dismissed"
        : reviews.error ?? "Stale review dismissal is not enabled",
    );
    const approvalCount = reviews.value?.required_approving_review_count;
    const approvalOk =
      typeof approvalCount === "number" &&
      Number.isSafeInteger(approvalCount) &&
      approvalCount >= 1;
    add(
      "required-approvals",
      approvalOk,
      approvalOk
        ? `${approvalCount} approval(s) required`
        : reviews.error ?? "At least one approving review is not required",
    );
    const lastPushOk = reviews.value?.require_last_push_approval === true;
    add(
      "last-push-approval",
      lastPushOk,
      lastPushOk
        ? "last push requires independent approval"
        : reviews.error ?? "Last-push approval is not required",
    );

    add(
      "worker-tool-policy",
      workerPolicy.ready,
      workerPolicy.detail,
    );

    const runnerInventory = resultRecord(runnersResult, "repository runner inventory");
    const runners = Array.isArray(runnerInventory.value?.runners)
      ? runnerInventory.value.runners
      : [];
    const runnerCount = runnerInventory.value?.total_count;
    const runnerRecords = runners
      .map((value) => record(value))
      .filter((value): value is Record<string, unknown> => value !== undefined);
    const boundedInventory =
      typeof runnerCount === "number" &&
      Number.isSafeInteger(runnerCount) &&
      runnerCount >= 0 &&
      runnerCount < 100 &&
      runnerCount === runners.length &&
      runnerRecords.length === runners.length;
    const healthyRunners = boundedInventory
      ? runnerRecords.filter((candidate) => {
          if (!Array.isArray(candidate.labels)) return false;
          const labelRecords = candidate.labels
            .map((value) => record(value))
            .filter((value): value is Record<string, unknown> => value !== undefined);
          const labels = labelRecords
            .map((value) => value.name)
            .filter((value): value is string => typeof value === "string");
          return candidate.status === "online" &&
            candidate.busy === false &&
            labelRecords.length === candidate.labels.length &&
            labels.length === labelRecords.length &&
            policy.workflow.runnerLabels.every((label) =>
              labels.filter((candidateLabel) => candidateLabel === label).length === 1
            );
        })
      : [];
    const runnerHealthy = boundedInventory && healthyRunners.length >= 1;
    add(
      "runner-health",
      runnerHealthy,
      runnerHealthy
        ? `${healthyRunners.length} online, non-busy repository verifier runner(s)`
        : runnerInventory.error ??
          "No online, non-busy repository runner has exact self-hosted, macOS, one-cli-verifier labels",
    );

    return {
      schema: "one-cli.harness/governance-readiness-v1",
      ready: checks.every((check) => check.ok),
      checks,
      release: workerPolicy.release,
    };
  }

  private async auth(signal?: AbortSignal): Promise<ApiResult> {
    try {
      requireSuccess(
        "gh auth status",
        await this.input.runner.run({
          executable: this.input.ghExecutable,
          args: ["auth", "status", "--hostname", "github.com"],
          env: this.input.environment,
          timeoutMs: 15_000,
          maxOutputBytes: 256 * 1024,
          ...(signal ? { signal } : {}),
        }),
      );
      return { value: true };
    } catch (error) {
      return { error: message(error) };
    }
  }

  private async get(apiPath: string, signal?: AbortSignal): Promise<ApiResult> {
    try {
      const result = requireSuccess(
        "gh api governance readiness",
        await this.input.runner.run({
          executable: this.input.ghExecutable,
          args: ["api", "--method", "GET", apiPath],
          env: this.input.environment,
          timeoutMs: 30_000,
          maxOutputBytes: 2 * 1024 * 1024,
          ...(signal ? { signal } : {}),
        }),
      );
      return { value: JSON.parse(result.stdout) as unknown };
    } catch (error) {
      return { error: message(error) };
    }
  }
}

function decodeContent(value: Record<string, unknown> | undefined): string {
  if (!value || value.encoding !== "base64" || typeof value.content !== "string") {
    throw new Error("Default-branch workflow content is not bounded base64");
  }
  const compact = value.content.replace(/\s/gu, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(compact) || compact.length > 2 * 1024 * 1024) {
    throw new Error("Default-branch workflow content is malformed or oversized");
  }
  return Buffer.from(compact, "base64").toString("utf8");
}

function resultRecord(
  result: ApiResult,
  label: string,
): { value?: Record<string, unknown>; error?: string } {
  if (result.error) return { error: result.error };
  const value = record(result.value);
  return value ? { value } : { error: `${label} response must be an object` };
}

function nestedRecord(
  parent: Record<string, unknown> | undefined,
  key: string,
): { value?: Record<string, unknown>; error?: string } {
  const value = record(parent?.[key]);
  return value ? { value } : { error: `${key} must be an object` };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}
