import {
  ProcessFailure,
  SpawnProcessRunner,
  assertProcessSucceeded,
  type ProcessRequest,
  type ProcessRunner,
} from "./process.js";
import { GitHubHttpError } from "./github.js";

export interface GitHubGraphqlRequest {
  query: string;
  variables?: Readonly<Record<string, unknown>>;
  signal?: AbortSignal;
}

export interface GitHubGraphqlTransport {
  request(request: GitHubGraphqlRequest): Promise<unknown>;
}

export interface GhGraphqlTransportOptions {
  runner?: ProcessRunner;
  ghExecutable?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface GitHubGraphqlErrorDetail {
  message: string;
  type?: string;
  path?: readonly (string | number)[];
}

export class GitHubGraphqlError extends Error {
  constructor(readonly errors: readonly GitHubGraphqlErrorDetail[]) {
    super(`GitHub GraphQL returned errors: ${errors.map((error) => error.message).join("; ")}`);
    this.name = "GitHubGraphqlError";
  }
}

/**
 * GraphQL transport backed by `gh` without a shell or inherited token variables.
 */
export class GhGraphqlTransport implements GitHubGraphqlTransport {
  private readonly runner: ProcessRunner;
  private readonly ghExecutable: string;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;

  constructor(options: GhGraphqlTransportOptions = {}) {
    this.runner = options.runner ?? new SpawnProcessRunner();
    this.ghExecutable = checkedExecutable(options.ghExecutable ?? "gh");
    this.timeoutMs = positiveInteger(options.timeoutMs ?? 60_000, "GitHub GraphQL timeout");
    this.maxOutputBytes = positiveInteger(
      options.maxOutputBytes ?? 4 * 1024 * 1024,
      "GitHub GraphQL output limit",
    );
  }

  async request(request: GitHubGraphqlRequest): Promise<unknown> {
    if (!request.query.trim() || request.query.includes("\0")) {
      throw new Error("GitHub GraphQL query must be non-empty and NUL-free");
    }
    const processRequest: ProcessRequest = {
      executable: this.ghExecutable,
      args: ["api", "graphql", "--method", "POST", "--input", "-"],
      env: ghEnvironment(),
      stdin: JSON.stringify({
        query: request.query,
        variables: request.variables ?? {},
      }),
      timeoutMs: this.timeoutMs,
      maxOutputBytes: this.maxOutputBytes,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    };
    const result = await this.runner.run(processRequest);
    try {
      assertProcessSucceeded("gh api graphql", result);
    } catch (error) {
      if (error instanceof ProcessFailure) {
        const status = githubStatus(error.result.stderr);
        if (status !== undefined) throw new GitHubHttpError(status, error.message);
      }
      throw error;
    }

    const output = result.stdout.trim();
    if (!output) throw new Error("gh api graphql returned an empty response");
    let parsed: unknown;
    try {
      parsed = JSON.parse(output) as unknown;
    } catch {
      throw new Error("gh api graphql returned invalid JSON");
    }
    const envelope = record(parsed, "GraphQL response");
    if (envelope.errors !== undefined) {
      if (!Array.isArray(envelope.errors)) {
        throw new Error("GitHub GraphQL errors field is not an array");
      }
      if (envelope.errors.length > 0) {
        throw new GitHubGraphqlError(envelope.errors.map(parseGraphqlError));
      }
    }
    if (!Object.hasOwn(envelope, "data") || envelope.data === null) {
      throw new Error("GitHub GraphQL response is missing data");
    }
    return envelope.data;
  }
}

function parseGraphqlError(value: unknown): GitHubGraphqlErrorDetail {
  const error = record(value, "GraphQL error");
  const message = string(error.message, "GraphQL error message").slice(0, 2_000);
  const type = error.type === undefined ? undefined : string(error.type, "GraphQL error type");
  let path: readonly (string | number)[] | undefined;
  if (error.path !== undefined) {
    if (
      !Array.isArray(error.path) ||
      error.path.some(
        (part) =>
          (typeof part !== "string" && typeof part !== "number") ||
          (typeof part === "number" && !Number.isSafeInteger(part)),
      )
    ) {
      throw new Error("GitHub GraphQL error path is invalid");
    }
    path = error.path as readonly (string | number)[];
  }
  return {
    message,
    ...(type === undefined ? {} : { type }),
    ...(path === undefined ? {} : { path }),
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`GitHub ${label} is not an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`GitHub ${label} is not a string`);
  return value;
}

function checkedExecutable(value: string): string {
  if (!value || value.includes("\0")) throw new Error("gh executable is invalid");
  return value;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be positive`);
  return value;
}

function ghEnvironment(): Readonly<Record<string, string>> {
  const environment: Record<string, string> = { NO_COLOR: "1" };
  for (const name of ["HOME", "PATH", "XDG_CONFIG_HOME", "GH_CONFIG_DIR", "GH_HOST"] as const) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

function githubStatus(stderr: string): number | undefined {
  const matches = [
    ...stderr.matchAll(/\bHTTP\s+([1-5][0-9]{2})\b/giu),
    ...stderr.matchAll(/\bstatus(?:\s+code)?[:=\s]+([1-5][0-9]{2})\b/giu),
  ];
  const value = matches.at(-1)?.[1];
  return value === undefined ? undefined : Number(value);
}
