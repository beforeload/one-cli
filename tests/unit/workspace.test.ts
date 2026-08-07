import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Workspace } from "../../src/workspace.js";
import { makeTempDir, removeTempDir } from "../helpers.js";

describe("Workspace", () => {
  let root: string;
  let workspacePath: string;

  beforeEach(() => {
    root = makeTempDir("workspace");
    workspacePath = path.join(root, "repo");
    fs.mkdirSync(workspacePath);
  });

  afterEach(() => removeTempDir(root));

  it("reads files and reports deterministic directory entries", () => {
    fs.writeFileSync(path.join(workspacePath, "b.txt"), "second");
    fs.writeFileSync(path.join(workspacePath, "a.txt"), "first");
    const workspace = new Workspace(workspacePath);

    expect(workspace.read("a.txt")).toBe("first");
    expect(workspace.list()).toEqual(["a.txt\tfile", "b.txt\tfile"]);
  });

  it("rejects lexical traversal and absolute paths", () => {
    const workspace = new Workspace(workspacePath);
    expect(() => workspace.read("../outside.txt")).toThrow("escapes");
    expect(() => workspace.read("/etc/passwd")).toThrow("Absolute");
  });

  it("does not follow a symlink outside the workspace", () => {
    const outside = path.join(root, "outside.txt");
    fs.writeFileSync(outside, "secret");
    fs.symlinkSync(outside, path.join(workspacePath, "escape"));
    const workspace = new Workspace(workspacePath);

    expect(() => workspace.read("escape")).toThrow("Symlinks");
    expect(workspace.list()).toContain("escape\tsymlink");
  });

  it("atomically creates and replaces regular files", () => {
    const workspace = new Workspace(workspacePath);
    const create = workspace.snapshot("new.txt");
    workspace.atomicWrite(create, "v1");
    expect(fs.readFileSync(path.join(workspacePath, "new.txt"), "utf8")).toBe("v1");

    const replace = workspace.snapshot("new.txt");
    workspace.atomicWrite(replace, "v2");
    expect(fs.readFileSync(path.join(workspacePath, "new.txt"), "utf8")).toBe("v2");
  });

  it("refuses a stale target after approval", () => {
    fs.writeFileSync(path.join(workspacePath, "file.txt"), "before");
    const workspace = new Workspace(workspacePath);
    const snapshot = workspace.snapshot("file.txt");
    fs.writeFileSync(path.join(workspacePath, "file.txt"), "changed elsewhere");

    expect(() => workspace.atomicWrite(snapshot, "agent change")).toThrow("changed after approval");
  });

  it("greps literal text without traversing ignored directories", () => {
    fs.mkdirSync(path.join(workspacePath, ".git"));
    fs.writeFileSync(path.join(workspacePath, ".git", "hidden"), "needle");
    fs.writeFileSync(path.join(workspacePath, "visible.txt"), "one\nNeedle here\n");
    const workspace = new Workspace(workspacePath);

    expect(workspace.grep("needle")).toEqual(["visible.txt:2:Needle here"]);
  });
});
