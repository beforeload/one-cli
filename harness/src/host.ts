import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface HarnessPaths {
  oneCliHome: string;
  stateRoot: string;
  journal: string;
  seedOperations: string;
  lock: string;
  envFile: string;
  launchAgent: string;
}

export interface JournalEvent {
  seq: number;
  at: string;
  type: string;
  data: Readonly<Record<string, unknown>>;
}

export class HostJournal {
  private sequence: number;
  private readonly secrets: readonly string[];

  constructor(readonly filePath: string, secrets: readonly string[] = []) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    this.sequence = this.read().at(-1)?.seq ?? 0;
    this.secrets = [...new Set(secrets.filter(Boolean))]
      .sort((left, right) => right.length - left.length);
  }

  append(type: string, data: Readonly<Record<string, unknown>> = {}): JournalEvent {
    if (!/^[a-z0-9][a-z0-9.-]*$/u.test(type)) throw new Error("Journal event type is invalid");
    const event: JournalEvent = {
      seq: ++this.sequence,
      at: new Date().toISOString(),
      type,
      data: redactRecord(data, this.secrets),
    };
    const descriptor = fs.openSync(this.filePath, "a", 0o600);
    try {
      fs.writeSync(descriptor, `${JSON.stringify(event)}\n`);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    const directory = fs.openSync(path.dirname(this.filePath), "r");
    try {
      fs.fsyncSync(directory);
    } finally {
      fs.closeSync(directory);
    }
    return event;
  }

  read(limit = 1_000): JournalEvent[] {
    if (!fs.existsSync(this.filePath)) return [];
    const stat = fs.lstatSync(this.filePath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 16 * 1024 * 1024) {
      throw new Error("Harness journal is not a bounded regular file");
    }
    const lines = fs.readFileSync(this.filePath, "utf8").split("\n").filter(Boolean);
    const events = lines.map((line, index) => {
      try {
        const value = JSON.parse(line) as JournalEvent;
        if (
          !Number.isSafeInteger(value.seq) ||
          value.seq !== index + 1 ||
          typeof value.at !== "string" ||
          typeof value.type !== "string" ||
          !value.data ||
          typeof value.data !== "object" ||
          Array.isArray(value.data)
        ) {
          throw new Error("shape");
        }
        return value;
      } catch {
        throw new Error(`Harness journal is corrupt at line ${index + 1}`);
      }
    });
    return events.slice(-limit);
  }
}

export interface HarnessLock {
  token: string;
  recovered: boolean;
  release(): void;
}

export function acquireHarnessLock(filePath: string): HarnessLock {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try {
    return createLock(filePath, false);
  } catch (error) {
    if (!isExists(error)) throw error;
    const existing = readLock(filePath);
    if (existing && processAlive(existing.pid)) {
      throw new Error(`Harness already runs as PID ${existing.pid}`);
    }
    throw new Error(
      "Harness lock is stale or invalid; automatic reclaim is disabled to prevent split ownership",
    );
  }
}

export function resolveHarnessPaths(env: NodeJS.ProcessEnv = process.env): HarnessPaths {
  const oneCliHome = path.resolve(env.ONE_CLI_HOME ?? path.join(os.homedir(), ".one-cli"));
  if (fs.existsSync(oneCliHome)) {
    const homeStat = fs.lstatSync(oneCliHome);
    if (homeStat.isSymbolicLink() || !homeStat.isDirectory()) {
      throw new Error("ONE_CLI_HOME must be a real directory");
    }
    if (fs.realpathSync(oneCliHome) !== oneCliHome) {
      throw new Error("ONE_CLI_HOME must be canonical");
    }
  }
  const stateRoot = path.join(oneCliHome, "harness");
  if (fs.existsSync(stateRoot)) {
    const stateStat = fs.lstatSync(stateRoot);
    if (stateStat.isSymbolicLink() || !stateStat.isDirectory()) {
      throw new Error("Harness state root must be a real directory");
    }
    if (fs.realpathSync(stateRoot) !== stateRoot) {
      throw new Error("Harness state root must be canonical");
    }
  }
  const envFile = path.resolve(
    env.ONE_CLI_HARNESS_ENV_FILE ?? path.join(oneCliHome, "harness.env"),
  );
  if (!within(oneCliHome, envFile)) {
    throw new Error("Harness environment file must remain under ONE_CLI_HOME");
  }
  return {
    oneCliHome,
    stateRoot,
    journal: path.join(stateRoot, "journal.jsonl"),
    seedOperations: path.join(stateRoot, "seed-operations.jsonl"),
    lock: path.join(stateRoot, "run.lock"),
    envFile,
    launchAgent: path.join(os.homedir(), "Library", "LaunchAgents", "com.beforeload.one-cli-harness.plist"),
  };
}

export function loadHostEnvironment(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 64 * 1024) {
    throw new Error("Host environment must be a bounded regular file");
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error("Host environment file must not be group/world accessible");
  }
  const result: Record<string, string> = {};
  for (const [index, raw] of fs.readFileSync(filePath, "utf8").split(/\r?\n/u).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line);
    if (!match) throw new Error(`Invalid host environment line ${index + 1}`);
    const value = parseEnvValue(match[2]!, index + 1);
    result[match[1]!] = value;
  }
  return result;
}

function createLock(filePath: string, recovered: boolean): HarnessLock {
  const token = crypto.randomBytes(16).toString("hex");
  const descriptor = fs.openSync(filePath, "wx", 0o600);
  try {
    fs.writeFileSync(
      descriptor,
      `${JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() })}\n`,
    );
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  return {
    token,
    recovered,
    release(): void {
      const current = readLock(filePath);
      if (!current || current.token !== token || current.pid !== process.pid) {
        throw new Error("Refusing to release a lock owned by another process");
      }
      fs.unlinkSync(filePath);
    },
  };
}

function readLock(filePath: string): { pid: number; token: string } | undefined {
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 4_096) return undefined;
    const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
    return typeof value.pid === "number" &&
      Number.isSafeInteger(value.pid) &&
      value.pid > 0 &&
      typeof value.token === "string"
      ? { pid: value.pid, token: value.token }
      : undefined;
  } catch {
    return undefined;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

function parseEnvValue(raw: string, line: number): string {
  const value = raw.trim();
  if (
    /[`$]\(/u.test(value) ||
    value.includes("\0") ||
    value.includes("\n") ||
    value.includes("\r")
  ) {
    throw new Error(`Unsafe host environment value at line ${line}`);
  }
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  if (/[\s;&|<>]/u.test(value)) throw new Error(`Unquoted unsafe environment value at line ${line}`);
  return value;
}

function isExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

function redactRecord(
  value: Readonly<Record<string, unknown>>,
  secrets: readonly string[],
): Readonly<Record<string, unknown>> {
  return JSON.parse(JSON.stringify(value, (_key, nested) => {
    if (typeof nested !== "string") return nested;
    let redacted = nested;
    for (const secret of secrets) redacted = redacted.replaceAll(secret, "[REDACTED]");
    return redacted;
  })) as Readonly<Record<string, unknown>>;
}
