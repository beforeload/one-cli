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
    expect(workflow.match(/persist-credentials: false/gu)).toHaveLength(2);
    expect(workflow).toContain('node "$TRUSTED_ROOT/scripts/independent-verifier.mjs"');
    expect(workflow).not.toMatch(/working-directory:\s*untrusted/u);
  });

  it("confines App/model secrets to the final trusted step and pins the token action", () => {
    expect(workflow).toContain(
      "actions/create-github-app-token@fee1f7d63c2ff003460e3d139729b119787bc349",
    );
    expect(workflow.indexOf("ONE_CLI_VERIFIER_MODEL_A_API_KEY"))
      .toBeGreaterThan(workflow.indexOf("Verify exact pull and publish App evidence"));
    expect(workflow.indexOf("ONE_CLI_VERIFIER_APP_PRIVATE_KEY"))
      .toBeGreaterThan(workflow.indexOf("Mint independent verifier App token"));
    expect(workflow).toContain("permissions:\n  contents: read");
  });

  it("uses exact git objects and fails closed instead of accepting REST patches", () => {
    expect(script).toContain('"cat-file", "-e"');
    expect(script).toContain('"--binary"');
    expect(script).toContain('"--full-index"');
    expect(script).toContain('"--no-textconv"');
    expect(script).not.toMatch(/pulls\/\$\{[^}]+\}\/files|\.patch\b/u);
    expect(script).toContain("Git evidence exceeds its strict byte bound");
  });

  it("pins check/review provenance and revalidates before approval and exact-head merge", () => {
    expect(script).toContain("required.appId");
    expect(script).toContain("actor.login !== policy.reviewIdentity.actor");
    expect(script).toContain("commit_id: binding.headSha");
    expect(script).toContain("await revalidatePull(github, policy, binding)");
    expect(script).toContain("{ sha: binding.headSha, merge_method: policy.merge.method }");
    expect(script.match(/await revalidatePull\(github, policy, binding\)/gu)?.length ?? 0)
      .toBeGreaterThanOrEqual(3);
  });

  it("terminalizes rejection and gives each rediscovered head a distinct operation", () => {
    expect(script).toContain(
      "`one-cli-independent-verifier:v3:${binding.pullNumber}:${binding.baseSha}:${binding.headSha}`",
    );
    expect(script).toContain("external_id: marker");
    expect(script).toContain('status: "completed"');
    expect(script).toContain('conclusion !== "success"');
    expect(script).toContain('status: "in_progress"');
  });

  it("is dry-run inspection by default and cannot mint, review, check, or merge locally", () => {
    const dryRun = script.indexOf("if (!options.apply)");
    const tokenRead = script.indexOf('requiredEnvironment(environment, "VERIFIER_TOKEN")');
    const checkWrite = script.indexOf("reserveCheck(github");
    expect(dryRun).toBeGreaterThan(0);
    expect(tokenRead).toBeGreaterThan(dryRun);
    expect(checkWrite).toBeGreaterThan(tokenRead);
  });

  it("rejects any verifier App permission beyond the exact least-privilege set", async () => {
    const verifier = await verifierModule();
    const github = {
      request: async () => ({
        app_id: 4242,
        app_slug: "one-cli-verifier",
        permissions: {
          checks: "write",
          contents: "read",
          metadata: "read",
          pull_requests: "write",
          actions: "read",
        },
      }),
    };
    await expect(verifier.assertInstallationIdentity(
      github,
      "4242",
      "one-cli-verifier",
    )).rejects.toThrow("permissions must be exactly");
  });

  it("blocks merge when the default branch advances after verification", async () => {
    const verifier = await verifierModule();
    const baseSha = "a".repeat(40);
    const headSha = "b".repeat(40);
    const expectedMergeBase = "c".repeat(40);
    const github = {
      request: async (_method: string, apiPath: string) => {
        if (apiPath.endsWith("/protection")) {
          return { required_status_checks: { strict: true } };
        }
        if (apiPath.includes("/pulls/7")) {
          return {
            state: "open",
            draft: false,
            base: {
              ref: "main",
              sha: baseSha,
              repo: { full_name: "beforeload/one-cli" },
            },
            head: { sha: headSha },
          };
        }
        if (apiPath.includes("/compare/")) {
          return { merge_base_commit: { sha: expectedMergeBase } };
        }
        if (apiPath.endsWith("/branches/main")) {
          return { commit: { sha: "d".repeat(40) } };
        }
        throw new Error(`Unexpected API path: ${apiPath}`);
      },
    };
    await expect(verifier.assertMergePreconditions(
      github,
      { repository: { owner: "beforeload", name: "one-cli", defaultBranch: "main" } },
      {
        repository: "beforeload/one-cli",
        baseRepository: "beforeload/one-cli",
        baseRef: "main",
        baseSha,
        headSha,
        pullNumber: 7,
      },
      expectedMergeBase,
    )).rejects.toThrow("Default branch advanced");
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
    expectedMergeBase: string,
  ): Promise<void>;
}> {
  return await import(pathToFileURL(path.join(ROOT, "scripts/independent-verifier.mjs")).href);
}
