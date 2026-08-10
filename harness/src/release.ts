import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SHA = /^[0-9a-f]{40,64}$/u;

export interface HarnessRelease {
  entrypoint: string;
  root: string;
  sha: string | null;
  bootstrap: boolean;
  manifestSha256: string | null;
  files: readonly HarnessReleaseFile[];
}

export interface HarnessReleaseFile {
  path: string;
  bytes: number;
  sha256: string;
  executable: boolean;
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
  if (state.version !== 1 || !nonNegativeInteger(generation)) {
    throw new Error("Release state metadata is invalid");
  }
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
  const manifest = parseManifest(
    readJson(path.join(canonicalRelease, "manifest.json"), 16 * 1024 * 1024, "manifest"),
    active,
  );
  const manifestBody = {
    version: manifest.version,
    commitSha: manifest.commitSha,
    totalBytes: manifest.totalBytes,
    files: manifest.files,
  };
  if (sha256(Buffer.from(stableJson(manifestBody))) !== manifest.manifestSha256) {
    throw new Error("Active release manifest hash is invalid");
  }
  const actualFiles = listPayloadFiles(canonicalRelease, 50_000);
  if (
    actualFiles.length !== manifest.files.length ||
    actualFiles.some((value, index) => value !== manifest.files[index]?.path)
  ) {
    throw new Error("Active release contents do not match its immutable manifest");
  }
  let totalBytes = 0;
  for (const expected of manifest.files) {
    const absolute = path.join(canonicalRelease, ...expected.path.split("/"));
    const descriptor = openRegularNoFollow(absolute, `manifest file ${expected.path}`);
    try {
      const stat = fs.fstatSync(descriptor);
      if (
        stat.size !== expected.bytes ||
        ((stat.mode & 0o111) !== 0) !== expected.executable ||
        hashDescriptor(descriptor) !== expected.sha256
      ) {
        throw new Error(`Active release file differs from manifest: ${expected.path}`);
      }
      totalBytes += stat.size;
    } finally {
      fs.closeSync(descriptor);
    }
  }
  if (totalBytes !== manifest.totalBytes) {
    throw new Error("Active release byte total differs from its immutable manifest");
  }
  const entry = manifest.files.find((value) => value.path === "dist/index.js");
  if (!entry) {
    throw new Error("Active release manifest lacks dist/index.js");
  }
  const dist = canonicalDirectory(path.join(canonicalRelease, "dist"), "active release dist");
  assertWithin(canonicalRelease, dist, "Active release dist");
  const entrypoint = path.join(dist, "index.js");
  return {
    entrypoint,
    root: canonicalRelease,
    sha: active,
    bootstrap: false,
    manifestSha256: manifest.manifestSha256,
    files: manifest.files,
  };
}

function bootstrapRelease(workspace: string): HarnessRelease {
  const root = canonicalDirectory(workspace, "bootstrap workspace");
  const dist = canonicalDirectory(path.join(root, "dist"), "bootstrap dist");
  const entrypoint = path.join(dist, "index.js");
  const descriptor = openRegularNoFollow(entrypoint, "bootstrap entrypoint");
  fs.closeSync(descriptor);
  assertWithin(root, entrypoint, "Bootstrap entrypoint");
  return {
    entrypoint,
    root,
    sha: null,
    bootstrap: true,
    manifestSha256: null,
    files: [],
  };
}

interface ParsedManifest {
  version: 1;
  commitSha: string;
  totalBytes: number;
  files: readonly HarnessReleaseFile[];
  manifestSha256: string;
}

function parseManifest(value: Record<string, unknown>, expectedSha: string): ParsedManifest {
  if (
    value.version !== 1 ||
    value.commitSha !== expectedSha ||
    !nonNegativeInteger(value.totalBytes) ||
    typeof value.manifestSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.manifestSha256) ||
    !Array.isArray(value.files)
  ) {
    throw new Error("Active release manifest is not bound to its SHA");
  }
  const files: HarnessReleaseFile[] = [];
  let prior = "";
  for (const candidate of value.files) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error("Active release manifest file entry is invalid");
    }
    const file = candidate as Record<string, unknown>;
    if (
      typeof file.path !== "string" ||
      !safeRelativePath(file.path) ||
      !nonNegativeInteger(file.bytes) ||
      typeof file.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/u.test(file.sha256) ||
      typeof file.executable !== "boolean" ||
      (prior !== "" && prior.localeCompare(file.path) >= 0)
    ) {
      throw new Error("Active release manifest file entry is invalid");
    }
    files.push({
      path: file.path,
      bytes: file.bytes,
      sha256: file.sha256,
      executable: file.executable,
    });
    prior = file.path;
  }
  return {
    version: 1,
    commitSha: expectedSha,
    totalBytes: value.totalBytes,
    files,
    manifestSha256: value.manifestSha256,
  };
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

function hashDescriptor(descriptor: number): string {
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  for (;;) {
    const read = fs.readSync(descriptor, buffer, 0, buffer.length, position);
    if (read === 0) break;
    hash.update(buffer.subarray(0, read));
    position += read;
  }
  return hash.digest("hex");
}

function listPayloadFiles(root: string, maxFiles: number): string[] {
  const files: string[] = [];
  const visit = (directory: string, prefix: string): void => {
    if (fs.realpathSync(directory) !== directory) {
      throw new Error("Active release contains a non-canonical directory");
    }
    assertWithin(root, directory, "Active release content");
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name)
    )) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error(`Active release contains a symlink: ${relative}`);
      if (stat.isDirectory()) visit(absolute, relative);
      else if (stat.isFile()) {
        if (relative !== "manifest.json") {
          files.push(relative);
          if (files.length > maxFiles) throw new Error("Active release file inventory is too large");
        }
      } else {
        throw new Error(`Active release contains a non-regular entry: ${relative}`);
      }
    }
  };
  visit(root, "");
  return files.sort((left, right) => left.localeCompare(right));
}

function safeRelativePath(value: string): boolean {
  if (
    value.length === 0 ||
    value.includes("\0") ||
    value.includes("\\") ||
    path.posix.isAbsolute(value)
  ) {
    return false;
  }
  const normalized = path.posix.normalize(value);
  return normalized === value && value !== "." && !value.startsWith("../");
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sha256(value: Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function assertWithin(root: string, candidate: string, label: string): void {
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes its trusted root`);
  }
}
