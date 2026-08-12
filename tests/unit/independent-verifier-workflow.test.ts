import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../..");
const workflow = fs.readFileSync(path.join(ROOT, ".github/workflows/autonomy-tick.yml"), "utf8");
const verify = fs.readFileSync(path.join(ROOT, ".github/workflows/verify.yml"), "utf8");

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
  });

  it("binds artifacts and runs the complete repository gate", () => {
    expect(workflow).toContain("git apply --check");
    expect(workflow).toContain("patchSha256");
    expect(workflow).toContain("npm run check");
    expect(workflow).toContain("gh pr merge");
  });
});
