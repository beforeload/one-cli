import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGitHubRuntimeAdapters,
  dispatchAutonomyCli,
  readWorkspaceJson,
} from "../../src/autonomy/cli.js";
import { loadAutonomyConfig } from "../../src/autonomy/config.js";
import type { GitHubGraphqlTransport } from "../../src/autonomy/github-graphql.js";
import type { GitHubTransport } from "../../src/autonomy/github.js";
import { AutonomyStore } from "../../src/autonomy/store.js";
import { main } from "../../src/cli.js";
import { makeTempDir, removeTempDir } from "../helpers.js";

describe("autonomy CLI dispatch", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("leaves normal CLI commands untouched", async () => {
    await expect(dispatchAutonomyCli(["run", "--prompt", "hello"])).resolves.toBeUndefined();
  });

  it("documents the autonomy namespace", async () => {
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await expect(dispatchAutonomyCli(["autonomy", "--help"])).resolves.toBe(0);
    expect(output).toHaveBeenCalledWith(
      expect.stringContaining("one-cli autonomy <subcommand>"),
    );
    const help = output.mock.calls.map(([value]) => String(value)).join("");
    expect(help).toContain("release status|stage <sha>|promote <sha>|rollback [sha]");
    expect(help).toContain("schedule status");
    expect(help).toContain("intake promote-user");
    expect(help).toContain("supervise");
  });

  it("dispatches through the autonomy namespace and permits modes within trusted maximum", async () => {
    const home = makeTempDir("autonomy-cli");
    vi.stubEnv("ONE_CLI_HOME", home);
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const repo = path.resolve(import.meta.dirname, "../..");
    try {
      await expect(
        dispatchAutonomyCli(["autonomy", "init", "--workspace", repo, "--mode", "auto-merge"]),
      ).resolves.toBe(0);
      expect(output).toHaveBeenCalledWith(expect.stringContaining("maximumMode=auto-merge"));
    } finally {
      removeTempDir(home);
    }
  });

  it("supports release status and rejects incomplete namespaced operations", async () => {
    const home = makeTempDir("autonomy-cli-release");
    vi.stubEnv("ONE_CLI_HOME", home);
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const error = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const repo = path.resolve(import.meta.dirname, "../..");
    try {
      await expect(
        dispatchAutonomyCli(["release", "status", "--workspace", repo, "--output", "json"]),
      ).resolves.toBe(0);
      expect(output).toHaveBeenCalledWith(expect.stringContaining('"active": null'));
      await expect(
        dispatchAutonomyCli(["release", "stage", "--workspace", repo]),
      ).resolves.toBe(2);
      await expect(
        dispatchAutonomyCli(["intake", "promote-self", "--workspace", repo]),
      ).resolves.toBe(2);
      await expect(
        dispatchAutonomyCli(["schedule", "unknown", "--workspace", repo]),
      ).resolves.toBe(2);
      await expect(
        dispatchAutonomyCli(["supervise", "unexpected", "--workspace", repo]),
      ).resolves.toBe(2);
      expect(error).toHaveBeenCalled();
    } finally {
      removeTempDir(home);
    }
  });

  it("does not expose legacy top-level autonomy aliases", async () => {
    const error = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await expect(main(["init"])).resolves.toBe(2);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Unexpected positional arguments"));
  });

  it("confines bounded intake JSON to regular workspace files", () => {
    const workspace = makeTempDir("autonomy-intake-files");
    const outside = makeTempDir("autonomy-intake-outside");
    try {
      fs.writeFileSync(path.join(workspace, "finding.json"), '{"title":"safe"}');
      expect(readWorkspaceJson(workspace, "finding.json")).toEqual({ title: "safe" });

      fs.writeFileSync(path.join(outside, "outside.json"), "{}");
      expect(() =>
        readWorkspaceJson(workspace, path.join(outside, "outside.json")),
      ).toThrow("escapes");

      fs.symlinkSync(
        path.join(workspace, "finding.json"),
        path.join(workspace, "link.json"),
      );
      expect(() => readWorkspaceJson(workspace, "link.json")).toThrow("regular file");

      fs.writeFileSync(path.join(workspace, "large.json"), "x".repeat(256 * 1024 + 1));
      expect(() => readWorkspaceJson(workspace, "large.json")).toThrow("bounded");
    } finally {
      removeTempDir(workspace);
      removeTempDir(outside);
    }
  });

  it("composes active GitHub research but keeps observe composition read-only", () => {
    const home = makeTempDir("autonomy-cli-composition");
    const repo = path.resolve(import.meta.dirname, "../..");
    const store = new AutonomyStore(":memory:");
    const rest = { request: vi.fn() } as unknown as GitHubTransport;
    const graphql = { request: vi.fn() } as unknown as GitHubGraphqlTransport;
    try {
      const active = loadAutonomyConfig(repo, {
        env: { ONE_CLI_HOME: home },
        mode: "propose",
      });
      expect(
        createGitHubRuntimeAdapters(active, store, { rest, graphql }).research,
      ).toBeDefined();
      const observe = loadAutonomyConfig(repo, {
        env: { ONE_CLI_HOME: home },
        mode: "observe",
      });
      expect(
        createGitHubRuntimeAdapters(observe, store, { rest, graphql }).research,
      ).toBeUndefined();
      expect(rest.request).not.toHaveBeenCalled();
      expect(graphql.request).not.toHaveBeenCalled();
    } finally {
      store.close();
      removeTempDir(home);
    }
  });

  it("reports the nine-source monitoring inventory in status and events", async () => {
    const home = makeTempDir("autonomy-cli-status");
    vi.stubEnv("ONE_CLI_HOME", home);
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const repo = path.resolve(import.meta.dirname, "../..");
    try {
      await expect(
        dispatchAutonomyCli(["status", "--workspace", repo, "--output", "json"]),
      ).resolves.toBe(0);
      await expect(
        dispatchAutonomyCli(["events", "--workspace", repo, "--output", "json"]),
      ).resolves.toBe(0);
      const rendered = output.mock.calls.map(([value]) => String(value)).join("");
      expect(rendered).toContain('"activeSourceCount": 9');
      expect(rendered).toContain('"baselinedSourceCount": 0');
      expect(rendered).toContain('"monitoring"');
    } finally {
      removeTempDir(home);
    }
  });

  it("observes absent or existing state without filesystem mutation", async () => {
    const parent = makeTempDir("autonomy-cli-observe");
    const missingHome = path.join(parent, "missing-home");
    const repo = path.resolve(import.meta.dirname, "../..");
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      vi.stubEnv("ONE_CLI_HOME", missingHome);
      await expect(
        dispatchAutonomyCli(["status", "--workspace", repo, "--mode", "observe", "--output", "json"]),
      ).resolves.toBe(0);
      expect(fs.existsSync(missingHome)).toBe(false);

      const existingHome = path.join(parent, "existing-home");
      const config = loadAutonomyConfig(repo, { env: { ONE_CLI_HOME: existingHome } });
      const databasePath = path.join(config.stateRoot, "state.sqlite");
      const store = new AutonomyStore(databasePath);
      store.appendEvent({
        aggregateType: "test",
        aggregateId: "observe",
        type: "test.persisted",
      });
      store.close();
      const before = {
        bytes: fs.readFileSync(databasePath),
        mtimeMs: fs.statSync(databasePath).mtimeMs,
      };
      vi.stubEnv("ONE_CLI_HOME", existingHome);
      await expect(
        dispatchAutonomyCli(["status", "--workspace", repo, "--mode", "observe", "--output", "json"]),
      ).resolves.toBe(0);
      expect(fs.readFileSync(databasePath)).toEqual(before.bytes);
      expect(fs.statSync(databasePath).mtimeMs).toBe(before.mtimeMs);
      expect(output).toHaveBeenCalled();
    } finally {
      removeTempDir(parent);
    }
  });
});
