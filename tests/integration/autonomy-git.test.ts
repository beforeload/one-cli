import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitManager } from "../../src/autonomy/git.js";
import { makeTempDir, removeTempDir } from "../helpers.js";

describe("autonomy Git integration", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) removeTempDir(root);
  });

  it("fetches, reviews, commits, pushes, and safely removes an isolated worktree", async ({
    skip,
  }) => {
    const root = makeTempDir("autonomy-git");
    roots.push(root);
    const source = path.join(root, "source");
    const remote = path.join(root, "remote.git");
    fs.mkdirSync(source);
    try {
      git(["init", "-b", "main"], source);
    } catch (error) {
      if (error instanceof Error && error.message.includes("Operation not permitted")) {
        skip("The execution sandbox blocks creation of Git hook directories");
      }
      throw error;
    }
    git(["config", "user.name", "Autonomy Test"], source);
    git(["config", "user.email", "autonomy@example.test"], source);
    fs.writeFileSync(path.join(source, "value.txt"), "before\n");
    git(["add", "."], source);
    git(["commit", "-m", "initial"], source);
    git(["init", "--bare", remote], root);
    git(["remote", "add", "origin", remote], source);
    git(["push", "-u", "origin", "main"], source);

    const manager = new GitManager({ storageRoot: path.join(root, "managed") });
    const repository = await manager.ensureBare("repo", remote);
    git(["--git-dir", repository.barePath, "config", "user.name", "Autonomy Test"], root);
    git(
      ["--git-dir", repository.barePath, "config", "user.email", "autonomy@example.test"],
      root,
    );
    git(["--git-dir", repository.barePath, "config", "commit.gpgsign", "false"], root);
    const base = await manager.fetchBase(repository, "origin", "main");
    const worktree = await manager.createWorktree(repository, "issue-1", {
      branch: "issue/1-change",
      startPoint: base,
    });
    fs.writeFileSync(path.join(worktree.path, "value.txt"), "after\n");
    await manager.stageAll(worktree);
    const diff = await manager.diff(worktree, { staged: true, baseRef: base });
    expect(diff.nameStatus).toEqual([{ status: "M", path: "value.txt" }]);
    const head = await manager.commit(worktree, "feat: change value");
    expect(head).toMatch(/^[a-f0-9]{40}$/u);
    expect(await manager.isAncestor(repository, base, head)).toBe(true);
    await manager.push(worktree, { remote: "origin", branch: "issue/1-change" });
    expect(await manager.remoteBranchHead(repository, "origin", "issue/1-change")).toBe(head);
    await manager.removeWorktree(repository, worktree);
    expect(fs.existsSync(worktree.path)).toBe(false);
  });
});

function git(args: readonly string[], cwd: string): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8" });
}
