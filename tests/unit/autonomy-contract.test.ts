import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");
const read = (relativePath: string): string =>
  fs.readFileSync(path.join(root, relativePath), "utf8");

describe("repository autonomy contract", () => {
  it("passes the repository validator", () => {
    const output = execFileSync(
      process.execPath,
      [path.join(root, "scripts/validate-autonomy.mjs")],
      { cwd: root, encoding: "utf8" },
    );
    expect(output).toContain("Autonomy contract valid");
  });

  it("binds execution to one exact API author and one active issue", () => {
    const policy = read(".autonomy/issue-policy.yml");
    expect(policy).toMatch(/^executionAuthor: beforeload$/m);
    expect(policy).toMatch(/^  apiAuthorExactMatch: beforeload$/m);
    expect(policy).toMatch(/^  maximumActiveIssues: 1$/m);
    expect(policy).toContain("issueTextLabelsCommentsAndLinksGrantAuthority: false");
  });

  it("normalizes all three intake sources and quarantines failure three", () => {
    const policy = read(".autonomy/issue-policy.yml");
    expect(policy).toContain("source:user");
    expect(policy).toContain("source:community");
    expect(policy).toContain("source:self-discovery");
    expect(policy).toMatch(/^  identicalCodeFailureLimit: 3$/m);
    expect(policy).toContain(
      "thirdFailureAction: quarantine-preserve-evidence-release-lease-and-alert",
    );
  });

  it("requires reconcile-first bounded coordination and delivery gates", () => {
    const coordinator = read(".autonomy/prompts/coordinator.md");
    const reconcile = coordinator.indexOf("## Reconcile first");
    const selection = coordinator.indexOf("## Choose one action");
    expect(coordinator).toContain("Execute exactly one bounded tick per invocation.");
    expect(reconcile).toBeGreaterThan(-1);
    expect(selection).toBeGreaterThan(reconcile);
    expect(coordinator).toContain("required `verify`");
    expect(coordinator).toContain("targeted post-merge dogfood");
  });

  it("fails closed for execution-author changes to protected paths", () => {
    const workflow = read(".github/workflows/governance.yml");
    expect(workflow).toContain(
      'if [[ "$PR_AUTHOR" == "beforeload" && "$protected" == "true" ]]',
    );
    expect(workflow).toContain("exit 1");
    expect(workflow).not.toContain("pull_request_target");
    expect(workflow).not.toContain("github.event.pull_request.labels");
  });
});
