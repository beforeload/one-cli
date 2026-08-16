import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatMessage } from "../../src/domain.js";
import { compactMessages, SessionJournal } from "../../src/session.js";
import { makeTempDir, removeTempDir } from "../helpers.js";

describe("SessionJournal", () => {
  let root: string;
  let home: string;
  let workspace: string;

  beforeEach(() => {
    root = makeTempDir("session");
    home = path.join(root, "home");
    workspace = path.join(root, "workspace");
    fs.mkdirSync(workspace);
  });

  afterEach(() => removeTempDir(root));

  it("persists messages and resumes only in the bound workspace", () => {
    const journal = SessionJournal.create(home, workspace, "test-model");
    const id = journal.sessionId;
    journal.append({ type: "message.appended", message: { role: "user", content: "hello" } });
    journal.release();

    const resumed = SessionJournal.resume(home, id, workspace);
    expect(resumed.messages()).toEqual([{ role: "user", content: "hello" }]);
    resumed.release();

    const other = path.join(root, "other");
    fs.mkdirSync(other);
    expect(() => SessionJournal.resume(home, id, other)).toThrow("different workspace");
  });

  it("repairs one torn trailing record before appending", () => {
    const journal = SessionJournal.create(home, workspace, "test-model");
    const id = journal.sessionId;
    const filePath = journal.filePath;
    journal.release();
    fs.appendFileSync(filePath, '{"schema":"one-cli.session"');

    const resumed = SessionJournal.resume(home, id, workspace);
    resumed.append({
      type: "message.appended",
      message: { role: "user", content: "after crash" },
    });
    resumed.release();

    const loaded = SessionJournal.resume(home, id, workspace);
    expect(loaded.messages()).toEqual([{ role: "user", content: "after crash" }]);
    loaded.release();
  });

  it("compacts only beyond the boundary and replays deterministically", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "constraint" },
      { role: "user", content: "first" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "latest" },
      { role: "assistant", content: "latest answer" },
    ];
    const options = { maxMessages: 4, maxBytes: 10_000, recentTurns: 1 };

    expect(compactMessages(messages.slice(0, 4), options)).toEqual(messages.slice(0, 4));
    const first = compactMessages(messages, options);
    expect(first).toHaveLength(4);
    expect(first).toContainEqual({ role: "system", content: "constraint" });
    expect(first).toContainEqual({ role: "user", content: "latest" });
    expect(first).toContainEqual({ role: "assistant", content: "latest answer" });
    expect(compactMessages(messages, options)).toEqual(first);
    expect(compactMessages(first, options)).toEqual(first);
  });

  it("retains complete tool receipts when older prose is compacted", () => {
    const call = { id: "read-1", name: "read", argumentsJson: '{"path":"a.txt"}' };
    const messages: ChatMessage[] = [
      { role: "system", content: "constraint" },
      { role: "user", content: "old request" },
      { role: "assistant", content: null, toolCalls: [call] },
      { role: "tool", toolCallId: call.id, content: "receipt", outcome: "succeeded" },
      { role: "user", content: "latest request" },
      { role: "assistant", content: "latest answer" },
    ];

    const compacted = compactMessages(messages, {
      maxMessages: 5,
      maxBytes: 10_000,
      recentTurns: 1,
    });
    const assistantIndex = compacted.findIndex(
      (message) => message.role === "assistant" && message.toolCalls?.[0]?.id === call.id,
    );
    expect(assistantIndex).toBeGreaterThanOrEqual(0);
    expect(compacted[assistantIndex + 1]).toEqual(messages[3]);
    expect(compacted).not.toContainEqual({ role: "user", content: "old request" });
  });

  it("produces the same compacted context after append-only resume", () => {
    const journal = SessionJournal.create(home, workspace, "test-model");
    const id = journal.sessionId;
    for (let index = 0; index < 12; index++) {
      journal.append({
        type: "message.appended",
        message: { role: index % 2 === 0 ? "user" : "assistant", content: `message-${index}` },
      });
    }
    const options = { maxMessages: 5, maxBytes: 10_000, recentTurns: 2 };
    const journalBeforeCompaction = fs.readFileSync(journal.filePath, "utf8");
    const before = journal.messages(options);
    expect(fs.readFileSync(journal.filePath, "utf8")).toBe(journalBeforeCompaction);
    journal.release();

    const resumed = SessionJournal.resume(home, id, workspace);
    expect(resumed.messages(options)).toEqual(before);
    resumed.release();
  });

  it("refuses automatic resume after an in-doubt execution", () => {
    const journal = SessionJournal.create(home, workspace, "test-model");
    const id = journal.sessionId;
    journal.append({ type: "tool.started", callId: "call-1", toolName: "write" });
    journal.release();

    expect(() => SessionJournal.resume(home, id, workspace)).toThrow("in-doubt");
  });

  it("lists healthy workspace sessions", () => {
    const first = SessionJournal.create(home, workspace, "model-a");
    const firstId = first.sessionId;
    first.release();
    const second = SessionJournal.create(home, workspace, "model-b");
    const secondId = second.sessionId;
    second.release();

    expect(
      new Set(SessionJournal.list(home, workspace).map((item) => item.sessionId)),
    ).toEqual(new Set([firstId, secondId]));
  });
});
