import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionJournal } from "../../src/session.js";
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
