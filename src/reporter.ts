import type { PublicEvent, Reporter } from "./domain.js";

export const EVENT_PROTOCOL = "one-cli.events";
export const EVENT_VERSION = 1;

export class JsonlReporter implements Reporter {
  private sequence = 0;

  constructor(
    private readonly runId: string,
    private readonly sessionId: string,
    private readonly output: NodeJS.WritableStream = process.stdout,
  ) {}

  emit(event: PublicEvent): void {
    this.output.write(
      `${JSON.stringify({
        protocol: EVENT_PROTOCOL,
        version: EVENT_VERSION,
        seq: ++this.sequence,
        ts: new Date().toISOString(),
        runId: this.runId,
        sessionId: this.sessionId,
        ...event,
      })}\n`,
    );
  }
}

export class TextReporter implements Reporter {
  private assistantLineOpen = false;

  constructor(
    private readonly output: NodeJS.WritableStream = process.stdout,
    private readonly diagnostics: NodeJS.WritableStream = process.stderr,
  ) {}

  emit(event: PublicEvent): void {
    switch (event.type) {
      case "assistant.delta":
        this.output.write(event.delta);
        this.assistantLineOpen = true;
        break;
      case "assistant.completed":
        if (this.assistantLineOpen) this.output.write("\n");
        if (event.interrupted) this.diagnostics.write("[assistant response interrupted]\n");
        this.assistantLineOpen = false;
        break;
      case "tool.requested":
        this.ensureAssistantLine();
        this.diagnostics.write(`[tool] ${event.toolName}\n`);
        break;
      case "approval.requested":
        this.diagnostics.write(`[approval] ${event.toolName} requires confirmation\n`);
        break;
      case "tool.completed":
        this.diagnostics.write(
          `[tool] ${event.toolName}: ${event.outcome}${event.truncated ? " (truncated)" : ""}\n`,
        );
        break;
      case "provider.retry":
        this.diagnostics.write(
          `[provider] retry ${event.attempt}/${event.maxAttempts} (${event.reason}, ${event.delayMs}ms)\n`,
        );
        break;
      case "error":
        this.ensureAssistantLine();
        this.diagnostics.write(`Error: ${event.message}\n`);
        break;
      case "run.finished":
        this.ensureAssistantLine();
        if (!event.result.ok) {
          this.diagnostics.write(`[run] ${event.result.reason}\n`);
        }
        break;
      default:
        break;
    }
  }

  private ensureAssistantLine(): void {
    if (!this.assistantLineOpen) return;
    this.output.write("\n");
    this.assistantLineOpen = false;
  }
}
