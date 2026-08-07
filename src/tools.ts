import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { z } from "zod";
import {
  MAX_SHELL_OUTPUT_BYTES,
  MAX_TOOL_ARGUMENT_BYTES,
  MAX_TOOL_RESULT_BYTES,
  MAX_WRITE_BYTES,
} from "./config.js";
import { approvalRequirement, neutralize } from "./approval.js";
import type {
  ApprovalDecision,
  ApprovalMode,
  ApprovalPort,
  ToolCall,
  ToolResult,
  ToolRisk,
  ToolSpec,
} from "./domain.js";
import { errorMessage } from "./domain.js";
import { evaluateHardPolicy } from "./policy.js";
import type { Workspace } from "./workspace.js";
import { sha256 } from "./workspace.js";

interface PreparedTool {
  summary: string;
  execute(signal: AbortSignal): Promise<ToolResult>;
}

interface ToolDefinition {
  name: string;
  description: string;
  risk: ToolRisk;
  schema: z.ZodType;
  prepare(input: unknown, context: ToolContext): Promise<PreparedTool>;
}

export interface ToolContext {
  workspace: Workspace;
  approvalMode: ApprovalMode;
  approval: ApprovalPort;
  shellTimeoutMs: number;
  signal: AbortSignal;
}

export interface ToolCallbacks {
  approvalRequested?(summary: string): void;
  approvalResolved?(decision: ApprovalDecision): void;
  executionStarted?(): void;
}

const ReadSchema = z.object({
  path: z.string().min(1),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(10_000).optional(),
});

const ListSchema = z.object({
  path: z.string().default("."),
});

const GrepSchema = z.object({
  query: z.string().min(1),
  path: z.string().default("."),
  caseSensitive: z.boolean().default(false),
});

const WriteSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
});

const EditSchema = z.object({
  path: z.string().min(1),
  oldText: z.string().min(1),
  newText: z.string(),
});

const ShellSchema = z.object({
  command: z.string().min(1).max(16 * 1024),
  timeoutMs: z.number().int().min(1).optional(),
});

export class ToolRunner {
  private readonly tools: Map<string, ToolDefinition>;

  constructor(definitions: readonly ToolDefinition[] = builtInTools()) {
    this.tools = new Map(definitions.map((tool) => [tool.name, tool]));
  }

  specs(): ToolSpec[] {
    return [...this.tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: JSON.parse(JSON.stringify(z.toJSONSchema(tool.schema))) as Record<string, unknown>,
    }));
  }

  async run(
    call: ToolCall,
    context: ToolContext,
    callbacks: ToolCallbacks = {},
  ): Promise<ToolResult> {
    const started = Date.now();
    const tool = this.tools.get(call.name);
    if (!tool) return result("failed", `Unknown tool: ${call.name}`, started);
    if (Buffer.byteLength(call.argumentsJson) > MAX_TOOL_ARGUMENT_BYTES) {
      return result("failed", "Tool arguments exceed the size limit", started);
    }

    let raw: unknown;
    try {
      raw = JSON.parse(call.argumentsJson);
    } catch {
      return result("failed", "Tool arguments are not valid JSON", started);
    }
    const parsed = tool.schema.safeParse(raw);
    if (!parsed.success) {
      return result("failed", `Invalid tool arguments: ${parsed.error.issues[0]?.message ?? "unknown error"}`, started);
    }
    const input = parsed.data as Record<string, unknown>;

    const policy = evaluateHardPolicy(tool.name, input, tool.risk);
    if (!policy.allowed) {
      return result("denied", `Hard policy denied (${policy.rule}): ${policy.message}`, started);
    }
    if (context.signal.aborted) return result("cancelled", "Tool call cancelled", started);

    let prepared: PreparedTool;
    try {
      prepared = await tool.prepare(input, context);
    } catch (error) {
      return result("failed", errorMessage(error), started);
    }

    const requirement = approvalRequirement(context.approvalMode, tool.risk);
    if (requirement === "deny") {
      return result("denied", "Mutation denied by approval mode", started);
    }
    if (requirement === "prompt") {
      callbacks.approvalRequested?.(prepared.summary);
      const decision = await context.approval.request(
        { toolName: tool.name, risk: tool.risk, summary: prepared.summary },
        context.signal,
      );
      callbacks.approvalResolved?.(decision);
      if (decision !== "approved") {
        return result(
          decision === "cancelled" ? "cancelled" : "denied",
          decision === "cancelled" ? "Approval cancelled" : "Tool execution denied",
          started,
        );
      }
    }
    if (context.signal.aborted) return result("cancelled", "Tool call cancelled", started);

    try {
      callbacks.executionStarted?.();
      const executed = await prepared.execute(context.signal);
      return boundResult({ ...executed, durationMs: Date.now() - started });
    } catch (error) {
      return result("failed", errorMessage(error), started);
    }
  }
}

