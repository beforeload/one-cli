import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  DEFAULT_CONTEXT_RECENT_TURNS,
  DEFAULT_MAX_CONTEXT_BYTES,
  DEFAULT_MAX_CONTEXT_MESSAGES,
  MAX_SESSION_BYTES,
} from "./config.js";
import type {
  ApprovalDecision,
  ChatMessage,
  ContextCompactionOptions,
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

  messages(options: Partial<ContextCompactionOptions> = {}): ChatMessage[] {
    const messages = this.envelopes
      .filter(
        (envelope): envelope is SessionEnvelope & {
          record: Extract<SessionRecord, { type: "message.appended" }>;
        } => envelope.record.type === "message.appended",
      )
      .map((envelope) => envelope.record.message);
    return liveContext(messages, resolveCompactionOptions(options));
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    fs.closeSync(this.descriptor);
    releaseLock(this.lockPath);
  }
}

export function compactMessages(
  messages: readonly ChatMessage[],
  options: Partial<ContextCompactionOptions> = {},
): ChatMessage[] {
  const limits = resolveCompactionOptions(options);
  if (
    messages.length <= limits.maxMessages &&
    messagesByteLength(messages) <= limits.maxBytes
  ) {
    return [...messages];
  }

  const selected = new Set<number>();
  const systemIndexes: number[] = [];
  for (let index = 0; index < messages.length; index++) {
    if (messages[index]!.role === "system") {
      systemIndexes.push(index);
      selected.add(index);
    }
  }

  const turns = conversationTurns(messages);
  for (const turn of turns.slice(-limits.recentTurns)) {
    for (const index of turn) selected.add(index);
  }
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]!.role !== "user") continue;
    selected.add(index);
    break;
  }

  const receipts = toolReceiptGroups(messages);
  for (const receipt of receipts) {
    if (!receipt.complete) {
      for (const index of receipt.indexes) selected.add(index);
    }
  }

  for (const receipt of [...receipts].reverse()) {
    if (!receipt.complete || receipt.indexes.every((index) => selected.has(index))) continue;
    const candidate = new Set(selected);
    for (const index of receipt.indexes) candidate.add(index);
    const candidateMessages = messagesAt(messages, candidate);
    if (
      candidateMessages.length <= limits.maxMessages &&
      messagesByteLength(candidateMessages) <= limits.maxBytes
    ) {
      for (const index of receipt.indexes) selected.add(index);
    }
  }

  const omitted = messages.length - selected.size;
  const notice: ChatMessage = {
    role: "system",
    content:
      `[Earlier context compacted deterministically: ${omitted} message` +
      `${omitted === 1 ? "" : "s"} omitted; complete evidence remains in the append-only session journal.]`,
  };
  const selectedMessages = messagesAt(messages, selected);
  const includeNotice =
    omitted > 0 &&
    selectedMessages.length + 1 <= limits.maxMessages &&
    messagesByteLength([...selectedMessages, notice]) <= limits.maxBytes;

  const systems = systemIndexes.map((index) => messages[index]!);
  const conversation = messages
    .map((message, index) => ({ message, index }))
    .filter(({ message, index }) => message.role !== "system" && selected.has(index))
    .map(({ message }) => message);
  return includeNotice ? [...systems, notice, ...conversation] : [...systems, ...conversation];
}

function liveContext(
  messages: ChatMessage[],
  options: ContextCompactionOptions,
): ChatMessage[] {
  const source = [...messages];
  const view = compactMessages(source, options);
  return new Proxy(view, {
    get(target, property, receiver) {
      if (property !== "push") return Reflect.get(target, property, receiver);
      return (...added: ChatMessage[]): number => {
        source.push(...added);
        const compacted = compactMessages(source, options);
        target.splice(0, target.length, ...compacted);
        return source.length;
      };
    },
  });
}

function resolveCompactionOptions(
  options: Partial<ContextCompactionOptions>,
): ContextCompactionOptions {
  const resolved = {
    maxMessages: options.maxMessages ?? DEFAULT_MAX_CONTEXT_MESSAGES,
    maxBytes: options.maxBytes ?? DEFAULT_MAX_CONTEXT_BYTES,
    recentTurns: options.recentTurns ?? DEFAULT_CONTEXT_RECENT_TURNS,
  };
  if (!Number.isInteger(resolved.maxMessages) || resolved.maxMessages < 1) {
    throw new Error("Context message limit must be a positive integer");
  }
  if (!Number.isInteger(resolved.maxBytes) || resolved.maxBytes < 1) {
    throw new Error("Context byte limit must be a positive integer");
  }
  if (!Number.isInteger(resolved.recentTurns) || resolved.recentTurns < 0) {
    throw new Error("Recent context turn count must be a non-negative integer");
  }
  return resolved;
}

function conversationTurns(messages: readonly ChatMessage[]): number[][] {
  const turns: number[][] = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    if (message.role === "system") continue;
    if (message.role === "assistant" && message.toolCalls?.length) {
      const turn = [index];
      while (messages[index + 1]?.role === "tool") turn.push(++index);
      turns.push(turn);
      continue;
    }
    turns.push([index]);
  }
  return turns;
}

function toolReceiptGroups(
  messages: readonly ChatMessage[],
): Array<{ indexes: number[]; complete: boolean }> {
  const groups: Array<{ indexes: number[]; complete: boolean }> = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    if (message.role !== "assistant" || !message.toolCalls?.length) continue;
    const callIds = new Set(message.toolCalls.map((call) => call.id));
    const matched = new Set<string>();
    const indexes = [index];
    for (let following = index + 1; following < messages.length; following++) {
      const result = messages[following]!;
      if (result.role !== "tool") break;
      if (callIds.has(result.toolCallId) && !matched.has(result.toolCallId)) {
        indexes.push(following);
        matched.add(result.toolCallId);
      }
    }
    groups.push({ indexes, complete: matched.size === callIds.size });
  }
  return groups;
}

function messagesAt(messages: readonly ChatMessage[], indexes: ReadonlySet<number>): ChatMessage[] {
  return messages.filter((_, index) => indexes.has(index));
}

function messagesByteLength(messages: readonly ChatMessage[]): number {
  return messages.reduce(
    (total, message) => total + Buffer.byteLength(JSON.stringify(message), "utf8"),
    0,
  );
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
