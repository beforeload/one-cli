import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OneCliClient } from "../../harness/src/one-cli.js";
import { resolveHarnessRelease } from "../../harness/src/release.js";
import type { ProcessRunner, ProcessRequest } from "../../harness/src/runner.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("harness active release integration", () => {
  it("uses the exact repo-scoped immutable entrypoint and SHA on the next tick", async () => {
    const home = temporary("one-cli-home");
    const workspace = temporary("workspace");
    const repoKey = `fake-repo-${"1".repeat(12)}`;
    fs.mkdirSync(path.join(workspace, "dist"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "dist", "index.js"), "workspace bootstrap");

    const sha = "a".repeat(40);
    const release = path.join(home, "autonomy", repoKey, "releases", sha);
    const entrypoint = path.join(release, "dist", "index.js");
    const bytes = Buffer.from("immutable active release");
    fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
    fs.writeFileSync(entrypoint, bytes);
    const manifestBody = {
      version: 1,
      commitSha: sha,
      totalBytes: bytes.length,
      files: [{
        path: "dist/index.js",
        bytes: bytes.length,
        sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
        executable: false,
      }],
    };
    fs.writeFileSync(path.join(release, "manifest.json"), JSON.stringify({
      ...manifestBody,
      manifestSha256: crypto.createHash("sha256").update(stableJson(manifestBody)).digest("hex"),
    }));
    fs.writeFileSync(path.join(home, "autonomy", repoKey, "releases", "state.json"), JSON.stringify({
      version: 1,
      active: sha,
      generation: 1,
    }));

    const requests: ProcessRequest[] = [];
    const runner: ProcessRunner = {
      run: async (request) => {
        requests.push(request);
        return {
          exitCode: 0,
          signal: null,
          stdout: JSON.stringify({ action: "select", state: "issue_selected" }),
          stderr: "",
          durationMs: 1,
          timedOut: false,
          cancelled: false,
          outputLimitExceeded: false,
        };
      },
    };
    const client = new OneCliClient(
      runner,
      workspace,
      () => resolveHarnessRelease(home, workspace, repoKey),
      { ONE_CLI_HOME: home },
    );
    await expect(client.once("roadmap-only", {
      issueNumber: 42,
      seedMarker: "<!-- one-cli:cold-start-seed:01-semantic-coherence:v1 -->",
    })).resolves.toMatchObject({ state: "issue_selected" });

    expect(client.activeRelease()).toMatchObject({ sha, entrypoint, bootstrap: false });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.executable).toBe(process.execPath);
    expect(requests[0]?.args[0]).toBe(entrypoint);
    expect(requests[0]?.args).toContain("42");
    expect(requests[0]?.args).not.toContain(path.join(workspace, "dist", "index.js"));
  });
});

function temporary(name: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  roots.push(root);
  return fs.realpathSync(root);
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
