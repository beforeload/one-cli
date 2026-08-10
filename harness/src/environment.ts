import fs from "node:fs";
import path from "node:path";

const HOST_PASSTHROUGH = [
  "HOME",
  "PATH",
  "XDG_CONFIG_HOME",
  "GH_CONFIG_DIR",
  "GH_HOST",
  "ONE_CLI_GH_EXECUTABLE",
] as const;

const EXACT_WORKER_SECRET_NAMES = new Set([
  "GH_TOKEN",
  "GITHUB_TOKEN",
]);

export function safeEnvironment(
  oneCliHome: string,
  sourced: Readonly<Record<string, string>>,
  inherited: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const environment: Record<string, string> = {
    ONE_CLI_HOME: oneCliHome,
    NO_COLOR: "1",
  };
  for (const [name, value] of Object.entries(sourced)) {
    if (!isWorkerSecretEnvironment(name)) environment[name] = value;
  }
  for (const name of HOST_PASSTHROUGH) {
    const value = inherited[name];
    if (value !== undefined && environment[name] === undefined) environment[name] = value;
  }
  for (const name of Object.keys(environment)) {
    if (isWorkerSecretEnvironment(name)) delete environment[name];
  }
  return environment;
}

export function tokenBearingEnvironmentNames(
  ...sources: ReadonlyArray<Readonly<Record<string, string | undefined>>>
): string[] {
  return [...new Set(
    sources.flatMap((source) =>
      Object.entries(source)
        .filter(([name, value]) =>
          value !== undefined && value !== "" &&
          (name === "GH_TOKEN" || name === "GITHUB_TOKEN")
        )
        .map(([name]) => name)
    ),
  )].sort();
}

export function canonicalGhEnvironment(
  source: Readonly<Record<string, string>>,
): Record<string, string> {
  const home = canonicalDirectory(source.HOME, "HOME");
  const configured = source.GH_CONFIG_DIR ??
    (source.XDG_CONFIG_HOME === undefined
      ? path.join(home, ".config", "gh")
      : path.join(source.XDG_CONFIG_HOME, "gh"));
  const configDirectory = canonicalDirectory(configured, "gh config directory");
  return {
    NO_COLOR: "1",
    GH_PROMPT_DISABLED: "1",
    HOME: home,
    GH_CONFIG_DIR: configDirectory,
    ...(source.GH_HOST === undefined ? {} : { GH_HOST: source.GH_HOST }),
    ...(source.PATH === undefined ? {} : { PATH: source.PATH }),
  };
}

export function isWorkerSecretEnvironment(name: string): boolean {
  const upper = name.toUpperCase();
  return EXACT_WORKER_SECRET_NAMES.has(upper) ||
    upper.startsWith("ONE_CLI_VERIFIER_") ||
    upper.includes("_APP_") ||
    /(?:^|_)APP_(?:ID|KEY|TOKEN)$/u.test(upper) ||
    upper.includes("APP_PRIVATE_KEY") ||
    upper.includes("GITHUB_APP_PRIVATE") ||
    upper.endsWith("_PRIVATE_KEY") ||
    upper === "PRIVATE_KEY";
}

function canonicalDirectory(value: string | undefined, label: string): string {
  if (value === undefined || !path.isAbsolute(value) || !fs.existsSync(value)) {
    throw new Error(`${label} must be an existing absolute directory`);
  }
  const stat = fs.lstatSync(value);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} must be a canonical directory`);
  }
  const canonical = fs.realpathSync(value);
  if (canonical !== value) throw new Error(`${label} must be canonical`);
  return canonical;
}
