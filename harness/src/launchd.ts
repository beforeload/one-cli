import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HarnessPaths } from "./host.js";
import type { ProcessRunner } from "./runner.js";
import { requireSuccess } from "./runner.js";

export const LAUNCHD_LABEL = "com.beforeload.one-cli-harness";

export function launchdPlist(input: {
  nodeExecutable: string;
  harnessEntrypoint: string;
  workspace: string;
  paths: HarnessPaths;
  ghExecutable: string;
}): string {
  const values = [
    input.nodeExecutable,
    input.harnessEntrypoint,
    "run",
    "--workspace",
    input.workspace,
  ];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${LAUNCHD_LABEL}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...values.map((value) => `    <string>${xml(value)}</string>`),
    "  </array>",
    "  <key>WorkingDirectory</key>",
    `  <string>${xml(input.workspace)}</string>`,
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    "    <key>ONE_CLI_HOME</key>",
    `    <string>${xml(input.paths.oneCliHome)}</string>`,
    "    <key>ONE_CLI_HARNESS_ENV_FILE</key>",
    `    <string>${xml(input.paths.envFile)}</string>`,
    "    <key>ONE_CLI_GH_EXECUTABLE</key>",
    `    <string>${xml(input.ghExecutable)}</string>`,
    "  </dict>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <dict>",
    "    <key>SuccessfulExit</key>",
    "    <false/>",
    "  </dict>",
    "  <key>ThrottleInterval</key>",
    "  <integer>300</integer>",
    "  <key>StandardOutPath</key>",
    "  <string>/dev/null</string>",
    "  <key>StandardErrorPath</key>",
    "  <string>/dev/null</string>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

export async function installLaunchd(input: {
  apply: boolean;
  runner: ProcessRunner;
  plist: string;
  paths: HarnessPaths;
}): Promise<{ dryRun: boolean; path: string; label: string }> {
  if (!input.apply) return { dryRun: true, path: input.paths.launchAgent, label: LAUNCHD_LABEL };
  assertDarwin();
  fs.mkdirSync(path.dirname(input.paths.launchAgent), { recursive: true, mode: 0o700 });
  fs.mkdirSync(input.paths.stateRoot, { recursive: true, mode: 0o700 });
  const temporary = `${input.paths.launchAgent}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, input.plist, { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, input.paths.launchAgent);
  const domain = `gui/${userId()}`;
  await input.runner.run({
    executable: "/bin/launchctl",
    args: ["bootout", domain, input.paths.launchAgent],
    timeoutMs: 15_000,
    maxOutputBytes: 256 * 1024,
  });
  requireSuccess("launchctl bootstrap", await input.runner.run({
    executable: "/bin/launchctl",
    args: ["bootstrap", domain, input.paths.launchAgent],
    timeoutMs: 15_000,
    maxOutputBytes: 256 * 1024,
  }));
  return { dryRun: false, path: input.paths.launchAgent, label: LAUNCHD_LABEL };
}

export async function uninstallLaunchd(input: {
  apply: boolean;
  runner: ProcessRunner;
  paths: HarnessPaths;
}): Promise<{ dryRun: boolean; path: string; label: string }> {
  if (!input.apply) return { dryRun: true, path: input.paths.launchAgent, label: LAUNCHD_LABEL };
  assertDarwin();
  const domain = `gui/${userId()}`;
  if (fs.existsSync(input.paths.launchAgent)) {
    await input.runner.run({
      executable: "/bin/launchctl",
      args: ["bootout", domain, input.paths.launchAgent],
      timeoutMs: 15_000,
      maxOutputBytes: 256 * 1024,
    });
    fs.unlinkSync(input.paths.launchAgent);
  }
  return { dryRun: false, path: input.paths.launchAgent, label: LAUNCHD_LABEL };
}

export async function launchdStatus(
  runner: ProcessRunner,
): Promise<{ installed: boolean; loaded: boolean; detail: string }> {
  if (process.platform !== "darwin") {
    return { installed: false, loaded: false, detail: "launchd is available only on Darwin" };
  }
  const result = await runner.run({
    executable: "/bin/launchctl",
    args: ["print", `gui/${userId()}/${LAUNCHD_LABEL}`],
    timeoutMs: 15_000,
    maxOutputBytes: 256 * 1024,
  });
  return {
    installed: result.exitCode === 0,
    loaded: result.exitCode === 0,
    detail: (result.stdout || result.stderr).trim().slice(0, 2_000),
  };
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function assertDarwin(): void {
  if (os.platform() !== "darwin") throw new Error("launchd commands require Darwin");
}

function userId(): number {
  if (process.getuid === undefined) throw new Error("launchd requires a POSIX user id");
  return process.getuid();
}
