import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");
const cliPath = path.join(root, "dist/index.js");

async function runBuiltCli(args: string[]) {
  const env = { ...process.env };
  delete env.OPENAI_API_KEY;
  delete env.OPENAI_BASE_URL;
  delete env.OPENAI_MODEL;

  return await new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, [cliPath, ...args], {
        cwd: root,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 10_000,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    },
  );
}

describe("built CLI smoke", () => {
  it("prints its version without provider configuration", async () => {
    expect(fs.existsSync(cliPath), "run npm run build before smoke tests").toBe(true);
    const result = await runBuiltCli(["--version"]);
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(root, "package.json"), "utf8"),
    ) as { version: string };

    expect(result).toEqual({
      code: 0,
      stdout: `${packageJson.version}\n`,
      stderr: "",
    });
  });

  it("prints help without provider configuration", async () => {
    const result = await runBuiltCli(["--help"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("one-cli");
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("--approval");
    expect(result.stdout).toContain("--version");
  });
});
