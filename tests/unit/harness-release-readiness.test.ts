import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveHarnessRelease } from "../../harness/src/release.js";
import type {
  ProcessRequest,
  ProcessResult,
  ProcessRunner,
} from "../../harness/src/runner.js";
import { loadVerifierPolicy } from "../../harness/src/verifier.js";
import { WorkerReleaseReadiness } from "../../harness/src/worker-policy.js";
import { makeTempDir, removeTempDir } from "../helpers.js";

const ROOT = path.resolve(import.meta.dirname, "../..");
const POLICY = loadVerifierPolicy(path.join(ROOT, "harness/verifier-policy.yml"));
const HEAD = "a".repeat(40);
const HANDOFF = "b".repeat(40);
const SECOND = "c".repeat(40);
const REPO_KEY = `fake-repo-${"1".repeat(12)}`;
const MODULES = [
  "dist/index.js",
  "dist/agent.js",
  "dist/approval.js",
  "dist/autonomy/cli.js",
  "dist/autonomy/intake.js",
  "dist/autonomy/maintenance.js",
  "dist/autonomy/orchestrator.js",
  "dist/autonomy/roadmap-enforcement.js",
  "dist/autonomy/worker.js",
  "dist/policy.js",
  "dist/tools.js",
  "dist/workspace.js",
] as const;
const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) removeTempDir(root);
});

describe("executable-bound Worker readiness", () => {
  it("accepts a clean bootstrap whose dist exactly matches a reproducible build", async () => {
    const fixture = bootstrapFixture();
    const expected = compiledModules();
    writeModules(fixture.workspace, expected);
    const readiness = new WorkerReleaseReadiness({
      workspace: fixture.workspace,
      policy: POLICY,
      runner: bootstrapRunner(expected),
      releaseResolver: () =>
        resolveHarnessRelease(fixture.home, fixture.workspace, REPO_KEY),
    });

    const result = await readiness.inspect();

    expect(result).toMatchObject({
      ready: true,
      release: {
        bootstrap: true,
        sha: HEAD,
        entrypoint: path.join(fixture.workspace, "dist/index.js"),
        entrypointSha256: sha256(expected["dist/index.js"]),
        manifestSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      },
    });
    expect(Object.keys(result.release!.moduleHashes)).toEqual(MODULES);
    expect(readiness.executableRelease()).toMatchObject({
      bootstrap: true,
      entrypoint: path.join(fixture.workspace, "dist/index.js"),
    });
  });

  it("blocks a stale bootstrap dist without importing or evaluating it", async () => {
    const fixture = bootstrapFixture();
    const expected = compiledModules();
    writeModules(fixture.workspace, {
      ...expected,
      "dist/autonomy/worker.js": `${expected["dist/autonomy/worker.js"]}\n// stale`,
    });
    const readiness = new WorkerReleaseReadiness({
      workspace: fixture.workspace,
      policy: POLICY,
      runner: bootstrapRunner(expected),
      releaseResolver: () =>
        resolveHarnessRelease(fixture.home, fixture.workspace, REPO_KEY),
    });

    await expect(readiness.inspect()).resolves.toMatchObject({
      ready: false,
      detail: "Bootstrap dist is stale or non-reproducible: dist/autonomy/worker.js",
    });
    expect(() => readiness.executableRelease()).toThrow(
      "has not passed executable-bound readiness",
    );
  });

  it("accepts a manifest-bound immutable release under the handoff ancestry policy", async () => {
    const fixture = bootstrapFixture();
    writeImmutableRelease(fixture.home, HEAD, compiledModules());
    activate(fixture.home, HEAD);
    const assertDescendsFrom = vi.fn(async () => undefined);
    const readiness = new WorkerReleaseReadiness({
      workspace: fixture.workspace,
      policy: POLICY,
      runner: rejectingRunner(),
      releaseResolver: () =>
        resolveHarnessRelease(fixture.home, fixture.workspace, REPO_KEY),
      handoffSha: () => HANDOFF,
      assertDescendsFrom,
    });

    const result = await readiness.inspect();

    expect(result).toMatchObject({
      ready: true,
      release: {
        bootstrap: false,
        sha: HEAD,
        entrypoint: path.join(
          fixture.home,
          "autonomy",
          REPO_KEY,
          "releases",
          HEAD,
          "dist/index.js",
        ),
        manifestSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      },
    });
    expect(assertDescendsFrom).toHaveBeenCalledWith(HANDOFF, HEAD, undefined);
    expect(readiness.executableRelease()).toMatchObject({ bootstrap: false, sha: HEAD });
  });

  it("blocks execution if the active immutable release changes after inspection", async () => {
    const fixture = bootstrapFixture();
    writeImmutableRelease(fixture.home, HEAD, compiledModules());
    writeImmutableRelease(fixture.home, SECOND, compiledModules());
    activate(fixture.home, HEAD);
    const readiness = new WorkerReleaseReadiness({
      workspace: fixture.workspace,
      policy: POLICY,
      runner: rejectingRunner(),
      releaseResolver: () =>
        resolveHarnessRelease(fixture.home, fixture.workspace, REPO_KEY),
    });
    await expect(readiness.inspect()).resolves.toMatchObject({
      ready: true,
      release: { sha: HEAD },
    });

    activate(fixture.home, SECOND);

    expect(() => readiness.executableRelease()).toThrow(
      "Executable release changed after readiness inspection",
    );
  });
});

