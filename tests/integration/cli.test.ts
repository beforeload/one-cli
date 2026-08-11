import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDir, removeTempDir } from "../helpers.js";

type FakeTurn =
  | { type: "text"; content: string }
  | { type: "error"; status: number; code: string }
  | { type: "partial_error"; content: string }
  | {
      type: "tool";
      id: string;
      name: string;
      arguments: Record<string, unknown>;
    };

describe("built CLI", () => {
  let root: string;
  let workspace: string;
  let home: string;

  // The sandboxed unit/install gates run under the DarwinSandbox with a
  // strictly deny-default profile that no longer grants loopback network
  // access (an independent verifier vetoed loopback allows in network=false
  // profiles). Every case below drives the CLI against an in-process fake
  // provider bound to 127.0.0.1, which a sandboxed process cannot reach, so
  // these cases are skipped when ONE_CLI_SANDBOXED=1 rather than opening a
  // loopback grant. They still run unsandboxed in normal CI.
  const runOrSkip = process.env.ONE_CLI_SANDBOXED === "1" ? it.skip : it;

  beforeEach(() => {
    root = makeTempDir("cli");
    workspace = path.join(root, "workspace");
    home = path.join(root, "home");
    fs.mkdirSync(workspace);
  });

  afterEach(() => removeTempDir(root));

  runOrSkip("emits a pure JSONL lifecycle for a final answer", async () => {
    const fake = await startFakeProvider([{ type: "text", content: "hello" }]);
    try {
      const run = await runCli(["run", "-p", "say hello", "--output", "jsonl"], {
        workspace,
        home,
        baseUrl: fake.baseUrl,
      });
      expect(run.code, `${run.stderr}\n${run.stdout}`).toBe(0);
      expect(run.stderr).toBe("");
      const events = parseJsonl(run.stdout);
      expect(events[0]).toMatchObject({
        protocol: "one-cli.events",
        type: "run.started",
      });
      expect(events.at(-1)).toMatchObject({
        type: "run.finished",
        result: { ok: true, exitCode: 0, reason: "completed" },
      });
      expect(events.map((event) => event.seq)).toEqual(
        events.map((_, index) => index + 1),
      );
    } finally {
      await fake.close();
    }
  });

  runOrSkip("retries a transient provider failure before any output", async () => {
    const fake = await startFakeProvider([
      { type: "error", status: 503, code: "service_unavailable" },
      { type: "text", content: "recovered" },
    ]);
    try {
      const run = await runCli(["run", "-p", "recover", "--output", "jsonl"], {
        workspace,
        home,
        baseUrl: fake.baseUrl,
      });
      expect(run.code, `${run.stderr}\n${run.stdout}`).toBe(0);
      expect(fake.requests).toHaveLength(2);
      expect(parseJsonl(run.stdout)).toContainEqual(
        expect.objectContaining({
          type: "provider.retry",
          reason: "server",
          attempt: 2,
        }),
      );
    } finally {
      await fake.close();
    }
  });

  runOrSkip("preserves partial text and does not retry after output", async () => {
    const fake = await startFakeProvider([
      { type: "partial_error", content: "partial answer" },
      { type: "text", content: "must not be requested" },
    ]);
    try {
      const run = await runCli(["run", "-p", "stream", "--output", "jsonl"], {
        workspace,
        home,
        baseUrl: fake.baseUrl,
      });
      expect(run.code).toBe(1);
      expect(fake.requests).toHaveLength(1);
      const events = parseJsonl(run.stdout);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "assistant.completed",
          text: "partial answer",
          interrupted: true,
        }),
      );
      expect(events.at(-1)).toMatchObject({
        type: "run.finished",
        result: { reason: "provider_error", exitCode: 1 },
      });
    } finally {
      await fake.close();
    }
  });

  runOrSkip("executes a read tool and returns the result to the provider", async () => {
    fs.writeFileSync(path.join(workspace, "README.md"), "integration evidence");
    const fake = await startFakeProvider([
      {
        type: "tool",
        id: "read-1",
        name: "read",
        arguments: { path: "README.md" },
      },
      { type: "text", content: "read complete" },
    ]);
    try {
      const run = await runCli(["run", "-p", "read README", "--output", "jsonl"], {
        workspace,
        home,
        baseUrl: fake.baseUrl,
      });
      expect(run.code).toBe(0);
      expect(fake.requests).toHaveLength(2);
      expect(JSON.stringify(fake.requests[1])).toContain("integration evidence");
      expect(parseJsonl(run.stdout)).toContainEqual(
        expect.objectContaining({
          type: "tool.completed",
          toolName: "read",
          outcome: "succeeded",
        }),
      );
    } finally {
      await fake.close();
    }
  });

  runOrSkip("denies non-TTY writes by default and permits explicit all mode", async () => {
    const deniedProvider = await startFakeProvider([
      {
        type: "tool",
        id: "write-denied",
        name: "write",
        arguments: { path: "result.txt", content: "denied" },
      },
      { type: "text", content: "write denied" },
    ]);
    try {
      const denied = await runCli(["run", "-p", "write file", "--output", "jsonl"], {
        workspace,
        home,
        baseUrl: deniedProvider.baseUrl,
      });
      expect(denied.code).toBe(0);
      expect(fs.existsSync(path.join(workspace, "result.txt"))).toBe(false);
      expect(parseJsonl(denied.stdout)).toContainEqual(
        expect.objectContaining({ type: "tool.completed", outcome: "denied" }),
      );
    } finally {
      await deniedProvider.close();
    }

    const allowedProvider = await startFakeProvider([
      {
        type: "tool",
        id: "write-allowed",
        name: "write",
        arguments: { path: "result.txt", content: "allowed" },
      },
      { type: "text", content: "write complete" },
    ]);
    try {
      const allowed = await runCli(
        ["run", "-p", "write file", "--approval", "all", "--output", "jsonl"],
        {
          workspace,
          home,
          baseUrl: allowedProvider.baseUrl,
        },
      );
      expect(allowed.code).toBe(0);
      expect(fs.readFileSync(path.join(workspace, "result.txt"), "utf8")).toBe(
        "allowed",
      );
    } finally {
      await allowedProvider.close();
    }
  });

  runOrSkip("resumes prior messages only in the same workspace", async () => {
    const fake = await startFakeProvider([
      { type: "text", content: "first answer" },
      { type: "text", content: "second answer" },
    ]);
    try {
      const first = await runCli(["run", "-p", "first", "--output", "jsonl"], {
        workspace,
        home,
        baseUrl: fake.baseUrl,
      });
      const sessionId = parseJsonl(first.stdout)[0]!.sessionId as string;
      const second = await runCli(
        ["run", "-p", "second", "--resume", sessionId, "--output", "jsonl"],
        { workspace, home, baseUrl: fake.baseUrl },
      );
      expect(second.code).toBe(0);
      expect(JSON.stringify(fake.requests[1])).toContain("first answer");

      const other = path.join(root, "other");
      fs.mkdirSync(other);
      const foreign = await runCli(
        ["run", "-p", "foreign", "--resume", sessionId, "--output", "jsonl"],
        { workspace: other, home, baseUrl: fake.baseUrl },
      );
      expect(foreign.code).toBe(2);
      expect(foreign.stderr).toContain("different workspace");
      expect(fake.requests).toHaveLength(2);
    } finally {
      await fake.close();
    }
  });
});