function builtInTools(): ToolDefinition[] {
  return [
    {
      name: "read",
      description: "Read a UTF-8 file inside the workspace",
      risk: "read",
      schema: ReadSchema,
      prepare: async (value, context) => {
        const input = ReadSchema.parse(value);
        return {
          summary: `read ${input.path}`,
          execute: async () =>
            success(context.workspace.read(input.path, input.offset ?? 0, input.limit)),
        };
      },
    },
    {
      name: "list",
      description: "List immediate entries in a workspace directory without following symlinks",
      risk: "read",
      schema: ListSchema,
      prepare: async (value, context) => {
        const input = ListSchema.parse(value);
        return {
          summary: `list ${input.path}`,
          execute: async () => success(context.workspace.list(input.path).join("\n") || "(empty directory)"),
        };
      },
    },
    {
      name: "grep",
      description: "Search workspace text files for a literal string",
      risk: "read",
      schema: GrepSchema,
      prepare: async (value, context) => {
        const input = GrepSchema.parse(value);
        return {
          summary: `grep ${JSON.stringify(input.query)} under ${input.path}`,
          execute: async () =>
            success(
              context.workspace.grep(input.query, input.path, input.caseSensitive).join("\n") ||
                "(no matches)",
            ),
        };
      },
    },
    {
      name: "write",
      description: "Create or atomically replace a UTF-8 file inside the workspace",
      risk: "workspace_write",
      schema: WriteSchema,
      prepare: async (value, context) => {
        const input = WriteSchema.parse(value);
        if (Buffer.byteLength(input.content) > MAX_WRITE_BYTES) {
          throw new Error("Write content exceeds the size limit");
        }
        const snapshot = context.workspace.snapshot(input.path);
        const nextHash = sha256(input.content).slice(0, 12);
        return {
          summary:
            `${snapshot.exists ? "overwrite" : "create"} ${input.path}\n` +
            `bytes: ${Buffer.byteLength(input.content)}\n` +
            `before: ${snapshot.sha256?.slice(0, 12) ?? "<missing>"}\nafter: ${nextHash}`,
          execute: async () => {
            context.workspace.atomicWrite(snapshot, input.content);
            return success(`Wrote ${Buffer.byteLength(input.content)} bytes to ${input.path}`);
          },
        };
      },
    },
    {
      name: "edit",
      description: "Replace exactly one literal occurrence in a workspace file",
      risk: "workspace_write",
      schema: EditSchema,
      prepare: async (value, context) => {
        const input = EditSchema.parse(value);
        const snapshot = context.workspace.snapshot(input.path);
        if (!snapshot.exists) throw new Error("Edit target does not exist");
        const matches = countOccurrences(snapshot.content, input.oldText);
        if (matches !== 1) {
          throw new Error(`Edit requires exactly one match; found ${matches}`);
        }
        const index = snapshot.content.indexOf(input.oldText);
        const updated =
          snapshot.content.slice(0, index) +
          input.newText +
          snapshot.content.slice(index + input.oldText.length);
        return {
          summary:
            `edit ${input.path}\n` +
            `replace ${neutralize(JSON.stringify(input.oldText), 2_000)}\n` +
            `with    ${neutralize(JSON.stringify(input.newText), 2_000)}`,
          execute: async () => {
            context.workspace.atomicWrite(snapshot, updated);
            return success(`Edited ${input.path}`);
          },
        };
      },
    },
    {
      name: "shell",
      description: "Run a host-capable POSIX shell command with timeout and bounded output",
      risk: "host_shell",
      schema: ShellSchema,
      prepare: async (value, context) => {
        const input = ShellSchema.parse(value);
        const timeoutMs = Math.min(input.timeoutMs ?? context.shellTimeoutMs, context.shellTimeoutMs);
        return {
          summary:
            `host-capable command in workspace ${path.basename(context.workspace.root)}\n` +
            `timeout: ${timeoutMs}ms\ncommand: ${neutralize(input.command, 4_000)}`,
          execute: async (signal) =>
            runShell(input.command, context.workspace.root, timeoutMs, signal),
        };
      },
    },
  ];
}