function bootstrapFixture(): { home: string; workspace: string } {
  const root = makeTempDir("release-readiness");
  roots.push(root);
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(home);
  fs.mkdirSync(path.join(workspace, "node_modules/typescript/bin"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "node_modules/typescript/bin/tsc"), "compiler");
  fs.writeFileSync(path.join(workspace, "tsconfig.build.json"), "{}");
  return {
    home: fs.realpathSync(home),
    workspace: fs.realpathSync(workspace),
  };
}

function compiledModules(): Record<(typeof MODULES)[number], string> {
  const modules = Object.fromEntries(MODULES.map((module) => [module, "export {};\n"])) as
    Record<(typeof MODULES)[number], string>;
  modules["dist/index.js"] = 'import { main } from "./cli.js";\n';
  modules["dist/autonomy/worker.js"] = `
const prompt = "Shell and network " + "tools are unavailable.";
const workspace = new Workspace(options.worktreePath, {
  allowedWritePaths: options.approvedPaths
});
const tools = new ToolRunner(undefined, ["shell"]);
const approval = new DenyApprovalPort();
`;
  modules["dist/autonomy/orchestrator.js"] = `
import { runAutonomyWorker } from "./worker.js";
const worker = this.dependencies.worker ?? runAutonomyWorker;
const stored = { approvedPaths: [...approvedPaths] };
worker({ approvedPaths });
`;
  modules["dist/autonomy/cli.js"] = "const orchestrator = new AutonomyOrchestrator({});\n";
  modules["dist/tools.js"] = `
    name: "read",
    name: "list",
    name: "grep",
    name: "write",
    name: "edit",
    name: "shell",
`;
  modules["dist/workspace.js"] = `
this.allowedWritePaths.has(resolved.relativePath);
throw new Error("Path is outside the approved write binding");
throw new Error("Symlinks are not followed");
`;
  return modules;
}

function writeModules(
  root: string,
  modules: Readonly<Record<string, string>>,
  stripDist = false,
): void {
  for (const [relativePath, content] of Object.entries(modules)) {
    const target = stripDist ? relativePath.replace(/^dist\//u, "") : relativePath;
    const absolute = path.join(root, ...target.split("/"));
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
  }
}

function bootstrapRunner(
  rebuilt: Readonly<Record<string, string>>,
): ProcessRunner {
  return {
    run: async (request: ProcessRequest) => {
      if (request.args[0] === "rev-parse") return result(`${HEAD}\n`);
      if (request.args[0] === "status") return result("");
      const outDirIndex = request.args.indexOf("--outDir");
      if (outDirIndex >= 0) {
        writeModules(request.args[outDirIndex + 1]!, rebuilt, true);
        return result("");
      }
      throw new Error(`Unexpected readiness process: ${request.args.join(" ")}`);
    },
  };
}

function rejectingRunner(): ProcessRunner {
  return {
    run: async (request) => {
      throw new Error(`Immutable inspection executed a process: ${request.args.join(" ")}`);
    },
  };
}

function writeImmutableRelease(
  home: string,
  commitSha: string,
  modules: Readonly<Record<string, string>>,
): void {
  const release = path.join(home, "autonomy", REPO_KEY, "releases", commitSha);
  writeModules(release, modules);
  const files = Object.entries(modules)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([filePath, content]) => ({
      path: filePath,
      bytes: Buffer.byteLength(content),
      sha256: sha256(content),
      executable: false,
    }));
  const manifestBody = {
    version: 1,
    commitSha,
    totalBytes: files.reduce((total, file) => total + file.bytes, 0),
    files,
  };
  fs.writeFileSync(path.join(release, "manifest.json"), JSON.stringify({
    ...manifestBody,
    manifestSha256: sha256(stableJson(manifestBody)),
  }));
}

function activate(home: string, commitSha: string): void {
  const releases = path.join(home, "autonomy", REPO_KEY, "releases");
  fs.writeFileSync(path.join(releases, "state.json"), JSON.stringify({
    version: 1,
    active: commitSha,
    generation: 1,
  }));
}

function result(stdout: string): ProcessResult {
  return {
    exitCode: 0,
    signal: null,
    stdout,
    stderr: "",
    durationMs: 1,
    timedOut: false,
    cancelled: false,
    outputLimitExceeded: false,
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
