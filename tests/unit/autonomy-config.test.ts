import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadAutonomyConfig,
  narrowMode,
  parseCommand,
} from "../../src/autonomy/config.js";
import { makeTempDir, removeTempDir } from "../helpers.js";

describe("autonomy configuration", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) removeTempDir(root);
  });

  it("loads tracked policy into host-private state with a stable hash", () => {
    const home = makeTempDir("autonomy-home");
    roots.push(home);
    const repo = path.resolve(import.meta.dirname, "../..");
    const first = loadAutonomyConfig(repo, { env: { ONE_CLI_HOME: home } });
    const second = loadAutonomyConfig(repo, { env: { ONE_CLI_HOME: home } });

    expect(first.mode).toBe("propose");
    expect(first.maximumMode).toBe("auto-merge");
    expect(first.policyHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.researchPolicyHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(second.policyHash).toBe(first.policyHash);
    expect(first.stateRoot.startsWith(path.join(home, "autonomy"))).toBe(true);
    expect(first.commands.install).toMatchObject({
      executable: "npm",
      args: ["ci"],
      network: true,
    });
    expect(first.community.sources.length).toBeGreaterThan(0);
    expect(first.gapPolicy).toMatchObject({
      confidenceThreshold: "likely",
      minimumScore: 70,
      maximumPromotionsPerTick: 1,
    });
  });

  it("defaults omitted trusted maximum and invocation authority to propose", () => {
    const home = makeTempDir("autonomy-home");
    const repo = makeTempDir("autonomy-repo");
    roots.push(home, repo);
    const source = path.resolve(import.meta.dirname, "../../.autonomy");
    fs.cpSync(source, path.join(repo, ".autonomy"), { recursive: true });
    const productPath = path.join(repo, ".autonomy", "product.yml");
    fs.writeFileSync(
      productPath,
      fs.readFileSync(productPath, "utf8").replace(/^mode: auto-merge\n/mu, ""),
    );

    const config = loadAutonomyConfig(repo, { env: { ONE_CLI_HOME: home } });
    expect(config.maximumMode).toBe("propose");
    expect(config.mode).toBe("propose");
    expect(() =>
      loadAutonomyConfig(repo, {
        env: { ONE_CLI_HOME: home },
        mode: "auto-pr",
      }),
    ).toThrow("broaden");
  });

  it("accepts argv grammar and rejects shell grammar or mode broadening", () => {
    expect(parseCommand('npm run "test:unit"')).toEqual(["npm", "run", "test:unit"]);
    expect(() => parseCommand("npm test && touch /tmp/pwned")).toThrow("shell syntax");
    expect(narrowMode("auto-merge", "auto-pr")).toBe("auto-pr");
    expect(() => narrowMode("propose", "auto-pr")).toThrow("broaden");
  });

  it("includes the strict gap policy in the policy hash", () => {
    const firstHome = makeTempDir("autonomy-home");
    const secondHome = makeTempDir("autonomy-home");
    const repo = makeTempDir("autonomy-repo");
    roots.push(firstHome, secondHome, repo);
    const source = path.resolve(import.meta.dirname, "../../.autonomy");
    fs.cpSync(source, path.join(repo, ".autonomy"), { recursive: true });
    const before = loadAutonomyConfig(repo, { env: { ONE_CLI_HOME: firstHome } });
    const gapPath = path.join(repo, ".autonomy", "gap-policy.yml");
    fs.writeFileSync(
      gapPath,
      fs.readFileSync(gapPath, "utf8").replace("minimumScore: 70", "minimumScore: 71"),
    );
    const after = loadAutonomyConfig(repo, { env: { ONE_CLI_HOME: secondHome } });
    expect(after.policyHash).not.toBe(before.policyHash);
    fs.appendFileSync(gapPath, "\nunexpected: true\n");
    expect(() =>
      loadAutonomyConfig(repo, { env: { ONE_CLI_HOME: secondHome } }),
    ).toThrow();
  });

  it("keeps research continuity across unrelated global policy changes", () => {
    const firstHome = makeTempDir("autonomy-home");
    const secondHome = makeTempDir("autonomy-home");
    const repo = makeTempDir("autonomy-repo");
    roots.push(firstHome, secondHome, repo);
    fs.cpSync(path.resolve(import.meta.dirname, "../../.autonomy"), path.join(repo, ".autonomy"), {
      recursive: true,
    });
    const before = loadAutonomyConfig(repo, { env: { ONE_CLI_HOME: firstHome } });
    const productPath = path.join(repo, ".autonomy", "product.yml");
    fs.writeFileSync(
      productPath,
      fs.readFileSync(productPath, "utf8").replace("tickMinutes: 60", "tickMinutes: 61"),
    );
    const after = loadAutonomyConfig(repo, { env: { ONE_CLI_HOME: secondHome } });
    expect(after.policyHash).not.toBe(before.policyHash);
    expect(after.researchPolicyHash).toBe(before.researchPolicyHash);
  });

  it("does not create host state while loading observe mode", () => {
    const parent = makeTempDir("autonomy-observe-parent");
    roots.push(parent);
    const home = path.join(parent, "missing-home");
    loadAutonomyConfig(path.resolve(import.meta.dirname, "../.."), {
      env: { ONE_CLI_HOME: home },
      mode: "observe",
    });
    expect(fs.existsSync(home)).toBe(false);
  });
});
