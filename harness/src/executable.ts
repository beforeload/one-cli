import fs from "node:fs";
import path from "node:path";

const KNOWN_GH_PATHS = ["/opt/homebrew/bin/gh", "/usr/local/bin/gh"] as const;

export function resolveGhExecutable(
  environment: Readonly<Record<string, string | undefined>>,
  allowDiscovery: boolean,
): string {
  const configured = environment.ONE_CLI_GH_EXECUTABLE;
  if (configured) return canonicalExecutable(configured, "ONE_CLI_GH_EXECUTABLE");
  if (!allowDiscovery) {
    throw new Error(
      "ONE_CLI_GH_EXECUTABLE must name an absolute regular executable",
    );
  }
  const candidates = [
    ...pathCandidates(environment.PATH),
    ...KNOWN_GH_PATHS,
  ];
  for (const candidate of candidates) {
    try {
      return canonicalExecutable(candidate, "discovered gh");
    } catch {
      // Continue through the bounded discovery list.
    }
  }
  throw new Error("Unable to discover a canonical gh executable");
}

export function canonicalExecutable(candidate: string, label: string): string {
  if (!path.isAbsolute(candidate) || path.resolve(candidate) !== candidate) {
    throw new Error(`${label} must be an absolute normalized path`);
  }
  const canonical = fs.realpathSync(candidate);
  const target = fs.lstatSync(canonical);
  if (target.isSymbolicLink() || !target.isFile() || (target.mode & 0o111) === 0) {
    throw new Error(`${label} must resolve to a regular executable`);
  }
  return canonical;
}

function pathCandidates(value: string | undefined): string[] {
  if (!value) return [];
  const candidates: string[] = [];
  for (const directory of value.split(path.delimiter)) {
    if (!directory || !path.isAbsolute(directory)) continue;
    candidates.push(path.join(directory, "gh"));
  }
  return candidates;
}
