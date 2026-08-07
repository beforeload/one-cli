import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import type { ApprovalMode } from "./domain.js";
import { errorMessage } from "./domain.js";
import { agentHome, resolveRunConfig } from "./config.js";
import { Workspace } from "./workspace.js";
import { SessionJournal } from "./session.js";
import { ToolRunner } from "./tools.js";
import { OpenAICompatibleProvider } from "./provider.js";
import { DenyApprovalPort, TtyApprovalPort } from "./approval.js";
import { JsonlReporter, TextReporter } from "./reporter.js";
import { runAgent } from "./agent.js";

const VERSION = "0.1.0";

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  try {
    const parsed = parseCli(argv);
    if (parsed.command === "help") {
      process.stdout.write(`${helpText()}\n`);
      return 0;
    }
    if (parsed.command === "version") {
      process.stdout.write(`${VERSION}\n`);
      return 0;
    }

    if (parsed.command === "sessions") {
      const workspace = parsed.workspace ? new Workspace(parsed.workspace).root : undefined;
      const sessions = SessionJournal.list(agentHome(), workspace);
      for (const session of sessions) {
        process.stdout.write(
          `${session.sessionId}\t${session.createdAt}\t${session.model}\t${session.workspace}\n`,
        );
      }
      return 0;
    }

    const prompt = readPrompt(parsed.prompt, parsed.stdin);
    const workspace = new Workspace(parsed.workspace ?? process.cwd());
    const config = resolveRunConfig({
      ...(parsed.model ? { model: parsed.model } : {}),
      ...(parsed.baseUrl ? { baseUrl: parsed.baseUrl } : {}),
      ...(parsed.maxRounds !== undefined ? { maxRounds: parsed.maxRounds } : {}),
      ...(parsed.maxToolCalls !== undefined ? { maxToolCalls: parsed.maxToolCalls } : {}),
      ...(parsed.shellTimeoutMs !== undefined
        ? { shellTimeoutMs: parsed.shellTimeoutMs }
        : {}),
    });
    const journal = parsed.resume
      ? SessionJournal.resume(config.home, parsed.resume, workspace.root)
      : SessionJournal.create(config.home, workspace.root, config.model);
    const runId = randomUUID();
    const reporter =
      parsed.output === "jsonl"
        ? new JsonlReporter(runId, journal.sessionId)
        : new TextReporter();
    const approval =
      process.stdin.isTTY && process.stderr.isTTY
        ? new TtyApprovalPort()
        : new DenyApprovalPort();
    const controller = new AbortController();
    let interrupts = 0;
    const onSigint = () => {
      interrupts++;
      if (interrupts === 1) {
        controller.abort(new DOMException("Cancelled by SIGINT", "AbortError"));
      } else {
        process.exit(130);
      }
    };
    process.on("SIGINT", onSigint);

    try {
      const result = await runAgent({
        prompt,
        config,
        workspace,
        provider: new OpenAICompatibleProvider({
          apiKey: config.apiKey,
          baseUrl: config.baseUrl,
        }),
        tools: new ToolRunner(),
        journal,
        reporter,
        approvalMode: parsed.approval,
        approval,
        signal: controller.signal,
        runId,
      });
      return result.exitCode;
    } finally {
      process.off("SIGINT", onSigint);
      journal.release();
    }
  } catch (error) {
    process.stderr.write(`Error: ${errorMessage(error)}\n`);
    return 2;
  }
}

type ParsedCli =
  | { command: "help" }
  | { command: "version" }
  | { command: "sessions"; workspace?: string }
  | {
      command: "run";
      prompt?: string;
      stdin: boolean;
      resume?: string;
      workspace?: string;
      output: "text" | "jsonl";
      approval: ApprovalMode;
      model?: string;
      baseUrl?: string;
      maxRounds?: number;
      maxToolCalls?: number;
      shellTimeoutMs?: number;
    };

function parseCli(argv: readonly string[]): ParsedCli {
  const { values, positionals } = parseArgs({
    args: [...argv],
    strict: true,
    allowPositionals: true,
    options: {
      prompt: { type: "string", short: "p" },
      stdin: { type: "boolean", default: false },
      resume: { type: "string" },
      workspace: { type: "string" },
      output: { type: "string", default: "text" },
      approval: { type: "string", default: "ask" },
      model: { type: "string" },
      "base-url": { type: "string" },
      "max-rounds": { type: "string" },
      "max-tool-calls": { type: "string" },
      "shell-timeout-ms": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
  });

  if (values.help) return { command: "help" };
  if (values.version) return { command: "version" };
  const command = positionals[0] ?? "run";
  if (positionals.length > (command === "run" || command === "sessions" ? 1 : 0)) {
    throw new Error("Unexpected positional arguments");
  }
  if (command === "sessions") {
    return {
      command: "sessions",
      ...(values.workspace ? { workspace: values.workspace } : {}),
    };
  }
  if (command !== "run") throw new Error(`Unknown command: ${command}`);
  if (values.output !== "text" && values.output !== "jsonl") {
    throw new Error("--output must be text or jsonl");
  }
  if (!["deny", "ask", "auto-edit", "all"].includes(values.approval)) {
    throw new Error("--approval must be deny, ask, auto-edit, or all");
  }

  return {
    command: "run",
    stdin: values.stdin,
    output: values.output,
    approval: values.approval as ApprovalMode,
    ...(values.prompt ? { prompt: values.prompt } : {}),
    ...(values.resume ? { resume: values.resume } : {}),
    ...(values.workspace ? { workspace: values.workspace } : {}),
    ...(values.model ? { model: values.model } : {}),
    ...(values["base-url"] ? { baseUrl: values["base-url"] } : {}),
    ...(values["max-rounds"]
      ? { maxRounds: positiveInteger(values["max-rounds"], "--max-rounds") }
      : {}),
    ...(values["max-tool-calls"]
      ? {
          maxToolCalls: positiveInteger(values["max-tool-calls"], "--max-tool-calls"),
        }
      : {}),
    ...(values["shell-timeout-ms"]
      ? {
          shellTimeoutMs: positiveInteger(
            values["shell-timeout-ms"],
            "--shell-timeout-ms",
          ),
        }
      : {}),
  };
}

function readPrompt(prompt: string | undefined, stdin: boolean): string {
  if (prompt && stdin) throw new Error("Use either --prompt or --stdin, not both");
  const value = stdin ? fs.readFileSync(0, "utf8") : prompt;
  if (!value?.trim()) throw new Error("A non-empty --prompt or --stdin value is required");
  return value;
}

function positiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function helpText(): string {
  return `one-cli ${VERSION}

Usage:
  one-cli run -p <prompt> [options]
  one-cli run --stdin [options]
  one-cli sessions [--workspace <dir>]

Options:
  -p, --prompt <text>          User prompt
      --stdin                  Read the prompt from stdin
      --resume <uuid>          Resume a workspace-bound session
      --workspace <dir>        Workspace root (default: cwd)
      --output <text|jsonl>    Output format (default: text)
      --approval <mode>        deny|ask|auto-edit|all (default: ask)
      --model <name>           Override OPENAI_MODEL
      --base-url <url>         Override OPENAI_BASE_URL
      --max-rounds <n>         Provider round limit
      --max-tool-calls <n>     Tool-call limit
      --shell-timeout-ms <n>   Shell timeout ceiling
  -h, --help                   Show help
  -v, --version                Show version`;
}
