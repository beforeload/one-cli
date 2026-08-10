import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../..");
const SCRIPT = path.join(ROOT, "scripts/bootstrap-verifier-runner.sh");
const cleanup: string[] = [];

afterEach(() => {
  for (const candidate of cleanup.splice(0)) {
    fs.rmSync(candidate, { recursive: true, force: true });
  }
});

describe("self-hosted verifier runner bootstrap", () => {
  it("is dry-run by default and performs no host writes", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "one-cli-runner-dry-"));
    cleanup.push(root);
    const home = path.join(root, "one-cli-home");
    const result = spawnSync("/bin/bash", [SCRIPT], {
      env: { ...process.env, ONE_CLI_HOME: home },
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Dry run; no files, registration, or services were changed.");
    expect(result.stdout).toContain("self-hosted, macOS, one-cli-verifier");
    expect(fs.existsSync(home)).toBe(false);
  });

  it("requires explicit apply credentials before creating the runner home", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "one-cli-runner-apply-"));
    cleanup.push(root);
    const home = path.join(root, "one-cli-home");
    const result = spawnSync("/bin/bash", [SCRIPT, "--apply"], {
      env: { ...process.env, ONE_CLI_HOME: home },
      encoding: "utf8",
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("ONE_CLI_RUNNER_SHA256");
    expect(fs.existsSync(home)).toBe(false);
  });

  it("bounds downloads and never persists the registration token", () => {
    const script = fs.readFileSync(SCRIPT, "utf8");
    expect(script).toContain("--connect-timeout 15 --max-time 300");
    expect(script).toContain("--retry 3 --retry-all-errors");
    expect(script).toContain("--proto '=https' --tlsv1.2");
    expect(script).toContain("shasum -a 256 --check");
    expect(script).toContain('--url "$REPOSITORY_URL"');
    expect(script).toContain('REPOSITORY_URL="https://github.com/beforeload/one-cli"');
    expect(script).toContain('--labels "$RUNNER_LABEL"');
    expect(script).toContain("./svc.sh install");
    expect(script).toContain("./svc.sh start");
    expect(script).not.toMatch(/(?:printf|echo|cat).*\$ONE_CLI_RUNNER_REGISTRATION_TOKEN/u);
    expect(script).not.toMatch(/(?:>|tee|install).*(?:TOKEN|token)/u);
    expect(script).toContain("unset ONE_CLI_RUNNER_REGISTRATION_TOKEN");
  });
});
