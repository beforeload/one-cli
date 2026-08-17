export interface ToolCall {
  id: string;
  name: string;
  argumentsJson: string;
}

export type ToolOutcome = "succeeded" | "failed" | "denied" | "cancelled";

export interface ContextCompactionOptions {
  maxMessages: number;
  maxBytes: number;
  recentTurns: number;
}

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      toolCalls?: ToolCall[];
      state?: "complete" | "interrupted";
    }
  | {
      role: "tool";
      toolCallId: string;
      content: string;
      outcome: ToolOutcome;
    };

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type ProviderEvent =
  | { type: "text_delta"; delta: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "usage"; promptTokens: number; completionTokens: number }
  | {
      type: "retry";
      attempt: number;
      maxAttempts: number;
      reason: "rate_limit" | "server" | "network";
      delayMs: number;
    };

export interface ChatProvider {
  stream(
    request: {
      model: string;
      messages: readonly ChatMessage[];
      tools: readonly ToolSpec[];
    },
    signal: AbortSignal,
  ): AsyncIterable<ProviderEvent>;
}

export type ToolRisk = "read" | "workspace_write" | "host_shell";
export type ApprovalMode = "deny" | "ask" | "auto-edit" | "all";
export type ApprovalDecision = "approved" | "denied" | "cancelled";

export interface ApprovalRequest {
  toolName: string;
  risk: ToolRisk;
  summary: string;
}

export interface ApprovalPort {
  request(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision>;
}

export interface ToolResult {
  outcome: ToolOutcome;
  content: string;
  durationMs: number;
  truncated: boolean;
}

export type RunReason =
  | "completed"
  | "provider_error"
  | "max_rounds"
  | "max_tool_calls"
  | "cancelled"
  | "empty_response";

export interface RunResult {
  ok: boolean;
  exitCode: 0 | 1 | 130;
  reason: RunReason;
  rounds: number;
}

export type PublicEvent =
  | { type: "run.started"; model: string }
  | { type: "assistant.delta"; delta: string }
  | { type: "assistant.completed"; text: string; interrupted: boolean }
  | { type: "tool.requested"; callId: string; toolName: string }
  | { type: "approval.requested"; callId: string; toolName: string; summary: string }
  | { type: "approval.resolved"; callId: string; toolName: string; decision: ApprovalDecision }
  | { type: "tool.started"; callId: string; toolName: string }
  | {
      type: "tool.completed";
      callId: string;
      toolName: string;
      outcome: ToolOutcome;
      content: string;
      truncated: boolean;
      durationMs: number;
    }
  | {
      type: "provider.retry";
      attempt: number;
      maxAttempts: number;
      reason: "rate_limit" | "server" | "network";
      delayMs: number;
    }
  | { type: "usage"; promptTokens: number; completionTokens: number }
  | { type: "error"; message: string }
  | { type: "run.finished"; result: RunResult };

export interface Reporter {
  emit(event: PublicEvent): void;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === "AbortError") ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "ABORT_ERR")
  );
}
