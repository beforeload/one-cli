import { describe, expect, it } from "vitest";
import {
  GhGraphqlTransport,
  GitHubGraphqlError,
} from "../../src/autonomy/github-graphql.js";
import type {
  ProcessRequest,
  ProcessResult,
  ProcessRunner,
} from "../../src/autonomy/process.js";

class FakeRunner implements ProcessRunner {
  readonly requests: ProcessRequest[] = [];

  constructor(private readonly result: ProcessResult) {}

  async run(request: ProcessRequest): Promise<ProcessResult> {
    this.requests.push(request);
    return this.result;
  }
}

describe("GhGraphqlTransport", () => {
  it("uses structured argv, isolated environment, bounds, and AbortSignal", async () => {
    process.env.GH_TOKEN = "must-not-leak";
    process.env.GITHUB_TOKEN = "also-must-not-leak";
    const runner = new FakeRunner(result({ stdout: '{"data":{"viewer":{"login":"octo"}}}' }));
    const transport = new GhGraphqlTransport({ runner });
    const controller = new AbortController();

    await expect(
      transport.request({
        query: "query($text:String!){viewer{login}}",
        variables: { text: '$(touch /tmp/nope); "quoted"' },
        signal: controller.signal,
      }),
    ).resolves.toEqual({ viewer: { login: "octo" } });

    expect(runner.requests).toHaveLength(1);
    expect(runner.requests[0]).toMatchObject({
      executable: "gh",
      args: ["api", "graphql", "--method", "POST", "--input", "-"],
      timeoutMs: 60_000,
      maxOutputBytes: 4 * 1024 * 1024,
      signal: controller.signal,
    });
    expect(runner.requests[0]?.env).toEqual(
      expect.not.objectContaining({ GH_TOKEN: expect.anything(), GITHUB_TOKEN: expect.anything() }),
    );
    expect(JSON.parse(String(runner.requests[0]?.stdin))).toEqual({
      query: "query($text:String!){viewer{login}}",
      variables: { text: '$(touch /tmp/nope); "quoted"' },
    });
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
  });

  it("rejects malformed envelopes and surfaces GraphQL errors", async () => {
    const malformed = new GhGraphqlTransport({
      runner: new FakeRunner(result({ stdout: "not-json" })),
    });
    await expect(malformed.request({ query: "{viewer{login}}" })).rejects.toThrow("invalid JSON");

    const errors = new GhGraphqlTransport({
      runner: new FakeRunner(
        result({
          stdout: JSON.stringify({
            data: { repository: null },
            errors: [{ message: "API rate limit exceeded", type: "RATE_LIMITED" }],
          }),
        }),
      ),
    });
    await expect(errors.request({ query: "{viewer{login}}" })).rejects.toBeInstanceOf(
      GitHubGraphqlError,
    );
  });
});

function result(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    durationMs: 1,
    timedOut: false,
    cancelled: false,
    outputLimitExceeded: false,
    ...overrides,
  };
}
