import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DenyApprovalPort } from "../../src/approval.js";
import type { ApprovalPort, ToolCall } from "../../src/domain.js";
import { ToolRunner } from "../../src/tools.js";
import { Workspace } from "../../src/workspace.js";
import { makeTempDir, removeTempDir } from "../helpers.js";

const approved: ApprovalPort = {
  request: async () => "approved",
};

describe("ToolRunner", () => {
  let root: string;
  let workspace: Workspace;
  let runner: ToolRunner;

  beforeEach(() => {
    root = makeTempDir("tools");
    workspace = new Workspace(root);
    runner = new ToolRunner();
  });

  afterEach(() => removeTempDir(root));

  const call = (name: string, args: Record<string, unknown>): ToolCall => ({
    id: `call-${name}`,
    name,
    argumentsJson: JSON.stringify(args),
  });

  it("publishes all built-in tool schemas", () => {
    expect(runner.specs().map((tool) => tool.name)).toEqual([
      "read",
      "list",
      "grep",
      "write",
      "edit",
      "shell",
    ]);
  });

  it("allows reads without approval", async () => {
    fs.writeFileSync(path.join(root, "file.txt"), "hello");
    const result = await runner.run(call("read", { path: "file.txt" }), {
      workspace,
      approvalMode: "deny",
      approval: new DenyApprovalPort(),
      shellTimeoutMs: 1_000,
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ outcome: "succeeded", content: "hello" });
  });

  it("denies writes without approval and performs them under all mode", async () => {
    const denied = await runner.run(call("write", { path: "file.txt", content: "hello" }), {
      workspace,
      approvalMode: "ask",
      approval: new DenyApprovalPort(),
      shellTimeoutMs: 1_000,
      signal: new AbortController().signal,
    });
    expect(denied.outcome).toBe("denied");
    expect(fs.existsSync(path.join(root, "file.txt"))).toBe(false);

    const written = await runner.run(call("write", { path: "file.txt", content: "hello" }), {
      workspace,
      approvalMode: "all",
      approval: approved,
      shellTimeoutMs: 1_000,
      signal: new AbortController().signal,
    });
    expect(written.outcome).toBe("succeeded");
    expect(fs.readFileSync(path.join(root, "file.txt"), "utf8")).toBe("hello");
  });

  it("edits by literal slicing rather than replacement expansion", async () => {
    fs.writeFileSync(path.join(root, "file.txt"), "price=$1");
    const result = await runner.run(
      call("edit", {
        path: "file.txt",
        oldText: "$1",
        newText: "$& $$ $1",
      }),
      {
        workspace,
        approvalMode: "all",
        approval: approved,
        shellTimeoutMs: 1_000,
        signal: new AbortController().signal,
      },
    );
    expect(result.outcome).toBe("succeeded");
    expect(fs.readFileSync(path.join(root, "file.txt"), "utf8")).toBe(
      "price=$& $$ $1",
    );
  });

  it("does not let permissive approval bypass hard policy", async () => {
    const result = await runner.run(call("write", { path: ".env", content: "SECRET=x" }), {
      workspace,
      approvalMode: "all",
      approval: approved,
      shellTimeoutMs: 1_000,
      signal: new AbortController().signal,
    });
    expect(result.outcome).toBe("denied");
    expect(fs.existsSync(path.join(root, ".env"))).toBe(false);
  });

  it("runs shell with a sanitized environment", async () => {
    process.env.MY_SUPER_SECRET = "do-not-inherit";
    const result = await runner.run(
      call("shell", { command: 'printf "${MY_SUPER_SECRET-unset}"' }),
      {
        workspace,
        approvalMode: "all",
        approval: approved,
        shellTimeoutMs: 1_000,
        signal: new AbortController().signal,
      },
    );
    delete process.env.MY_SUPER_SECRET;
    expect(result.outcome).toBe("succeeded");
    expect(result.content).toContain("unset");
    expect(result.content).not.toContain("do-not-inherit");
  });
});
