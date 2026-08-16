import os from "node:os";
import path from "node:path";
import { z } from "zod";

export const DEFAULT_MAX_ROUNDS = 20;
export const DEFAULT_MAX_TOOL_CALLS = 100;
export const DEFAULT_SHELL_TIMEOUT_MS = 30_000;
export const MAX_SHELL_TIMEOUT_MS = 120_000;
export const MAX_TOOL_ARGUMENT_BYTES = 64 * 1024;
export const MAX_TOOL_RESULT_BYTES = 256 * 1024;
export const MAX_WRITE_BYTES = 1024 * 1024;
export const MAX_SHELL_OUTPUT_BYTES = 1024 * 1024;
export const MAX_SESSION_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_CONTEXT_MESSAGES = 64;
export const DEFAULT_MAX_CONTEXT_BYTES = 256 * 1024;
export const DEFAULT_CONTEXT_RECENT_TURNS = 4;

const RunConfigSchema = z.object({
  apiKey: z.string().min(1, "OPENAI_API_KEY is required"),
  baseUrl: z.string().url(),
  model: z.string().min(1, "OPENAI_MODEL or --model is required"),
  home: z.string().min(1),
  maxRounds: z.number().int().min(1).max(100),
  maxToolCalls: z.number().int().min(1).max(10_000),
  shellTimeoutMs: z.number().int().min(1).max(MAX_SHELL_TIMEOUT_MS),
});

export type RunConfig = z.infer<typeof RunConfigSchema>;

export interface ConfigOverrides {
  env?: NodeJS.ProcessEnv;
  model?: string;
  baseUrl?: string;
  maxRounds?: number;
  maxToolCalls?: number;
  shellTimeoutMs?: number;
}

export function agentHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.ONE_CLI_HOME ?? path.join(os.homedir(), ".one-cli");
}

export function resolveRunConfig(overrides: ConfigOverrides = {}): RunConfig {
  const env = overrides.env ?? process.env;
  return RunConfigSchema.parse({
    apiKey: env.OPENAI_API_KEY,
    baseUrl: overrides.baseUrl ?? env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    model: overrides.model ?? env.OPENAI_MODEL,
    home: agentHome(env),
    maxRounds: overrides.maxRounds ?? DEFAULT_MAX_ROUNDS,
    maxToolCalls: overrides.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS,
    shellTimeoutMs: overrides.shellTimeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS,
  });
}

export function redactedEndpoint(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return "<invalid-endpoint>";
  }
}
