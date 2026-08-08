import { randomUUID } from "node:crypto";
import type {
  ApprovalMode,
  ApprovalPort,
  ChatMessage,
  ChatProvider,
  Reporter,
  RunReason,
  RunResult,
  ToolCall,
  ToolResult,
} from "./domain.js";
import { errorMessage, isAbortError } from "./domain.js";
import type { RunConfig } from "./config.js";
import type { SessionJournal } from "./session.js";
import type { ToolRunner } from "./tools.js";
import type { Workspace } from "./workspace.js";

const MAX_ASSISTANT_BYTES = 1024 * 1024;
const CANCELLED_TOOL_CONTENT = "Tool call cancelled before execution";

export interface RunAgentOptions {
  prompt: string;
  config: RunConfig;
  workspace: Workspace;
  provider: ChatProvider;
  tools: ToolRunner;
  journal: SessionJournal;
  reporter: Reporter;
  approvalMode: ApprovalMode;
  approval: ApprovalPort;
  signal: AbortSignal;
  runId?: string;
  systemPrompt?: string;
}

export async function runAgent(options: RunAgentOptions): Promise<RunResult> {
  const runId = options.runId ?? randomUUID();
  const messages = options.journal.messages();
  let toolCalls = 0;

  options.journal.append({ type: "run.started", runId, model: options.config.model });
  options.reporter.emit({ type: "run.started", model: options.config.model });

  if (messages.length === 0) {
    appendMessage(
      messages,
      options.journal,
      {
        role: "system",
        content:
          options.systemPrompt ??
          "You are a coding agent. Inspect before editing, use workspace-relative paths, " +
          "prefer the smallest safe change, and treat tool errors or denials as facts.",
      },
    );
  }
  appendMessage(messages, options.journal, { role: "user", content: options.prompt });

  for (let round = 1; round <= options.config.maxRounds; round++) {
    if (options.signal.aborted) {
      return finish(options, runId, false, 130, "cancelled", round - 1);
    }

    let assistantText = "";
    const calls: ToolCall[] = [];
    try {
      for await (const event of options.provider.stream(
        {
          model: options.config.model,
          messages,
          tools: options.tools.specs(),
        },
        options.signal,
      )) {
        if (event.type === "text_delta") {
          assistantText += event.delta;
          if (Buffer.byteLength(assistantText) > MAX_ASSISTANT_BYTES) {
            throw new Error("Assistant response exceeds the size limit");
          }
          options.reporter.emit({ type: "assistant.delta", delta: event.delta });
        } else if (event.type === "tool_call") {
          calls.push(event.call);
        } else if (event.type === "retry") {
          options.reporter.emit({
            type: "provider.retry",
            attempt: event.attempt,
            maxAttempts: event.maxAttempts,
            reason: event.reason,
            delayMs: event.delayMs,
          });
        } else {
          options.reporter.emit({
            type: "usage",
            promptTokens: event.promptTokens,
            completionTokens: event.completionTokens,
          });
        }
      }
    } catch (error) {
      const cancelled = options.signal.aborted || isAbortError(error);
      if (assistantText) {
        appendMessage(messages, options.journal, {
          role: "assistant",
          content: assistantText,
          state: "interrupted",
        });
        options.reporter.emit({
          type: "assistant.completed",
          text: assistantText,
          interrupted: true,
        });
      }
      if (cancelled) {
        return finish(options, runId, false, 130, "cancelled", round);
      }
      options.reporter.emit({ type: "error", message: errorMessage(error) });
      return finish(options, runId, false, 1, "provider_error", round);
    }

    if (!assistantText && calls.length === 0) {
      options.reporter.emit({ type: "error", message: "Provider returned an empty response" });
      return finish(options, runId, false, 1, "empty_response", round);
    }

    const assistantMessage: ChatMessage =
      calls.length > 0
        ? {
            role: "assistant",
            content: assistantText || null,
            toolCalls: calls,
            state: "complete",
          }
        : { role: "assistant", content: assistantText, state: "complete" };
    appendMessage(messages, options.journal, assistantMessage);
    options.reporter.emit({
      type: "assistant.completed",
      text: assistantText,
      interrupted: false,
    });

    if (calls.length === 0) {
      return finish(options, runId, true, 0, "completed", round);
    }

    for (let index = 0; index < calls.length; index++) {
      const call = calls[index]!;
      if (options.signal.aborted) {
        appendCancelledCalls(calls.slice(index), messages, options);
        return finish(options, runId, false, 130, "cancelled", round);
      }
      if (toolCalls >= options.config.maxToolCalls) {
        appendCancelledCalls(
          calls.slice(index),
          messages,
          options,
          "Tool-call budget reached before execution",
        );
        return finish(options, runId, false, 1, "max_tool_calls", round);
      }

      toolCalls++;
      options.reporter.emit({
        type: "tool.requested",
        callId: call.id,
        toolName: call.name,
      });
      let executionStarted = false;
      const toolResult = await options.tools.run(
        call,
        {
          workspace: options.workspace,
          approvalMode: options.approvalMode,
          approval: options.approval,
          shellTimeoutMs: options.config.shellTimeoutMs,
          signal: options.signal,
        },
        {
          approvalRequested: (summary) => {
            options.reporter.emit({
              type: "approval.requested",
              callId: call.id,
              toolName: call.name,
              summary,
            });
          },
          approvalResolved: (decision) => {
            options.journal.append({
              type: "approval.resolved",
              callId: call.id,
              toolName: call.name,
              decision,
            });
            options.reporter.emit({
              type: "approval.resolved",
              callId: call.id,
              toolName: call.name,
              decision,
            });
          },
          executionStarted: () => {
            executionStarted = true;
            options.journal.append({
              type: "tool.started",
              callId: call.id,
              toolName: call.name,
            });
            options.reporter.emit({
              type: "tool.started",
              callId: call.id,
              toolName: call.name,
            });
          },
        },
      );

      if (executionStarted) {
        options.journal.append({
          type: "tool.finished",
          callId: call.id,
          toolName: call.name,
          outcome: toolResult.outcome,
        });
      }
      appendToolMessage(messages, options.journal, call, toolResult);
      options.reporter.emit({
        type: "tool.completed",
        callId: call.id,
        toolName: call.name,
        outcome: toolResult.outcome,
        content: toolResult.content,
        truncated: toolResult.truncated,
        durationMs: toolResult.durationMs,
      });

      if (options.signal.aborted) {
        appendCancelledCalls(calls.slice(index + 1), messages, options);
        return finish(options, runId, false, 130, "cancelled", round);
      }
    }
  }

  options.reporter.emit({ type: "error", message: "Maximum provider rounds reached" });
  return finish(
    options,
    runId,
    false,
    1,
    "max_rounds",
    options.config.maxRounds,
  );
}

