import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { MAX_TOOL_RESULT_BYTES, MAX_WRITE_BYTES } from "./config.js";

const SKIP_DIRECTORIES = new Set([".git", "node_modules", "dist", "coverage"]);

export interface FileSnapshot {
  relativePath: string;
  absolutePath: string;
  exists: boolean;
  sha256: string | null;
  content: string;
  mode: number | null;
}

export class Workspace {
  readonly root: string;
  private readonly allowedWritePaths: ReadonlySet<string> | undefined;

  constructor(root: string, options: { allowedWritePaths?: readonly string[] } = {}) {
    const canonical = fs.realpathSync(root);
    if (!fs.statSync(canonical).isDirectory()) {
      throw new Error(`Workspace is not a directory: ${root}`);
    }
    this.root = canonical;
    if (options.allowedWritePaths !== undefined) {
      if (options.allowedWritePaths.length === 0) {
        throw new Error("Workspace write-path binding must not be empty");
      }
      this.allowedWritePaths = new Set(
        options.allowedWritePaths.map((candidate) => this.lexical(candidate).relativePath),
      );
    }
  }

  private lexical(relativePath: string): { absolutePath: string; relativePath: string } {
    if (relativePath.includes("\0")) throw new Error("Path contains a NUL byte");
    if (path.isAbsolute(relativePath)) throw new Error("Absolute paths are not allowed");

    const absolutePath = path.resolve(this.root, relativePath || ".");
    const relative = path.relative(this.root, absolutePath);
    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error("Path escapes the workspace");
    }
    return {
      absolutePath,
      relativePath: relative === "" ? "." : relative.split(path.sep).join("/"),
    };
  }

  private verifyChain(absolutePath: string, allowMissingFinal: boolean): void {
    const relative = path.relative(this.root, absolutePath);
    if (!relative) return;
    const parts = relative.split(path.sep);
    let current = this.root;

    for (let index = 0; index < parts.length; index++) {
      current = path.join(current, parts[index]!);
      const final = index === parts.length - 1;
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(current);
      } catch (error) {
        if (
          allowMissingFinal &&
          final &&
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          return;
        }
        throw error;
      }
      if (stat.isSymbolicLink()) {
        throw new Error(`Symlinks are not followed: ${parts.slice(0, index + 1).join("/")}`);
      }
      if (!final && !stat.isDirectory()) {
        throw new Error(`Path parent is not a directory: ${parts.slice(0, index + 1).join("/")}`);
      }
    }

    if (fs.existsSync(absolutePath)) {
      const canonical = fs.realpathSync(absolutePath);
      const canonicalRelative = path.relative(this.root, canonical);
      if (
        canonicalRelative === ".." ||
        canonicalRelative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(canonicalRelative)
      ) {
        throw new Error("Resolved path escapes the workspace");
      }
    }
  }

  resolveExisting(relativePath: string): string {
    const resolved = this.lexical(relativePath);
    this.verifyChain(resolved.absolutePath, false);
    return resolved.absolutePath;
  }

  resolveWritable(relativePath: string): string {
    const resolved = this.lexical(relativePath);
    if (resolved.relativePath === ".") throw new Error("Workspace root is not a writable file");
    if (
      this.allowedWritePaths !== undefined &&
      !this.allowedWritePaths.has(resolved.relativePath)
    ) {
      throw new Error(`Path is outside the approved write binding: ${resolved.relativePath}`);
    }
    this.verifyChain(resolved.absolutePath, true);
    const parent = path.dirname(resolved.absolutePath);
    if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
      throw new Error("The destination parent directory must already exist");
    }
    if (fs.existsSync(resolved.absolutePath) && !fs.statSync(resolved.absolutePath).isFile()) {
      throw new Error("Only regular files can be replaced");
    }
    return resolved.absolutePath;
  }

  read(relativePath: string, offset = 0, limit?: number): string {
    const absolutePath = this.resolveExisting(relativePath);
    const stat = fs.statSync(absolutePath);
    if (!stat.isFile()) throw new Error("Only regular files can be read");
    if (stat.size > MAX_TOOL_RESULT_BYTES) {
      throw new Error(`File exceeds the ${MAX_TOOL_RESULT_BYTES}-byte read limit`);
    }
    const content = fs.readFileSync(absolutePath, "utf8");
    if (offset === 0 && limit === undefined) return content;
    const lines = content.split("\n");
    return lines.slice(offset, limit === undefined ? undefined : offset + limit).join("\n");
  }

  list(relativePath = "."): string[] {
    const absolutePath = this.resolveExisting(relativePath);
    if (!fs.statSync(absolutePath).isDirectory()) throw new Error("List target is not a directory");
    return fs
      .readdirSync(absolutePath, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => {
        const kind = entry.isSymbolicLink()
          ? "symlink"
          : entry.isDirectory()
            ? "directory"
            : entry.isFile()
              ? "file"
              : "special";
        return `${entry.name}\t${kind}`;
      });
  }

  grep(
    query: string,
    relativePath = ".",
    caseSensitive = false,
    limits: { maxMatches?: number; maxFiles?: number; deadlineMs?: number } = {},
  ): string[] {
    const root = this.resolveExisting(relativePath);
    const maxMatches = limits.maxMatches ?? 1_000;
    const maxFiles = limits.maxFiles ?? 50_000;
    const deadline = Date.now() + (limits.deadlineMs ?? 10_000);
    const needle = caseSensitive ? query : query.toLowerCase();
    const results: string[] = [];
    let files = 0;

    const visit = (absolutePath: string): void => {
      if (results.length >= maxMatches) return;
      if (Date.now() > deadline) throw new Error("Grep deadline exceeded");
      const stat = fs.lstatSync(absolutePath);
      if (stat.isSymbolicLink()) return;
      if (stat.isDirectory()) {
        for (const entry of fs.readdirSync(absolutePath, { withFileTypes: true })) {
          if (SKIP_DIRECTORIES.has(entry.name)) continue;
          if (entry.isSymbolicLink()) continue;
          visit(path.join(absolutePath, entry.name));
          if (results.length >= maxMatches) return;
        }
        return;
      }
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return;
      files++;
      if (files > maxFiles) throw new Error("Grep file limit exceeded");
      const buffer = fs.readFileSync(absolutePath);
      if (buffer.subarray(0, Math.min(buffer.length, 8_192)).includes(0)) return;
      const lines = buffer.toString("utf8").split("\n");
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index]!;
        const haystack = caseSensitive ? line : line.toLowerCase();
        if (haystack.includes(needle)) {
          const rel = path.relative(this.root, absolutePath).split(path.sep).join("/");
          results.push(`${rel}:${index + 1}:${line}`);
          if (results.length >= maxMatches) return;
        }
      }
    };

    visit(root);
    return results;
  }

  snapshot(relativePath: string): FileSnapshot {
    const absolutePath = this.resolveWritable(relativePath);
    if (!fs.existsSync(absolutePath)) {
      return {
        relativePath,
        absolutePath,
        exists: false,
        sha256: null,
        content: "",
        mode: null,
      };
    }
    const stat = fs.statSync(absolutePath);
    if (stat.size > MAX_WRITE_BYTES) {
      throw new Error(`File exceeds the ${MAX_WRITE_BYTES}-byte write/edit limit`);
    }
    const content = fs.readFileSync(absolutePath, "utf8");
    return {
      relativePath,
      absolutePath,
      exists: true,
      sha256: sha256(content),
      content,
      mode: stat.mode & 0o777,
    };
  }

  atomicWrite(snapshot: FileSnapshot, content: string): void {
    if (Buffer.byteLength(content) > MAX_WRITE_BYTES) {
      throw new Error(`Content exceeds the ${MAX_WRITE_BYTES}-byte write limit`);
    }

    const current = this.snapshot(snapshot.relativePath);
    if (current.exists !== snapshot.exists || current.sha256 !== snapshot.sha256) {
      throw new Error("Target changed after approval; request a fresh tool call");
    }

    const directory = path.dirname(snapshot.absolutePath);
    const tempPath = path.join(
      directory,
      `.${path.basename(snapshot.absolutePath)}.one-cli-${process.pid}-${crypto.randomBytes(6).toString("hex")}`,
    );
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(tempPath, "wx", snapshot.mode ?? 0o600);
      fs.writeFileSync(descriptor, content, "utf8");
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(tempPath, snapshot.absolutePath);
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // The rename succeeded or the temporary file was never created.
      }
    }
  }
}

export function sha256(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}
