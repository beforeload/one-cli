import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dispatchAutonomyCli,
  readWorkspaceJson,
} from "../../src/autonomy/cli.js";
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
});
