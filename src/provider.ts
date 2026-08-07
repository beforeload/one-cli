import OpenAI from "openai";
import type {
  ChatMessage,
  ChatProvider,
  ProviderEvent,
  ToolCall,
  ToolSpec,
} from "./domain.js";

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 200;
const MAX_DELAY_MS = 2_000;

export interface OpenAICompatibleOptions {
  apiKey: string;
  baseUrl: string;
}

export class OpenAICompatibleProvider implements ChatProvider {
  private readonly client: OpenAI;

  constructor(options: OpenAICompatibleOptions) {
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseUrl,
      maxRetries: 0,
    });
  }

  async *stream(
    request: {
      model: string;
      messages: readonly ChatMessage[];
      tools: readonly ToolSpec[];
    },
    signal: AbortSignal,
  ): AsyncIterable<ProviderEvent> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let producedOutput = false;
      try {
        for await (const event of this.streamOnce(request, signal)) {
          producedOutput = true;
          yield event;
        }
        return;
      } catch (error) {
        const transient = classifyTransient(error);
        if (!transient || producedOutput || attempt >= MAX_ATTEMPTS || signal.aborted) {
          throw error;
        }
        const delayMs = backoff(attempt);
        yield {
          type: "retry",
          attempt: attempt + 1,
          maxAttempts: MAX_ATTEMPTS,
          reason: transient,
          delayMs,
        };
        await abortableSleep(delayMs, signal);
      }
    }
  }

  private async *streamOnce(
    request: {
      model: string;
      messages: readonly ChatMessage[];
      tools: readonly ToolSpec[];
    },
    signal: AbortSignal,
  ): AsyncIterable<ProviderEvent> {
    const params: OpenAI.ChatCompletionCreateParamsStreaming = {
      model: request.model,
      messages: request.messages.map(toOpenAIMessage),
      tools: request.tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      })),
      stream: true,
      stream_options: { include_usage: true },
    };

    const stream = await this.client.chat.completions.create(params, { signal });
    const calls = new Map<number, ToolCall>();
    let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;

    for await (const chunk of stream) {
      if (chunk.usage) usage = chunk.usage;
      const delta = chunk.choices[0]?.delta;
      if (delta?.content) yield { type: "text_delta", delta: delta.content };
      for (const fragment of delta?.tool_calls ?? []) {
        const index = fragment.index;
        const existing = calls.get(index) ?? {
          id: "",
          name: "",
          argumentsJson: "",
        };
        if (fragment.id) existing.id = fragment.id;
        if (fragment.function?.name) existing.name = fragment.function.name;
        if (fragment.function?.arguments) {
          existing.argumentsJson += fragment.function.arguments;
        }
        calls.set(index, existing);
      }
    }

    for (const call of [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call)) {
      if (call.id && call.name) yield { type: "tool_call", call };
    }
    if (usage) {
      yield {
        type: "usage",
        promptTokens: usage.prompt_tokens ?? 0,
        completionTokens: usage.completion_tokens ?? 0,
      };
    }
  }
}

function toOpenAIMessage(message: ChatMessage): OpenAI.ChatCompletionMessageParam {
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId,
      content: message.content,
    };
  }
  if (message.role === "assistant") {
    return {
      role: "assistant",
      content: message.content,
      ...(message.toolCalls?.length
        ? {
            tool_calls: message.toolCalls.map((call) => ({
              id: call.id,
              type: "function" as const,
              function: { name: call.name, arguments: call.argumentsJson },
            })),
          }
        : {}),
    };
  }
  return { role: message.role, content: message.content };
}

function classifyTransient(
  error: unknown,
): "rate_limit" | "server" | "network" | null {
  const value = error as {
    status?: number;
    code?: string;
    cause?: { code?: string };
  };
  if (value.status === 429) return "rate_limit";
  if (
    value.status === 500 ||
    value.status === 502 ||
    value.status === 503 ||
    value.status === 504
  ) {
    return "server";
  }
  const code = value.code ?? value.cause?.code;
  return code && ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"].includes(code)
    ? "network"
    : null;
}

function backoff(attempt: number): number {
  return Math.min(BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1), MAX_DELAY_MS);
}

async function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
