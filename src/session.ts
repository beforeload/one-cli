import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { MAX_SESSION_BYTES } from "./config.js";
import type {
  ApprovalDecision,
  ChatMessage,
  RunResult,
  ToolOutcome,
} from "./domain.js";

export const SESSION_SCHEMA = "one-cli.session";
export const SESSION_VERSION = 1;

export type SessionRecord =
  | { type: "session.created"; workspace: string; model: string }
  | { type: "run.started"; runId: string; model: string }
  | { type: "message.appended"; message: ChatMessage }
  | {
      type: "approval.resolved";
      callId: string;
      toolName: string;
      decision: ApprovalDecision;
    }
  | { type: "tool.started"; callId: string; toolName: string }
  | {
      type: "tool.finished";
      callId: string;
      toolName: string;
      outcome: ToolOutcome;
    }
  | { type: "run.finished"; runId: string; result: RunResult };

export interface SessionEnvelope {
  schema: typeof SESSION_SCHEMA;
  version: typeof SESSION_VERSION;
  sessionId: string;
  seq: number;
  ts: string;
  record: SessionRecord;
}

export interface SessionSummary {
  sessionId: string;
  workspace: string;
  model: string;
  createdAt: string;
}

const SessionIdSchema = z.string().uuid();

export class SessionJournal {
  readonly sessionId: string;
  readonly workspace: string;
  readonly model: string;
  readonly filePath: string;

  private readonly lockPath: string;
  private descriptor: number;
  private nextSeq: number;
  private released = false;
  private readonly envelopes: SessionEnvelope[];

  private constructor(options: {
    sessionId: string;
    workspace: string;
    model: string;
    filePath: string;
    lockPath: string;
    descriptor: number;
    envelopes: SessionEnvelope[];
  }) {
    this.sessionId = options.sessionId;
    this.workspace = options.workspace;
    this.model = options.model;
    this.filePath = options.filePath;
    this.lockPath = options.lockPath;
    this.descriptor = options.descriptor;
    this.envelopes = options.envelopes;
    this.nextSeq = options.envelopes.length + 1;
  }

  static create(home: string, workspace: string, model: string): SessionJournal {
    const directory = sessionsDirectory(home);
    ensureDirectory(directory);
    const sessionId = randomUUID();
    const filePath = path.join(directory, `${sessionId}.jsonl`);
    const lockPath = `${filePath}.lock`;
    acquireLock(lockPath);
    try {
      const descriptor = fs.openSync(filePath, "wx", 0o600);
      const journal = new SessionJournal({
        sessionId,
        workspace,
        model,
        filePath,
        lockPath,
        descriptor,
        envelopes: [],
      });
      journal.append({ type: "session.created", workspace, model });
      return journal;
    } catch (error) {
      releaseLock(lockPath);
      throw error;
    }
  }

  static resume(home: string, sessionId: string, workspace: string): SessionJournal {
    SessionIdSchema.parse(sessionId);
    const filePath = path.join(sessionsDirectory(home), `${sessionId}.jsonl`);
    const lockPath = `${filePath}.lock`;
    acquireLock(lockPath);
    try {
      normalizeTrailingLine(filePath);
      const envelopes = loadEnvelopes(filePath, sessionId);
      const created = envelopes[0]?.record;
      if (!created || created.type !== "session.created") {
        throw new Error("Session is missing its creation record");
      }
      if (created.workspace !== workspace) {
        throw new Error("Session belongs to a different workspace");
      }
      assertNoInDoubtTools(envelopes);
      return new SessionJournal({
        sessionId,
        workspace,
        model: created.model,
        filePath,
        lockPath,
        descriptor: fs.openSync(filePath, "a", 0o600),
        envelopes,
      });
    } catch (error) {
      releaseLock(lockPath);
      throw error;
    }
  }