function appendMessage(
  messages: ChatMessage[],
  journal: SessionJournal,
  message: ChatMessage,
): void {
  journal.append({ type: "message.appended", message });
  messages.push(message);
}

function appendToolMessage(
  messages: ChatMessage[],
  journal: SessionJournal,
  call: ToolCall,
  result: ToolResult,
): void {
  appendMessage(messages, journal, {
    role: "tool",
    toolCallId: call.id,
    content: result.content,
    outcome: result.outcome,
  });
}

function appendCancelledCalls(
  calls: readonly ToolCall[],
  messages: ChatMessage[],
  options: RunAgentOptions,
  content = CANCELLED_TOOL_CONTENT,
): void {
  for (const call of calls) {
    const result: ToolResult = {
      outcome: "cancelled",
      content,
      durationMs: 0,
      truncated: false,
    };
    appendToolMessage(messages, options.journal, call, result);
    options.reporter.emit({
      type: "tool.completed",
      callId: call.id,
      toolName: call.name,
      outcome: "cancelled",
      content,
      truncated: false,
      durationMs: 0,
    });
  }
}

function finish(
  options: RunAgentOptions,
  runId: string,
  ok: boolean,
  exitCode: 0 | 1 | 130,
  reason: RunReason,
  rounds: number,
): RunResult {
  const result: RunResult = { ok, exitCode, reason, rounds };
  options.journal.append({ type: "run.finished", runId, result });
  options.reporter.emit({ type: "run.finished", result });
  return result;
}
