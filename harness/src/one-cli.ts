import path from "node:path";
import type { ProcessRunner, ProcessResult } from "./runner.js";
import { requireSuccess } from "./runner.js";
import type { HarnessRelease } from "./release.js";

export interface AttemptStatus {
  id: string;
  issueId: string;
  state: string;
  prNumber: number | null;
  detail: Record<string, unknown> | null;
}

export interface AutonomyStatus {
  schema: "autonomy.one-cli/status-v1";
  executionScope: "normal" | "roadmap-only";
  mode: string;
  activeAttempt: AttemptStatus | null;
  attempts: AttemptStatus[];
  action: { type: string; aggregateId: string; createdAt: number } | null;
}

export interface TickOutput {
  action: string;
  state: string;
  attemptId?: string;
  detail?: string;
}

export interface ExpectedRoadmapBinding {
  issueNumber: number;
  seedMarker: string;
}

export class OneCliClient {
  constructor(
    private readonly runner: ProcessRunner,
    readonly workspace: string,
    private readonly releaseResolver: string | (() => HarnessRelease),
    private readonly environment: Readonly<Record<string, string>>,
    private readonly nodeExecutable = process.execPath,
  ) {}

  get entrypoint(): string {
    return this.resolveRelease().entrypoint;
  }

  activeRelease(): HarnessRelease {
    return this.resolveRelease();
  }

  async doctor(signal?: AbortSignal): Promise<{
    ok: boolean;
    checks: readonly { name: string; ok: boolean; detail: string }[];
    process: ProcessResult;
  }> {
    const processResult = await this.invoke(
      ["doctor", "--output", "json"],
      signal,
      false,
    );
    const value = record(parseJson(processResult.stdout, "doctor"), "doctor");
    if (typeof value.ok !== "boolean" || !Array.isArray(value.checks)) {
      throw new Error("one-cli doctor returned an invalid contract");
    }
    const checks = value.checks.map((entry) => {
      const check = record(entry, "doctor check");
      if (
        typeof check.name !== "string" ||
        typeof check.ok !== "boolean" ||
        typeof check.detail !== "string"
      ) {
        throw new Error("one-cli doctor check is invalid");
      }
      return { name: check.name, ok: check.ok, detail: check.detail };
    });
    return { ok: value.ok, checks, process: processResult };
  }

  async status(
    scope: "normal" | "roadmap-only",
    expected?: ExpectedRoadmapBinding,
    signal?: AbortSignal,
  ): Promise<AutonomyStatus> {
    const result = await this.invoke(
      ["status", "--mode", "auto-merge", "--output", "json", ...scopeArgs(scope, expected)],
      signal,
    );
    return parseAutonomyStatus(parseJson(result.stdout, "status"));
  }

  async reconcile(
    scope: "normal" | "roadmap-only",
    expected: ExpectedRoadmapBinding,
    signal?: AbortSignal,
  ): Promise<TickOutput> {
    const result = await this.invoke(
      [
        "reconcile",
        "--apply",
        "--mode",
        "auto-merge",
        "--output",
        "json",
        ...scopeArgs(scope, expected),
      ],
      signal,
    );
    return parseTick(parseJson(result.stdout, "reconcile"));
  }

  async once(
    scope: "normal" | "roadmap-only",
    expected?: ExpectedRoadmapBinding,
    signal?: AbortSignal,
  ): Promise<TickOutput> {
    const result = await this.invoke(
      [
        "once",
        "--mode",
        "auto-merge",
        "--output",
        "json",
        ...scopeArgs(scope, expected),
      ],
      signal,
      false,
    );
    const tick = parseTick(parseJson(result.stdout, "once"));
    if (result.exitCode !== 0 && !["blocked", "failed", "in_doubt"].includes(tick.state)) {
      requireSuccess("one-cli autonomy once", result);
    }
    return tick;
  }

  private async invoke(
    args: readonly string[],
    signal?: AbortSignal,
    assert = true,
  ): Promise<ProcessResult> {
    const release = this.resolveRelease();
    const result = await this.runner.run({
      executable: this.nodeExecutable,
      args: [
        release.entrypoint,
        "autonomy",
        ...args,
        "--workspace",
        path.resolve(this.workspace),
      ],
      cwd: this.workspace,
      env: this.environment,
      timeoutMs: 30 * 60_000,
      maxOutputBytes: 8 * 1024 * 1024,
      ...(signal ? { signal } : {}),
    });
    return assert ? requireSuccess(`one-cli autonomy ${args[0] ?? ""}`, result) : result;
  }

  private resolveRelease(): HarnessRelease {
    return typeof this.releaseResolver === "string"
      ? {
          entrypoint: path.resolve(this.releaseResolver),
          sha: null,
          bootstrap: true,
        }
      : this.releaseResolver();
  }
}

export function parseAutonomyStatus(value: unknown): AutonomyStatus {
  const object = record(value, "autonomy status");
  if (
    object.schema !== "autonomy.one-cli/status-v1" ||
    (object.executionScope !== "normal" && object.executionScope !== "roadmap-only") ||
    typeof object.mode !== "string" ||
    !Array.isArray(object.attempts)
  ) {
    throw new Error("one-cli status schema is invalid");
  }
  const activeAttempt =
    object.activeAttempt === null ? null : parseAttempt(object.activeAttempt);
  let action: AutonomyStatus["action"] = null;
  if (object.action !== null) {
    const nested = record(object.action, "autonomy action");
    if (
      typeof nested.type !== "string" ||
      typeof nested.aggregateId !== "string" ||
      typeof nested.createdAt !== "number"
    ) {
      throw new Error("one-cli status action is invalid");
    }
    action = {
      type: nested.type,
      aggregateId: nested.aggregateId,
      createdAt: nested.createdAt,
    };
  }
  return {
    schema: object.schema,
    executionScope: object.executionScope,
    mode: object.mode,
    activeAttempt,
    attempts: object.attempts.map(parseAttempt),
    action,
  };
}

function parseAttempt(value: unknown): AttemptStatus {
  const object = record(value, "attempt");
  if (
    typeof object.id !== "string" ||
    typeof object.issueId !== "string" ||
    typeof object.state !== "string" ||
    (object.prNumber !== null && typeof object.prNumber !== "number") ||
    (object.detail !== null &&
      (!object.detail || typeof object.detail !== "object" || Array.isArray(object.detail)))
  ) {
    throw new Error("one-cli status attempt is invalid");
  }
  return {
    id: object.id,
    issueId: object.issueId,
    state: object.state,
    prNumber: object.prNumber,
    detail: object.detail as Record<string, unknown> | null,
  };
}

function parseTick(value: unknown): TickOutput {
  const object = record(value, "autonomy tick");
  if (typeof object.action !== "string" || typeof object.state !== "string") {
    throw new Error("one-cli tick output is invalid");
  }
  return {
    action: object.action,
    state: object.state,
    ...(typeof object.attemptId === "string" ? { attemptId: object.attemptId } : {}),
    ...(typeof object.detail === "string" ? { detail: object.detail } : {}),
  };
}

function scopeArgs(
  scope: "normal" | "roadmap-only",
  expected?: ExpectedRoadmapBinding,
): string[] {
  if (scope === "normal") {
    if (expected) throw new Error("Normal scope cannot carry a roadmap binding");
    return [];
  }
  return [
    "--roadmap-only",
    ...(expected
      ? [
          "--expected-roadmap-issue",
          String(expected.issueNumber),
          "--expected-roadmap-marker",
          expected.seedMarker,
        ]
      : []),
  ];
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`one-cli ${label} returned malformed JSON`);
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}