  static list(home: string, workspace?: string): SessionSummary[] {
    const directory = sessionsDirectory(home);
    if (!fs.existsSync(directory)) return [];
    const summaries: SessionSummary[] = [];
    for (const entry of fs.readdirSync(directory)) {
      if (!entry.endsWith(".jsonl")) continue;
      const sessionId = entry.slice(0, -".jsonl".length);
      if (!SessionIdSchema.safeParse(sessionId).success) continue;
      try {
        const envelopes = loadEnvelopes(path.join(directory, entry), sessionId);
        const first = envelopes[0];
        if (!first || first.record.type !== "session.created") continue;
        if (workspace && first.record.workspace !== workspace) continue;
        summaries.push({
          sessionId,
          workspace: first.record.workspace,
          model: first.record.model,
          createdAt: first.ts,
        });
      } catch {
        // Corrupt sessions are omitted from the convenience listing, never deleted.
      }
    }
    return summaries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  append(record: SessionRecord): SessionEnvelope {
    if (this.released) throw new Error("Session journal is closed");
    const envelope: SessionEnvelope = {
      schema: SESSION_SCHEMA,
      version: SESSION_VERSION,
      sessionId: this.sessionId,
      seq: this.nextSeq++,
      ts: new Date().toISOString(),
      record,
    };
    const line = `${JSON.stringify(envelope)}\n`;
    fs.writeSync(this.descriptor, line, undefined, "utf8");
    fs.fdatasyncSync(this.descriptor);
    this.envelopes.push(envelope);
    return envelope;
  }

  messages(): ChatMessage[] {
    return this.envelopes
      .filter(
        (envelope): envelope is SessionEnvelope & {
          record: Extract<SessionRecord, { type: "message.appended" }>;
        } => envelope.record.type === "message.appended",
      )
      .map((envelope) => envelope.record.message);
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    fs.closeSync(this.descriptor);
    releaseLock(this.lockPath);
  }
}

function sessionsDirectory(home: string): string {
  return path.join(home, "sessions");
}

function ensureDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(directory, 0o700);
  } catch {
    // Best effort on platforms without POSIX modes.
  }
}

function loadEnvelopes(filePath: string, sessionId: string): SessionEnvelope[] {
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_SESSION_BYTES) {
    throw new Error("Session exceeds the replay size limit");
  }
  const content = fs.readFileSync(filePath, "utf8");
  const hasFinalNewline = content.endsWith("\n");
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const envelopes: SessionEnvelope[] = [];

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      if (index === lines.length - 1 && !hasFinalNewline) break;
      throw new Error(`Session contains invalid JSON at line ${index + 1}`);
    }
    if (!isEnvelope(value)) throw new Error(`Invalid session record at line ${index + 1}`);
    if (value.sessionId !== sessionId) throw new Error("Session id mismatch");
    if (value.seq !== envelopes.length + 1) throw new Error("Session sequence gap");
    envelopes.push(value);
  }
  return envelopes;
}

function normalizeTrailingLine(filePath: string): void {
  const content = fs.readFileSync(filePath, "utf8");
  if (!content || content.endsWith("\n")) return;
  const lastNewline = content.lastIndexOf("\n");
  const tail = content.slice(lastNewline + 1);
  try {
    JSON.parse(tail);
    fs.appendFileSync(filePath, "\n", "utf8");
  } catch {
    fs.truncateSync(filePath, Buffer.byteLength(content.slice(0, lastNewline + 1)));
  }
}

function isEnvelope(value: unknown): value is SessionEnvelope {
  if (!value || typeof value !== "object") return false;
  const envelope = value as Record<string, unknown>;
  const record = envelope.record;
  return (
    envelope.schema === SESSION_SCHEMA &&
    envelope.version === SESSION_VERSION &&
    typeof envelope.sessionId === "string" &&
    typeof envelope.seq === "number" &&
    typeof envelope.ts === "string" &&
    !!record &&
    typeof record === "object" &&
    typeof (record as Record<string, unknown>).type === "string"
  );
}

function assertNoInDoubtTools(envelopes: readonly SessionEnvelope[]): void {
  const pending = new Set<string>();
  for (const envelope of envelopes) {
    const record = envelope.record;
    if (record.type === "tool.started") pending.add(record.callId);
    if (record.type === "tool.finished") pending.delete(record.callId);
  }
  if (pending.size > 0) {
    throw new Error("Session contains an in-doubt tool execution and cannot resume automatically");
  }
}

function acquireLock(lockPath: string): void {
  const attempt = (): void => {
    try {
      const descriptor = fs.openSync(lockPath, "wx", 0o600);
      fs.writeFileSync(descriptor, `${process.pid}\n`, "utf8");
      fs.closeSync(descriptor);
      return;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") {
        throw error;
      }
    }

    let active = true;
    try {
      const pid = Number(fs.readFileSync(lockPath, "utf8").trim());
      if (!Number.isInteger(pid) || pid <= 0) active = false;
      else process.kill(pid, 0);
    } catch {
      active = false;
    }
    if (active) throw new Error("Session is already in use");
    fs.unlinkSync(lockPath);
    attempt();
  };
  attempt();
}

function releaseLock(lockPath: string): void {
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // Lock was already removed.
  }
}
