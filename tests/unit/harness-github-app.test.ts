import { describe, expect, it } from "vitest";
import {
  assertNoLocalVerifierSecrets,
  credentialFreeBuildEnvironment,
  partitionLocalEnvironment,
} from "../../harness/src/github-app.js";

describe("local verifier credential confinement", () => {
  it("removes every verifier credential from local worker and builder environments", () => {
    const partition = partitionLocalEnvironment({
      ONE_CLI_HOME: "/private/home",
      ONE_CLI_VERIFIER_APP_ID: "12345",
      PATH: "/usr/bin:/bin",
      GH_TOKEN: "least-privilege-builder",
      OPENAI_API_KEY: "worker-provider",
      ONE_CLI_GITHUB_APP_PRIVATE_KEY_PATH: "/private/verifier.pem",
      ONE_CLI_VERIFIER_MODEL_A_API_KEY: "verifier-model-secret",
      VERIFIER_TOKEN: "installation-token",
    });

    expect(partition.rejectedVerifierSecrets).toEqual([
      "ONE_CLI_GITHUB_APP_PRIVATE_KEY_PATH",
      "ONE_CLI_VERIFIER_MODEL_A_API_KEY",
      "VERIFIER_TOKEN",
    ]);
    expect(partition.worker).toMatchObject({
      ONE_CLI_HOME: "/private/home",
      GH_TOKEN: "least-privilege-builder",
    });
    expect(partition.worker).not.toHaveProperty("ONE_CLI_GITHUB_APP_PRIVATE_KEY_PATH");
    expect(partition.worker).not.toHaveProperty("ONE_CLI_VERIFIER_APP_ID");
    expect(partition.verifierAppId).toBe("12345");
    expect(partition.builder).not.toHaveProperty("GH_TOKEN");
    expect(partition.builder).not.toHaveProperty("OPENAI_API_KEY");
    expect(partition.builder).not.toHaveProperty("ONE_CLI_HOME");
  });

  it("uses a strict credential-free npm/canary environment", () => {
    const environment = credentialFreeBuildEnvironment({
      HOME: "/tmp/builder",
      PATH: "/usr/bin:/bin",
      TMPDIR: "/tmp",
      NPM_TOKEN: "secret",
      NODE_AUTH_TOKEN: "secret",
      GH_TOKEN: "secret",
      GITHUB_TOKEN: "secret",
      OPENAI_API_KEY: "secret",
      npm_config_userconfig: "/private/npmrc",
    });
    expect(environment).toMatchObject({
      HOME: "/tmp/builder",
      PATH: "/usr/bin:/bin",
      GIT_TERMINAL_PROMPT: "0",
      NPM_CONFIG_IGNORE_SCRIPTS: "true",
    });
    for (const forbidden of [
      "NPM_TOKEN",
      "NODE_AUTH_TOKEN",
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "OPENAI_API_KEY",
      "npm_config_userconfig",
    ]) {
      expect(environment).not.toHaveProperty(forbidden);
    }
  });

  it("fails closed if verifier credentials reach local runtime composition", () => {
    expect(() => assertNoLocalVerifierSecrets({
      ONE_CLI_VERIFIER_MODEL_B_API_KEY: "secret",
    })).toThrow("forbidden");
    expect(() => assertNoLocalVerifierSecrets({ PATH: "/usr/bin" })).not.toThrow();
  });
});