async function runCli(
  args: string[],
  options: { workspace: string; home: string; baseUrl: string },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(process.cwd(), "dist/index.js"), ...args], {
      cwd: options.workspace,
      env: {
        ...process.env,
        OPENAI_API_KEY: "test-key",
        OPENAI_MODEL: "test-model",
        OPENAI_BASE_URL: options.baseUrl,
        ONE_CLI_HOME: options.home,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function parseJsonl(output: string): Array<Record<string, unknown>> {
  return output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function startFakeProvider(turns: FakeTurn[]) {
  const requests: unknown[] = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push(JSON.parse(body));
      const turn = turns.shift();
      if (!turn) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end('{"error":{"message":"no fake turn"}}');
        return;
      }
      if (turn.type === "error") {
        response.writeHead(turn.status, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: {
              message: "fake transient error",
              type: "server_error",
              code: turn.code,
            },
          }),
        );
        return;
      }
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      if (turn.type === "partial_error") {
        sendChunk(response, {
          choices: [
            {
              index: 0,
              delta: { content: turn.content },
              finish_reason: null,
            },
          ],
        });
        setTimeout(
          () => response.socket?.destroy(new Error("fake connection reset")),
          20,
        );
        return;
      }
      if (turn.type === "text") {
        sendChunk(response, {
          choices: [
            {
              index: 0,
              delta: { content: turn.content },
              finish_reason: null,
            },
          ],
        });
        sendChunk(response, {
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        });
      } else {
        sendChunk(response, {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: turn.id,
                    type: "function",
                    function: {
                      name: turn.name,
                      arguments: JSON.stringify(turn.arguments),
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        });
        sendChunk(response, {
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        });
      }
      sendChunk(response, {
        choices: [],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
      response.end("data: [DONE]\n\n");
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fake server failed to bind");
  return {
    requests,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: async () =>
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

function sendChunk(
  response: http.ServerResponse,
  chunk: Record<string, unknown>,
): void {
  response.write(`data: ${JSON.stringify({
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 0,
    model: "test-model",
    ...chunk,
  })}\n\n`);
}
