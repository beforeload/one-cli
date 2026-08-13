import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../..");
const workflow = fs.readFileSync(path.join(ROOT, ".github/workflows/autonomy-tick.yml"), "utf8");
const watchdog = fs.readFileSync(path.join(ROOT, ".github/workflows/autonomy-watchdog.yml"), "utf8");
const verify = fs.readFileSync(path.join(ROOT, ".github/workflows/verify.yml"), "utf8");
const driver = fs.readFileSync(path.join(ROOT, "scripts/github-autonomy.mjs"), "utf8");

describe("GitHub-hosted unattended workflow", () => {
  it("keeps model execution separate from publication", () => {
    expect(workflow).toContain("build-without-repository-credentials");
    expect(workflow).toContain("publish-without-model-credentials");
    expect(workflow).toContain("actions/create-github-app-token@fee1f7d63c2ff003460e3d139729b119787bc349");
    expect(workflow).toContain("--allowedTools \"Read,Edit,Write,Grep\"");
    expect(workflow).not.toContain("GH_TOKEN: ${{ github.token }}");
  });

  it("runs active jobs only on GitHub-hosted runners", () => {
    expect(workflow).not.toMatch(/self-hosted|127\.0\.0\.1|launchd/u);
    expect(verify).not.toMatch(/self-hosted|127\.0\.0\.1|launchd/u);
    expect(workflow.match(/runs-on: ubuntu-latest/gu)?.length).toBeGreaterThanOrEqual(4);
    expect(verify).toContain("runs-on: ubuntu-latest");
    expect(watchdog).toContain("runs-on: ubuntu-latest");
    expect(watchdog).not.toMatch(/self-hosted|127\.0\.0\.1|launchd/u);
  });

  it("recovers a missed scheduled run on GitHub", () => {
    expect(workflow).toContain('cron: "7,37 * * * *"');
    expect(watchdog).toContain('cron: "17,47 * * * *"');
    expect(watchdog).toContain("actions: write");
    expect(watchdog).toContain("latest_success");
    expect(watchdog).toContain("now - success_epoch < 2700");
    expect(watchdog).toContain("actions/workflows/autonomy-tick.yml/dispatches");
  });

  it("binds artifacts and runs the complete repository gate", () => {
    expect(workflow).toContain("git apply --check");
    expect(driver).toContain("patchSha256");
    expect(driver).toContain('execFileSync("git", ["apply", "--check"');
    expect(workflow.match(/--selection "\$\{RUNNER_TEMP\}\/change\/selection\/selection\.json"/gu)?.length ?? 0)
      .toBe(1);
    expect(workflow.match(/--selection "\$\{RUNNER_TEMP\}\/verified\/selection\/selection\.json"/gu)?.length ?? 0)
      .toBe(4);
    expect(workflow).toContain("${{ runner.temp }}/change/selection/selection.json");
    expect(workflow).toContain("npm run check");
    expect(workflow).toContain("gh pr merge");
  });

  it("deduplicates GitHub issue inventory before roadmap matching", () => {
    expect(driver).toContain("dedupeIssues");
    expect(driver).toContain("issues?state=all&labels=agent-ready&per_page=100");
    expect(driver).toContain("conflicting records for issue #");
    expect(driver).toContain("at most one open issue");
    expect(driver).toContain("openMatches.length === 0");
  });

  it("preserves lease fencing invariants in the model prompt", () => {
    expect(driver).toContain("lease release must remove only the exact owner-and-fence row");
    expect(driver).toContain("newer fenced owner to reacquire immediately");
    expect(driver).toContain("never leave an unhandled promise rejection after cleanup");
  });
});
