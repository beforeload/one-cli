import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SHA = /^[0-9a-f]{40,64}$/u;

export interface HarnessRelease {
  entrypoint: string;
  sha: string | null;
  bootstrap: boolean;
}

export function resolveHarnessRelease(
  oneCliHome: string,
  workspace: string,
  repoKey: string,
): HarnessRelease {
  if (!/^[a-z0-9._-]+-[0-9a-f]{12}$/u.test(repoKey)) {
    throw new Error("Repository key is invalid");
  }
  const home = canonicalDirectory(oneCliHome, "ONE_CLI_HOME");
  const autonomy = path.join(home, "autonomy");
  const repositoryState = path.join(autonomy, repoKey);
  const releases = path.join(repositoryState, "releases");
  const statePath = path.join(releases, "state.json");
  if (!fs.existsSync(statePath)) {
    if (fs.existsSync(releases)) {
      const releasesRoot = canonicalDirectory(releases, "releases directory");
      assertWithin(home, releasesRoot, "Releases directory");
      if (fs.readdirSync(releasesRoot).some((entry) => SHA.test(entry))) {
        throw new Error("Release state is missing after immutable releases were created");
      }
    }
    return bootstrapRelease(workspace);
  }
  const autonomyRoot = canonicalDirectory(autonomy, "autonomy state root");
  assertWithin(home, autonomyRoot, "Autonomy state root");
  if (autonomyRoot !== autonomy) throw new Error("Autonomy state root is not canonical");
  const canonicalRepositoryState = canonicalDirectory(repositoryState, "repository state root");
  assertWithin(autonomyRoot, canonicalRepositoryState, "Repository state root");
  if (canonicalRepositoryState !== repositoryState) {
    throw new Error("Repository state root is not canonical");
  }
  const state = readJson(statePath, 1024 * 1024, "release state");
  const active = state.active;
  const generation = state.generation;
  if (active === null) {
    if (generation === 0) return bootstrapRelease(workspace);
    throw new Error("Active release is absent after release management started");
  }
  if (typeof active !== "string" || !SHA.test(active)) {
    throw new Error("Active release SHA is invalid");
  }
  const releasesRoot = canonicalDirectory(releases, "releases directory");
  assertWithin(canonicalRepositoryState, releasesRoot, "Releases directory");
  if (releasesRoot !== releases) throw new Error("Releases directory is not canonical");
  const releasePath = path.join(releasesRoot, active);
  const canonicalRelease = canonicalDirectory(releasePath, "active release");
  assertWithin(releasesRoot, canonicalRelease, "Active release");
  if (canonicalRelease !== releasePath) throw new Error("Active release path is not canonical");
  const manifest = readJson(path.join(canonicalRelease, "manifest.json"), 16 * 1024 * 1024, "manifest");
  if (manifest.commitSha !== active || !Array.isArray(manifest.files)) {
    throw new Error("Active release manifest is not bound to its SHA");
  }
  const entry = manifest.files.find((value) =>
    value && typeof value === "object" && !Array.isArray(value) &&
    (value as Record<string, unknown>).path === "dist/index.js"
  ) as Record<string, unknown> | undefined;
  if (!entry || typeof entry.sha256 !== "string") {
    throw new Error("Active release manifest lacks dist/index.js");
  }
  const dist = canonicalDirectory(path.join(canonicalRelease, "dist"), "active release dist");
  assertWithin(canonicalRelease, dist, "Active release dist");
  const entrypoint = path.join(dist, "index.js");
  const descriptor = openRegularNoFollow(entrypoint, "active release entrypoint");
  try {
    const bytes = fs.readFileSync(descriptor);
    if (crypto.createHash("sha256").update(bytes).digest("hex") !== entry.sha256) {
      throw new Error("Active release entrypoint does not match its immutable manifest");
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return { entrypoint, sha: active, bootstrap: false };
}

function bootstrapRelease(workspace: string): HarnessRelease {
  const root = canonicalDirectory(workspace, "bootstrap workspace");
  const dist = canonicalDirectory(path.join(root, "dist"), "bootstrap dist");
  const entrypoint = path.join(dist, "index.js");
  const descriptor = openRegularNoFollow(entrypoint, "bootstrap entrypoint");
  fs.closeSync(descriptor);
  assertWithin(root, entrypoint, "Bootstrap entrypoint");
  return { entrypoint, sha: null, bootstrap: true };
}

function canonicalDirectory(candidate: string, label: string): string {
  const before = fs.lstatSync(candidate);
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw new Error(`${label} must be a real directory`);
  }
  const canonical = fs.realpathSync(candidate);
  if (canonical !== path.resolve(candidate)) throw new Error(`${label} path is not canonical`);
  return canonical;
}

function readJson(
  filePath: string,
  maxBytes: number,
  label: string,
): Record<string, unknown> {
  const descriptor = openRegularNoFollow(filePath, label, maxBytes);
  try {
    const value = JSON.parse(fs.readFileSync(descriptor, "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${label} must be an object`);
    }
    return value as Record<string, unknown>;
  } finally {
    fs.closeSync(descriptor);
  }
}

function openRegularNoFollow(filePath: string, label: string, maxBytes = 512 * 1024 * 1024): number {
  const before = fs.lstatSync(filePath);
  if (before.isSymbolicLink() || !before.isFile() || before.size > maxBytes) {
    throw new Error(`${label} must be a bounded regular file`);
  }
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const opened = fs.fstatSync(descriptor);
  if (
    !opened.isFile() ||
    opened.dev !== before.dev ||
    opened.ino !== before.ino ||
    opened.size !== before.size
  ) {
    fs.closeSync(descriptor);
    throw new Error(`${label} changed while opening`);
  }
  return descriptor;
}

function assertWithin(root: string, candidate: string, label: string): void {
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes its trusted root`);
  }
}
