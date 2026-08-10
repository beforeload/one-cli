const VERIFIER_SECRET_PATTERNS = [
  /^ONE_CLI_GITHUB_APP_(?:PRIVATE_KEY|PRIVATE_KEY_PATH|TOKEN)$/u,
  /^ONE_CLI_VERIFIER_.*(?:API_KEY|PRIVATE_KEY|SECRET|TOKEN)$/u,
  /^VERIFIER_(?:APP_PRIVATE_KEY|TOKEN|MODEL_.*_API_KEY)$/u,
] as const;
const VERIFIER_ENVIRONMENT_PREFIX = /^(?:ONE_CLI_GITHUB_APP_|ONE_CLI_VERIFIER_|VERIFIER_)/u;

const BUILD_ENVIRONMENT_ALLOWLIST = new Set([
  "CI",
  "HOME",
  "LANG",
  "LC_ALL",
  "NO_COLOR",
  "PATH",
  "TMPDIR",
]);

export interface LocalEnvironmentPartition {
  readonly worker: Readonly<Record<string, string>>;
  readonly builder: Readonly<Record<string, string>>;
  readonly rejectedVerifierSecrets: readonly string[];
  readonly verifierAppId?: string;
}

/**
 * The local harness never receives or mints independent-verifier credentials.
 * This partition exists only to keep accidental verifier settings out of every
 * local subprocess and to provide a credential-free build environment.
 */
export function partitionLocalEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): LocalEnvironmentPartition {
  const worker: Record<string, string> = {};
  const rejectedVerifierSecrets: string[] = [];
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (VERIFIER_ENVIRONMENT_PREFIX.test(name)) {
      if (isVerifierSecretName(name)) rejectedVerifierSecrets.push(name);
      continue;
    }
    worker[name] = value;
  }
  const verifierAppId = source.ONE_CLI_VERIFIER_APP_ID;
  return {
    worker,
    builder: credentialFreeBuildEnvironment(worker),
    rejectedVerifierSecrets: rejectedVerifierSecrets.sort(),
    ...(verifierAppId === undefined ? {} : { verifierAppId }),
  };
}

export function credentialFreeBuildEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {
    CI: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
    NO_COLOR: "1",
    NPM_CONFIG_AUDIT: "false",
    NPM_CONFIG_FUND: "false",
    NPM_CONFIG_IGNORE_SCRIPTS: "true",
  };
  for (const name of BUILD_ENVIRONMENT_ALLOWLIST) {
    const value = source[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

export function assertNoLocalVerifierSecrets(
  environment: Readonly<Record<string, string | undefined>>,
): void {
  const names = Object.keys(environment).filter((name) =>
    environment[name] !== undefined && isVerifierSecretName(name)
  ).sort();
  if (names.length > 0) {
    throw new Error(
      `Verifier credentials are forbidden in the local harness environment: ${names.join(", ")}`,
    );
  }
}

export function isVerifierSecretName(name: string): boolean {
  return VERIFIER_SECRET_PATTERNS.some((pattern) => pattern.test(name));
}