function success(content: string): ToolResult {
  return { outcome: "succeeded", content, durationMs: 0, truncated: false };
}

function result(
  outcome: ToolResult["outcome"],
  content: string,
  started: number,
): ToolResult {
  return boundResult({
    outcome,
    content,
    durationMs: Date.now() - started,
    truncated: false,
  });
}

function boundResult(value: ToolResult): ToolResult {
  const bytes = Buffer.byteLength(value.content);
  if (bytes <= MAX_TOOL_RESULT_BYTES) return value;
  const content = Buffer.from(value.content).subarray(0, MAX_TOOL_RESULT_BYTES).toString("utf8");
  return { ...value, content: `${content}\n…[truncated]`, truncated: true };
}

function countOccurrences(content: string, needle: string): number {
  let count = 0;
  let cursor = 0;
  while (true) {
    const index = content.indexOf(needle, cursor);
    if (index < 0) return count;
    count++;
    cursor = index + needle.length;
  }
}

async function runShell(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<ToolResult> {
  const started = Date.now();
  const temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), "one-cli-shell-"));
  const environment = sanitizedEnvironment(temporaryHome);

  return await new Promise<ToolResult>((resolve) => {
    const child = spawn("/bin/sh", ["-c", command], {
      cwd,
      env: environment,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let totalBytes = 0;
    let truncated = false;
    let settled = false;
    let stopReason: "timeout" | "cancelled" | "output" | null = null;

    const cleanup = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      fs.rmSync(temporaryHome, { recursive: true, force: true });
    };
    const finish = (status: number | null, spawnError?: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      const output = [
        stdout.length ? `stdout:\n${stdout.toString("utf8")}` : "",
        stderr.length ? `stderr:\n${stderr.toString("utf8")}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      const outcome =
        stopReason === "cancelled"
          ? "cancelled"
          : status === 0 && stopReason === null && !spawnError
            ? "succeeded"
            : "failed";
      const reason = spawnError
        ? `Shell spawn failed: ${spawnError}`
        : stopReason === "timeout"
          ? `Shell timed out after ${timeoutMs}ms`
          : stopReason === "output"
            ? "Shell output limit exceeded"
            : stopReason === "cancelled"
              ? "Shell cancelled"
              : `Shell exited with status ${status ?? "unknown"}`;
      resolve(
        boundResult({
          outcome,
          content: output || (outcome === "succeeded" ? "(no output)" : reason),
          durationMs: Date.now() - started,
          truncated,
        }),
      );
    };
    const killGroup = () => {
      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGTERM");
        else child.kill("SIGTERM");
      } catch {
        // Process already exited.
      }
      setTimeout(() => {
        try {
          if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          // Process already exited.
        }
      }, 250).unref();
    };
    const stop = (reason: typeof stopReason) => {
      if (settled || stopReason !== null) return;
      stopReason = reason;
      killGroup();
    };
    const append = (target: "stdout" | "stderr", chunk: Buffer) => {
      if (totalBytes >= MAX_SHELL_OUTPUT_BYTES) return;
      const remaining = MAX_SHELL_OUTPUT_BYTES - totalBytes;
      const kept = chunk.subarray(0, remaining);
      totalBytes += kept.length;
      if (target === "stdout") stdout = Buffer.concat([stdout, kept]);
      else stderr = Buffer.concat([stderr, kept]);
      if (kept.length < chunk.length || totalBytes >= MAX_SHELL_OUTPUT_BYTES) {
        truncated = true;
        stop("output");
      }
    };
    const onAbort = () => stop("cancelled");
    const timeout = setTimeout(() => stop("timeout"), timeoutMs);
    timeout.unref();
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();

    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.on("error", (error) => finish(null, error.message));
    child.on("close", (status) => finish(status));
  });
}

function sanitizedEnvironment(home: string): NodeJS.ProcessEnv {
  const safe: NodeJS.ProcessEnv = { HOME: home };
  for (const key of ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TMPDIR"]) {
    const value = process.env[key];
    if (value !== undefined) safe[key] = value;
  }
  return safe;
}
