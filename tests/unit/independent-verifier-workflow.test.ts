import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../..");
const workflow = read(".github/workflows/independent-verifier.yml");
const script = read("scripts/independent-verifier.mjs");

describe("independent verifier trusted workflow", () => {
  it("runs for every PR class from exact trusted base code with isolated untrusted data", () => {
    expect(workflow).toContain("pull_request_target:");
    expect(workflow).not.toMatch(/\n\s+paths(?:-ignore)?:/u);
    expect(workflow).not.toContain("github.event.pull_request.draft == false");
    expect(workflow).toContain("ref: ${{ github.event.pull_request.base.sha }}");
    expect(workflow).toContain("path: trusted");
    expect(workflow).toContain("ref: refs/pull/${{ github.event.pull_request.number }}/head");
    expect(workflow).toContain("path: untrusted");
    expect(workflow.match(/persist-credentials: false/gu)).toHaveLength(3);
    expect(workflow).toContain('node "$TRUSTED_ROOT/scripts/independent-verifier.mjs"');
    expect(workflow).not.toMatch(/working-directory:\s*untrusted/u);
    expect(workflow).toContain("name: one-cli/independent-verifier");
  });

  it("uses only ephemeral built-in identity with least-privilege per-job permissions", () => {
    expect(workflow).not.toMatch(/create-github-app-token|PRIVATE_KEY|secrets\.|VERIFIER_TOKEN/u);
    expect(workflow.match(/GITHUB_TOKEN: \$\{\{ github\.token \}\}/gu)).toHaveLength(2);
    expect(workflow).toMatch(
      /verifier:[\s\S]*?permissions:\n\s+contents: read\n\s+checks: read\n\s+pull-requests: write\n\s+models: read/u,
    );
    expect(workflow).toMatch(
      /merge:[\s\S]*?permissions:\n\s+contents: write\n\s+checks: read\n\s+pull-requests: read/u,
    );
    expect(workflow).not.toContain("checks: write");
    expect(workflow).not.toContain("administration:");
  });

  it("uses two distinct GitHub Models defaults without repository secrets", () => {
    expect(workflow).toContain("'openai/gpt-4.1'");
    expect(workflow).toContain("'openai/gpt-4.1-mini'");
    expect(workflow).toContain("ONE_CLI_VERIFIER_MODEL_A");
    expect(workflow).toContain("ONE_CLI_VERIFIER_MODEL_B");
    expect(workflow).not.toMatch(/MODEL_[AB]_(?:API_KEY|BASE_URL)/u);
    expect(script).toContain("const semantic = await semanticReviews(");
    expect(script).not.toContain("if (protectedChange)");
  });

  it("uses exact git objects and fails closed instead of accepting REST patches", () => {
    expect(script).toContain('"cat-file", "-e"');
    expect(script).toContain('"--binary"');
    expect(script).toContain('"--full-index"');
    expect(script).toContain('"--no-textconv"');
    expect(script).not.toMatch(/pulls\/\$\{[^}]+\}\/files|\.patch\b/u);
    expect(script).toContain("Git evidence exceeds its strict byte bound");
  });

  it("pins built-in check/review provenance and revalidates exact base/head", () => {
    expect(script).toContain("required.appId");
    expect(script).toContain("actor.login !== policy.reviewIdentity.actor");
    expect(script).toContain("commit_id: binding.headSha");
    expect(script).toContain("() => revalidatePull(github, policy, binding)");
    expect(script).toContain("{ sha: binding.headSha, merge_method: policy.merge.method }");
    expect(script.match(/revalidatePull\(github, policy, binding/gu)?.length ?? 0)
      .toBeGreaterThanOrEqual(3);
    expect(script).toContain("Exact head lacks one pinned github-actions[bot] approval");
  });

  it("never calls branch-protection or ruleset endpoints from the trusted workflow token", () => {
    expect(script).not.toMatch(/branches\/[^/]+\/protection|\/rulesets/u);
    expect(script).not.toContain("assertStrictProtection");
  });

  it("performs final live binding reads after waits and immediately before writes", () => {
    const finalReview = script.slice(
      script.indexOf("async function submitFinalReview"),
      script.indexOf("async function submitBoundReview"),
    );
    expect(finalReview.indexOf("waitForPinnedChecks")).toBeLessThan(
      finalReview.indexOf("revalidatePull"),
    );
    expect(finalReview).toContain("() => revalidatePull(github, policy, binding)");
    expect(finalReview.trimEnd().endsWith(");\n}")).toBe(true);

    const mergePreconditions = script.slice(
      script.indexOf("export async function assertMergePreconditions"),
      script.indexOf("async function mergeExactHead"),
    );
    expect(mergePreconditions.indexOf("waitForPinnedChecks")).toBeLessThan(
      mergePreconditions.indexOf("assertBoundApproval"),
    );
    expect(mergePreconditions.trimEnd().endsWith(
      "await revalidatePull(github, policy, binding, true);\n}",
    )).toBe(true);
  });

  it("gives every head a distinct SHA-bound review operation", () => {
    expect(script).toContain(
      "`one-cli-independent-verifier:v4:${binding.pullNumber}:${binding.baseSha}:${binding.headSha}`",
    );
    expect(script).toContain('"REQUEST_CHANGES"');
    expect(script).toContain('"APPROVE"');
  });

  it("is dry-run inspection by default and cannot review or merge locally", () => {
    const dryRun = script.indexOf("if (!options.verify)");
    const tokenRead = script.indexOf("const github = githubClient(environment, policy)", dryRun);
    const reviewWrite = script.indexOf("await submitFinalReview(", tokenRead);
    expect(dryRun).toBeGreaterThan(0);
    expect(tokenRead).toBeGreaterThan(dryRun);
    expect(reviewWrite).toBeGreaterThan(tokenRead);
  });

  it("rejects a token not issued by the built-in GitHub Actions App", async () => {
    const verifier = await verifierModule();
    const github = {
      request: async () => ({
        app_id: 4242,
        app_slug: "one-cli-verifier",
      }),
    };
    await expect(verifier.assertInstallationIdentity(
      github,
      "15368",
      "github-actions",
    )).rejects.toThrow("pinned App ID and slug");
  });

  it("blocks merge when the default branch head advances after verification", async () => {
    const verifier = await verifierModule();
    const baseSha = "a".repeat(40);
    const headSha = "b".repeat(40);
    const policy = verifierPolicy();
    const binding = pullBinding(baseSha, headSha);
    const calls: string[] = [];
    const github = {
      request: async (_method: string, apiPath: string) => {
        calls.push(apiPath);
        if (apiPath.includes("/check-runs")) {
          return {
            total_count: 2,
            check_runs: [
              {
                name: "verify",
                head_sha: headSha,
                status: "completed",
                conclusion: "success",
                app: { id: 15368 },
              },
              {
                name: "one-cli/independent-verifier",
                head_sha: headSha,
                status: "completed",
                conclusion: "success",
                app: { id: 15368 },
              },
            ],
          };
        }
        if (apiPath.endsWith("/reviews?per_page=100")) {
          return [
            {
              state: "APPROVED",
              commit_id: headSha,
              body: `one-cli-independent-verifier:v4:7:${baseSha}:${headSha}`,
              user: { login: "github-actions[bot]", type: "Bot" },
            },
          ];
        }
        if (apiPath.includes("/compare/")) {
          return { merge_base_commit: { sha: baseSha } };
        }
        if (apiPath === "/repos/beforeload/one-cli") {
          return { full_name: "beforeload/one-cli", default_branch: "main" };
        }
        if (apiPath.includes("/pulls/7")) {
          return {
            state: "open",
            draft: false,
            mergeable: true,
            base: {
              ref: "main",
              sha: baseSha,
              repo: { full_name: "beforeload/one-cli" },
            },
            head: { sha: headSha },
          };
        }
        if (apiPath.endsWith("/branches/main")) {
          return { name: "main", commit: { sha: "d".repeat(40) } };
        }
        throw new Error(`Unexpected API path: ${apiPath}`);
      },
    };
    await expect(verifier.assertMergePreconditions(
      github,
      policy,
      binding,
    )).rejects.toThrow("Default branch advanced");
    expect(calls.some((apiPath) => apiPath.endsWith("/protection"))).toBe(false);
    expect(calls.slice(-3)).toEqual([
      "/repos/beforeload/one-cli",
      "/repos/beforeload/one-cli/pulls/7",
      "/repos/beforeload/one-cli/branches/main",
    ]);
  });

  it("blocks merge when repository default_branch changes", async () => {
    const verifier = await verifierModule();
    const baseSha = "a".repeat(40);
    const headSha = "b".repeat(40);
    const github = {
      request: async (_method: string, apiPath: string) => {
        if (apiPath.includes("/check-runs")) {
          return {
            total_count: 2,
            check_runs: [
              {
                name: "verify",
                head_sha: headSha,
                status: "completed",
                conclusion: "success",
                app: { id: 15368 },
              },
              {
                name: "one-cli/independent-verifier",
                head_sha: headSha,
                status: "completed",
                conclusion: "success",
                app: { id: 15368 },
              },
            ],
          };
        }
        if (apiPath.endsWith("/reviews?per_page=100")) {
          return [
            {
              state: "APPROVED",
              commit_id: headSha,
              body: `one-cli-independent-verifier:v4:7:${baseSha}:${headSha}`,
              user: { login: "github-actions[bot]", type: "Bot" },
            },
          ];
        }
        if (apiPath.includes("/compare/")) {
          return { merge_base_commit: { sha: baseSha } };
        }
        if (apiPath === "/repos/beforeload/one-cli") {
          return { full_name: "beforeload/one-cli", default_branch: "develop" };
        }
        throw new Error(`Unexpected API path: ${apiPath}`);
      },
    };
    await expect(verifier.assertMergePreconditions(
      github,
      verifierPolicy(),
      pullBinding(baseSha, headSha),
    )).rejects.toThrow("default branch changed");
  });
});

function read(relative: string): string {
  return fs.readFileSync(path.join(ROOT, relative), "utf8");
}

async function verifierModule(): Promise<{
  assertInstallationIdentity(
    github: { request(method: string, apiPath: string): Promise<unknown> },
    expectedAppId: string,
    expectedSlug: string,
  ): Promise<void>;
  assertMergePreconditions(
    github: { request(method: string, apiPath: string): Promise<unknown> },
    policy: unknown,
    binding: unknown,
  ): Promise<void>;
}> {
  return await import(pathToFileURL(path.join(ROOT, "scripts/independent-verifier.mjs")).href);
}

function verifierPolicy() {
  return {
    repository: { owner: "beforeload", name: "one-cli", defaultBranch: "main" },
    requiredChecks: [
      { name: "verify", appId: 15368 },
      { name: "one-cli/independent-verifier", appId: 15368 },
    ],
    reviewIdentity: { actor: "github-actions[bot]" },
  };
}

function pullBinding(baseSha: string, headSha: string) {
  return {
    repository: "beforeload/one-cli",
    baseRepository: "beforeload/one-cli",
    baseRef: "main",
    baseSha,
    headSha,
    pullNumber: 7,
  };
}
