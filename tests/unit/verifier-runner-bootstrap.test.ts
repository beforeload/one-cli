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
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Dry run; no files, registration, or services were changed.");
    expect(result.stdout).toContain("self-hosted, macOS, one-cli-verifier");
    expect(result.stdout).toContain("node bin:");
    expect(result.stdout).toMatch(/node version: v(?:22\.(?:1[3-9]|[2-9][0-9])|2[34]\.)/u);
    expect(result.stdout).toMatch(/npm version: [0-9]+\.[0-9]+\.[0-9]+/u);
    expect(result.stdout).toContain(
      "service PATH: /",
    );
    expect(result.stdout).toContain(
      ":/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    );
    expect(fs.existsSync(home)).toBe(false);
  });

  it("canonicalizes an explicit preinstalled Node/npm bin and reports it", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "one-cli-runner-node-"));
    cleanup.push(root);
    const toolchain = fakeToolchain(root, "v24.14.1", "11.11.0");
    const alias = path.join(root, "node-alias");
    fs.symlinkSync(toolchain, alias);
    const result = spawnSync("/bin/bash", [SCRIPT], {
      env: {
        ...process.env,
        ONE_CLI_HOME: path.join(root, "one-cli-home"),
        ONE_CLI_NODE_BIN: alias,
      },
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`node bin: ${fs.realpathSync(toolchain)}`);
    expect(result.stdout).toContain("node version: v24.14.1");
    expect(result.stdout).toContain("npm version: 11.11.0");
  });

  it("rejects a host Node version outside the supported verifier range", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "one-cli-runner-old-node-"));
    cleanup.push(root);
    const toolchain = fakeToolchain(root, "v22.12.0", "10.9.0");
    const home = path.join(root, "one-cli-home");
    const result = spawnSync("/bin/bash", [SCRIPT], {
      env: { ...process.env, ONE_CLI_HOME: home, ONE_CLI_NODE_BIN: toolchain },
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain("Verifier Node.js must be >=22.13.0 and <25");
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
    expect(script).toContain('mktemp "$ONE_CLI_HOME/.runner.XXXXXX"');
    expect(script).toContain("shasum -a 256 --check");
    expect(script).toContain('--url "$REPOSITORY_URL"');
    expect(script).toContain('REPOSITORY_URL="https://github.com/beforeload/one-cli"');
    expect(script).toContain('--labels "$RUNNER_LABEL"');
    expect(script).toContain('KNOWN_NODE_BIN="/Users/daniel/.nvm/versions/node/v24.14.1/bin"');
    expect(script).toContain(
      'STRICT_PATH_SUFFIX="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"',
    );
    expect(script).toContain('ONE_CLI_NODE_BIN="$(cd "$requested_node_bin" && pwd -P)"');
    expect(script).toContain('NODE_VERSION="$("$NODE_EXECUTABLE" --version)"');
    expect(script).toContain('NPM_VERSION="$("$NPM_EXECUTABLE" --version)"');
    expect(script).toContain("Verifier Node.js must be >=22.13.0 and <25");
    expect(script).toContain("printf 'ONE_CLI_NODE_BIN=%s\\n' \"$ONE_CLI_NODE_BIN\"");
    expect(script).toContain("printf 'PATH=%s\\n' \"$TOOLCHAIN_PATH\"");
    expect(script).toContain('} > "$RUNNER_HOME/.env"');
    expect(script).toContain('chmod 600 "$RUNNER_HOME/.env"');
    expect(script).toContain("./svc.sh install");
    expect(script).toContain("./svc.sh start");
    expect(script).not.toMatch(/(?:printf|echo|cat).*\$ONE_CLI_RUNNER_REGISTRATION_TOKEN/u);
    expect(script).not.toMatch(/(?:>|tee|install).*(?:TOKEN|token)/u);
    expect(script).toContain("unset ONE_CLI_RUNNER_REGISTRATION_TOKEN");
    expect(script.lastIndexOf("unset ONE_CLI_RUNNER_REGISTRATION_TOKEN")).toBeLessThan(
      script.indexOf('} > "$RUNNER_HOME/.env"'),
    );
    expect(script.indexOf('} > "$RUNNER_HOME/.env"')).toBeLessThan(
      script.indexOf("./svc.sh install"),
    );
  });
});

function fakeToolchain(root: string, nodeVersion: string, npmVersion: string): string {
  const bin = path.join(root, "toolchain", "bin");
  fs.mkdirSync(bin, { recursive: true });
  for (const [name, version] of [["node", nodeVersion], ["npm", npmVersion]] as const) {
    const executable = path.join(bin, name);
    fs.writeFileSync(executable, `#!/bin/bash\n/usr/bin/printf '%s\\n' '${version}'\n`, {
      mode: 0o755,
    });
  }
  return bin;
}
