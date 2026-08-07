import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAgent } from "../../src/agent.js";
import { DenyApprovalPort } from "../../src/approval.js";
import type { ApprovalPort, ToolCall } from "../../src/domain.js";
import type { RunConfig } from "../../src/config.js";
import { SessionJournal } from "../../src/session.js";
import { ToolRunner } from "../../src/tools.js";
import { Workspace } from "../../src/workspace.js";
import {
  CaptureReporter,
  makeTempDir,
  removeTempDir,
  ScriptedProvider,
} from "../helpers.js";

const approved: ApprovalPort = { request: async () => "approved" };

describe("runAgent", () => {
  let root: string;
  let home: string;
  let workspace: Workspace;
  let config: RunConfig;

  beforeEach(() => {
    root = makeTempDir("agent");
    home = path.join(root, "home");
    workspace = new Workspace(root);
    config = {
      apiKey: "test-key",
      baseUrl: "http://127.0.0.1:1/v1",
      model: "test-model",
      home,
      maxRounds: 5,
      maxToolCalls: 10,
      shellTimeoutMs: 1_000,
    };
  });

  afterEach(() => removeTempDir(root));

  const toolCall = (
    id: string,
    name: string,
    args: Record<string, unknown>,
  ): ToolCall => ({
    id,
    name,
    argumentsJson: JSON.stringify(args),
  });

  it("persists a complete final answer", async () => {
    const journal = SessionJournal.create(home, workspace.root, config.model);
    const reporter = new CaptureReporter();
    const provider = new ScriptedProvider([
      [{ type: "text_delta", delta: "done" }],
    ]);

    const result = await runAgent({
      prompt: "finish",
      config,
      workspace,
      provider,
      tools: new ToolRunner(),
      journal,
      reporter,
      approvalMode: "ask",
      approval: approved,
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({ ok: true, exitCode: 0, reason: "completed" });
    expect(journal.messages().map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
    ]);
    expect(reporter.events.at(-1)).toMatchObject({ type: "run.finished" });
    journal.release();
  });

  it("runs a read tool and returns its result to the provider", async () => {
    fs.writeFileSync(path.join(root, "README.md"), "hello from workspace");
    const journal = SessionJournal.create(home, workspace.root, config.model);
    const provider = new ScriptedProvider([
      [
        {
          type: "tool_call",
          call: toolCall("read-1", "read", { path: "README.md" }),
        },
      ],
      [{ type: "text_delta", delta: "I read it." }],
    ]);

    const result = await runAgent({
      prompt: "read the readme",
      config,
      workspace,
      provider,
      tools: new ToolRunner(),
      journal,
      reporter: new CaptureReporter(),
      approvalMode: "deny",
      approval: new DenyApprovalPort(),
      signal: new AbortController().signal,
    });

    expect(result.ok).toBe(true);
    const secondRequest = provider.requests[1]!;
    expect(JSON.stringify(secondRequest.messages)).toContain("hello from workspace");
    journal.release();
  });

  it("persists a denied mutation and lets the model recover", async () => {
    const journal = SessionJournal.create(home, workspace.root, config.model);
    const provider = new ScriptedProvider([
      [
        {
          type: "tool_call",
          call: toolCall("write-1", "write", {
            path: "denied.txt",
            content: "should not exist",
          }),
        },
      ],
      [{ type: "text_delta", delta: "The edit was denied." }],
    ]);

    const result = await runAgent({
      prompt: "write a file",
      config,
      workspace,
      provider,
      tools: new ToolRunner(),
      journal,
      reporter: new CaptureReporter(),
      approvalMode: "ask",
      approval: new DenyApprovalPort(),
      signal: new AbortController().signal,
    });

    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(root, "denied.txt"))).toBe(false);
    expect(JSON.stringify(provider.requests[1]!.messages)).toContain("denied");
    journal.release();
  });

  it("pairs every tool call when cancellation happens inside a batch", async () => {
    const journal = SessionJournal.create(home, workspace.root, config.model);
    const controller = new AbortController();
    const cancellingApproval: ApprovalPort = {
      request: async () => {
        controller.abort(new DOMException("cancel", "AbortError"));
        return "cancelled";
      },
    };
    const provider = new ScriptedProvider([
      [
        {
          type: "tool_call",
          call: toolCall("write-1", "write", { path: "a.txt", content: "a" }),
        },
        {
          type: "tool_call",
          call: toolCall("write-2", "write", { path: "b.txt", content: "b" }),
        },
      ],
    ]);

    const result = await runAgent({
      prompt: "write two files",
      config,
      workspace,
      provider,
      tools: new ToolRunner(),
      journal,
      reporter: new CaptureReporter(),
      approvalMode: "ask",
      approval: cancellingApproval,
      signal: controller.signal,
    });

    expect(result).toMatchObject({ exitCode: 130, reason: "cancelled" });
    const toolMessages = journal.messages().filter((message) => message.role === "tool");
    expect(toolMessages).toHaveLength(2);
    expect(toolMessages.every((message) => message.outcome === "cancelled")).toBe(true);
    journal.release();
  });
});
