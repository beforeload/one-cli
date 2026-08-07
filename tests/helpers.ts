import fs from "node:fs";
import path from "node:path";
import type {
  ChatProvider,
  ProviderEvent,
  PublicEvent,
  Reporter,
} from "../src/domain.js";

export function makeTempDir(prefix: string): string {
  const base = path.join(process.cwd(), ".tmp-tests");
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, `${prefix}-`));
}

export function removeTempDir(directory: string): void {
  fs.rmSync(directory, { recursive: true, force: true });
}

export class ScriptedProvider implements ChatProvider {
  readonly requests: Array<{
    model: string;
    messages: readonly unknown[];
    tools: readonly unknown[];
  }> = [];

  constructor(
    private readonly turns: Array<
      readonly ProviderEvent[] | ((signal: AbortSignal) => AsyncIterable<ProviderEvent>)
    >,
  ) {}

  async *stream(request: Parameters<ChatProvider["stream"]>[0], signal: AbortSignal) {
    this.requests.push(request);
    const turn = this.turns.shift();
    if (!turn) throw new Error("No scripted provider turn remains");
    if (typeof turn === "function") {
      yield* turn(signal);
      return;
    }
    for (const event of turn) {
      if (signal.aborted) throw signal.reason;
      yield event;
    }
  }
}

export class CaptureReporter implements Reporter {
  readonly events: PublicEvent[] = [];

  emit(event: PublicEvent): void {
    this.events.push(event);
  }
}
