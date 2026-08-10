import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalGhEnvironment,
  safeEnvironment,
  tokenBearingEnvironmentNames,
} from "../../harness/src/environment.js";
import { OneCliClient } from "../../harness/src/one-cli.js";
import type {
  ProcessRequest,
  ProcessResult,
  ProcessRunner,
} from "../../harness/src/runner.js";
import { makeTempDir, removeTempDir } from "../helpers.js";

describe("harness host and Worker environments", () => {
  it("strips GitHub, verifier, App, and private-key values from the model Worker", async () => {
    const root = makeTempDir("harness-worker-env");
    try {
      const environment = safeEnvironment(root, {
        OPENAI_API_KEY: "product-model-key",
        OPENAI_MODEL: "product-model",
        ONE_CLI_HOME: "$HOME/wrong-state",
        GH_TOKEN: "github-token",
        GITHUB_TOKEN: "actions-token",
        ONE_CLI_VERIFIER_MODEL_A: "verifier-model",
        ONE_CLI_VERIFIER_API_KEY: "verifier-key",
        ONE_CLI_GITHUB_APP_ID: "123",
        ONE_CLI_GITHUB_APP_PRIVATE_KEY: "private-key",
        CUSTOM_PRIVATE_KEY: "private-key",
      }, {
        HOME: root,
        PATH: "/usr/bin:/bin",
      });
      expect(environment).toMatchObject({
        OPENAI_API_KEY: "product-model-key",
        OPENAI_MODEL: "product-model",
        ONE_CLI_HOME: root,
      });
      expect(environment).not.toHaveProperty("GH_TOKEN");
      expect(environment).not.toHaveProperty("GITHUB_TOKEN");
      expect(environment).not.toHaveProperty("ONE_CLI_VERIFIER_MODEL_A");
      expect(environment).not.toHaveProperty("ONE_CLI_VERIFIER_API_KEY");
      expect(environment).not.toHaveProperty("ONE_CLI_GITHUB_APP_ID");
      expect(environment).not.toHaveProperty("ONE_CLI_GITHUB_APP_PRIVATE_KEY");
      expect(environment).not.toHaveProperty("CUSTOM_PRIVATE_KEY");

      let request: ProcessRequest | undefined;
      const runner: ProcessRunner = {
        run: async (value) => {
          request = value;
          return processResult(JSON.stringify({ ok: true, checks: [] }));
        },
      };
      const oneCli = new OneCliClient(runner, root, path.join(root, "dist/index.js"), environment);
      await oneCli.doctor();
      expect(request?.env).toEqual(environment);
      expect(JSON.stringify(request?.env)).not.toContain("verifier-key");
      expect(JSON.stringify(request?.env)).not.toContain("github-token");
    } finally {
      removeTempDir(root);
    }
  });

  it("binds gh to one canonical keyring config without exporting a token", () => {
    const root = makeTempDir("harness-gh-config");
    try {
      const config = path.join(root, ".config", "gh");
      fs.mkdirSync(config, { recursive: true });
      const environment = canonicalGhEnvironment({
        HOME: root,
        GH_CONFIG_DIR: config,
        PATH: "/usr/bin:/bin",
        GH_TOKEN: "must-not-export",
      });
      expect(environment).toEqual({
        NO_COLOR: "1",
        GH_PROMPT_DISABLED: "1",
        HOME: root,
        GH_CONFIG_DIR: config,
        PATH: "/usr/bin:/bin",
      });
    } finally {
      removeTempDir(root);
    }
  });

  it("reports token-bearing host variables for fail-closed readiness", () => {
    expect(tokenBearingEnvironmentNames(
      { GH_TOKEN: "one", EMPTY: "" },
      { GITHUB_TOKEN: "two", GH_TOKEN: "three" },
    )).toEqual(["GH_TOKEN", "GITHUB_TOKEN"]);
  });
});

function processResult(stdout: string): ProcessResult {
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
