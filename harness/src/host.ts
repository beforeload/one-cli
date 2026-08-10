import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface HarnessPaths {
  oneCliHome: string;
  stateRoot: string;
  journal: string;
  seedOperations: string;
  recoveryKey: string;
  lock: string;
  envFile: string;
  launchAgent: string;
}

export interface JournalEvent {
  seq: number;
  at: string;
  type: string;
  data: Readonly<Record<string, unknown>>;
  prevHash?: string;
  hash?: string;
}

const MAX_JOURNAL_SEGMENT_BYTES = 16 * 1024 * 1024;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const LOCK_TOKEN_PATTERN = /^[0-9a-f]{32}$/u;

export class HostStateCorruptionError extends Error {
  override readonly name = "HostStateCorruptionError";
}

export class HostJournal {
  private sequence: number;
  private chainHead: string;
  private readonly secrets: readonly string[];
  private readonly maxSegmentBytes: number;

  constructor(
    readonly filePath: string,
    secrets: readonly string[] = [],
    options: {
      maxSegmentBytes?: number;
      onLegacyMigrationStep?: (step: string) => void;
    } = {},
  ) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    this.secrets = [...new Set(secrets.filter(Boolean))]
      .sort((left, right) => right.length - left.length);
    this.maxSegmentBytes = options.maxSegmentBytes ?? MAX_JOURNAL_SEGMENT_BYTES;
    if (!Number.isSafeInteger(this.maxSegmentBytes) || this.maxSegmentBytes < 256) {
      throw new Error("Harness journal segment limit is invalid");
    }
    migrateOversizedLegacyJournal(
      this.filePath,
      this.maxSegmentBytes,
      options.onLegacyMigrationStep,
    );
    const scan = this.scan(1);
    this.sequence = scan.events.at(-1)?.seq ?? 0;
    this.chainHead = scan.chainHead;
  }

  append(type: string, data: Readonly<Record<string, unknown>> = {}): JournalEvent {
    if (!/^[a-z0-9][a-z0-9.-]*$/u.test(type)) throw new Error("Journal event type is invalid");
    const core = {
      seq: this.sequence + 1,
      at: new Date().toISOString(),
      type,
      data: redactRecord(data, this.secrets),
      prevHash: this.chainHead,
    };
    const event: JournalEvent = {
      ...core,
      hash: hashValue(core),
    };
    const bytes = Buffer.from(`${JSON.stringify(event)}\n`);
    if (bytes.byteLength > this.maxSegmentBytes) {
      throw new Error("Harness journal event exceeds the segment limit");
    }
    const active = regularFileStat(this.filePath, this.maxSegmentBytes, true);
    if (active && active.size > 0 && active.size + bytes.byteLength > this.maxSegmentBytes) {
      this.rollover();
    }
    const before = regularFileStat(this.filePath, this.maxSegmentBytes, true);
    const descriptor = fs.openSync(
      this.filePath,
      fs.constants.O_APPEND |
        fs.constants.O_CREAT |
        fs.constants.O_WRONLY |
        noFollowFlag(),
      0o600,
    );
    try {
      const opened = fs.fstatSync(descriptor);
      if (!opened.isFile() || (before && !sameInode(before, opened))) {
        throw new Error("Harness journal changed while opening it");
      }
      if (fs.writeSync(descriptor, bytes) !== bytes.byteLength) {
        throw new Error("Harness journal append was incomplete");
      }
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fsyncDirectory(path.dirname(this.filePath));
    this.sequence = event.seq;
    this.chainHead = event.hash!;
    return event;
  }

  read(limit = 1_000): JournalEvent[] {
    if (!Number.isSafeInteger(limit) || limit < 0) {
      throw new Error("Harness journal read limit is invalid");
    }
    return this.scan(limit).events;
  }

  private rollover(): void {
    const activeEvents = readJournalFile(this.filePath);
    const first = activeEvents[0]?.seq;
    const last = activeEvents.at(-1)?.seq;
    if (!first || !last || last !== this.sequence) {
      throw new Error("Harness journal cannot roll an invalid active segment");
    }
    const destination = segmentPath(this.filePath, first, last);
    if (fs.existsSync(destination)) throw new Error("Harness journal segment already exists");
    fs.renameSync(this.filePath, destination);
    fsyncDirectory(path.dirname(this.filePath));
  }

  private scan(limit: number): { events: JournalEvent[]; chainHead: string } {
    try {
      return this.scanVerified(limit);
    } catch (error) {
      if (error instanceof HostStateCorruptionError) throw error;
      throw new HostStateCorruptionError(
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    }
  }

  private scanVerified(limit: number): { events: JournalEvent[]; chainHead: string } {
    const files = journalFiles(this.filePath);
    const events: JournalEvent[] = [];
    let expectedSequence = 1;
    let chainHead = "0".repeat(64);
    let hashed = false;
    for (const file of files) {
      regularFileStat(file.filePath, this.maxSegmentBytes, false);
      const segmentEvents = readJournalFile(file.filePath);
      if (file.range) {
        if (
          segmentEvents[0]?.seq !== file.range.start ||
          segmentEvents.at(-1)?.seq !== file.range.end
        ) {
          throw new Error(`Harness journal segment range is corrupt: ${path.basename(file.filePath)}`);
        }
      }
      for (const event of segmentEvents) {
        if (!validJournalEvent(event) || event.seq !== expectedSequence) {
          throw new Error(`Harness journal is corrupt at sequence ${expectedSequence}`);
        }
        const hasHash = event.hash !== undefined || event.prevHash !== undefined;
        if (hasHash) {
          if (
            !HASH_PATTERN.test(event.prevHash ?? "") ||
            !HASH_PATTERN.test(event.hash ?? "") ||
            event.prevHash !== chainHead ||
            event.hash !== hashValue({
              seq: event.seq,
              at: event.at,
              type: event.type,
              data: event.data,
              prevHash: event.prevHash,
            })
          ) {
            throw new Error(`Harness journal hash chain is corrupt at sequence ${event.seq}`);
          }
          hashed = true;
          chainHead = event.hash;
        } else {
          if (hashed) {
            throw new Error(`Harness journal hash chain is missing at sequence ${event.seq}`);
          }
          chainHead = hashValue({
            seq: event.seq,
            at: event.at,
            type: event.type,
            data: event.data,
            prevHash: chainHead,
          });
        }
        events.push(event);
        if (events.length > limit) events.splice(0, events.length - limit);
        expectedSequence++;
      }
    }
    return { events, chainHead };
  }
}

export interface HarnessLock {
  token: string;
  recovered: boolean;
  release(): void;
}

export function acquireHarnessLock(filePath: string): HarnessLock {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const mutex = acquireReclaimMutex(`${filePath}.reclaim`);
  try {
    const existing = readLock(filePath);
    if (!existing) return createLock(filePath, false);
    if (processAlive(existing.pid)) {
      throw new Error(`Harness already runs as PID ${existing.pid}`);
    }
    const revalidated = readLock(filePath);
    if (!revalidated || !sameLock(existing, revalidated)) {
      throw new Error("Harness lock identity changed during stale recovery");
    }
    fs.unlinkSync(filePath);
    fsyncDirectory(path.dirname(filePath));
    return createLock(filePath, true);
  } finally {
    mutex.release();
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
    recoveryKey: path.join(stateRoot, "recovery.key"),
    lock: path.join(stateRoot, "run.lock"),
    envFile,
    launchAgent: path.join(os.homedir(), "Library", "LaunchAgents", "com.beforeload.one-cli-harness.plist"),
  };
}

export function loadOrCreateRecoveryKey(filePath: string): Buffer {
  const expected = path.resolve(filePath);
  const directory = path.dirname(expected);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  if (fs.realpathSync(directory) !== directory) {
    throw new Error("Harness recovery key directory must be canonical");
  }
  if (fs.existsSync(expected)) return readRecoveryKey(expected);
  const temporary = path.join(
    directory,
    `.recovery.key.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_WRONLY |
        noFollowFlag(),
      0o600,
    );
    const key = crypto.randomBytes(32);
    if (fs.writeSync(descriptor, key) !== key.byteLength) {
      throw new Error("Harness recovery key write was incomplete");
    }
    fs.fsyncSync(descriptor);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size !== 32 || (stat.mode & 0o777) !== 0o600) {
      throw new Error("Harness recovery key was not created as a 0600 regular file");
    }
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.linkSync(temporary, expected);
    fs.unlinkSync(temporary);
    fsyncDirectory(directory);
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(temporary);
    } catch (cleanupError) {
      if (!isCode(cleanupError, "ENOENT")) throw cleanupError;
    }
    if (!isExists(error)) throw error;
  }
  return readRecoveryKey(expected);
}

function readRecoveryKey(filePath: string): Buffer {
  const expected = path.resolve(filePath);
  const before = fs.lstatSync(expected);
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    before.size !== 32 ||
    (before.mode & 0o777) !== 0o600 ||
    fs.realpathSync(expected) !== expected
  ) {
    throw new Error("Harness recovery key must be a canonical 0600 regular 32-byte file");
  }
  const descriptor = fs.openSync(expected, fs.constants.O_RDONLY | noFollowFlag());
  try {
    const opened = fs.fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.size !== 32 ||
      (opened.mode & 0o777) !== 0o600 ||
      !sameInode(before, opened)
    ) {
      throw new Error("Harness recovery key changed while being opened");
    }
    return fs.readFileSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
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
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      fs.constants.O_WRONLY |
      noFollowFlag(),
    0o600,
  );
  let inode: Pick<fs.Stats, "dev" | "ino">;
  try {
    fs.writeFileSync(
      descriptor,
      `${JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() })}\n`,
    );
    fs.fsyncSync(descriptor);
    inode = fs.fstatSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fsyncDirectory(path.dirname(filePath));
  return {
    token,
    recovered,
    release(): void {
      const current = readLock(filePath);
      if (
        !current ||
        current.token !== token ||
        current.pid !== process.pid ||
        !sameInode(current, inode)
      ) {
        throw new Error("Refusing to release a lock owned by another process");
      }
      fs.unlinkSync(filePath);
      fsyncDirectory(path.dirname(filePath));
    },
  };
}

interface LockSnapshot {
  pid: number;
  token: string;
  startedAt: string;
  dev: number;
  ino: number;
}

function readLock(filePath: string): LockSnapshot | undefined {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollowFlag());
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 4_096) throw new Error("shape");
    const value = JSON.parse(fs.readFileSync(descriptor, "utf8")) as Record<string, unknown>;
    if (
      typeof value.pid === "number" &&
      Number.isSafeInteger(value.pid) &&
      value.pid > 0 &&
      typeof value.token === "string" &&
      LOCK_TOKEN_PATTERN.test(value.token) &&
      typeof value.startedAt === "string" &&
      Number.isFinite(Date.parse(value.startedAt))
    ) {
      return {
        pid: value.pid,
        token: value.token,
        startedAt: value.startedAt,
        dev: stat.dev,
        ino: stat.ino,
      };
    }
    throw new Error("shape");
  } catch (error) {
    if (isCode(error, "ENOENT")) return undefined;
    throw new Error(
      "Harness lock is stale or invalid; automatic reclaim is disabled to prevent split ownership",
    );
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function acquireReclaimMutex(filePath: string): { release(): void } {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const lock = createLock(filePath, false);
      return { release: lock.release };
    } catch (error) {
      if (!isExists(error)) throw error;
      const existing = readLock(filePath);
      if (!existing) continue;
      if (processAlive(existing.pid)) {
        throw new Error(`Harness lock reclaim is already in progress by PID ${existing.pid}`);
      }
      const revalidated = readLock(filePath);
      if (!revalidated || !sameLock(existing, revalidated)) {
        throw new Error("Harness reclaim mutex identity changed during recovery");
      }
      const tombstone = `${filePath}.stale-${crypto.randomBytes(8).toString("hex")}`;
      try {
        fs.renameSync(filePath, tombstone);
      } catch (renameError) {
        if (isCode(renameError, "ENOENT")) continue;
        throw renameError;
      }
      const moved = readLock(tombstone);
      if (!moved || !sameLock(existing, moved)) {
        throw new Error("Harness reclaim mutex changed during atomic recovery");
      }
      fs.unlinkSync(tombstone);
      fsyncDirectory(path.dirname(filePath));
    }
  }
  throw new Error("Harness reclaim mutex remained contended");
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

interface MigratedSegment {
  temporary: string;
  destination: string;
  start: number;
  end: number;
  size: number;
  sha256: string;
}

interface LegacyJournalMigrationManifest {
  schema: "one-cli.harness/legacy-journal-migration-v1";
  source: {
    size: number;
    sha256: string;
  };
  backup: string;
  segments: MigratedSegment[];
}

function migrateOversizedLegacyJournal(
  filePath: string,
  maxBytes: number,
  onStep?: (step: string) => void,
): void {
  if (reconcileLegacyJournalMigration(filePath, maxBytes, onStep)) return;
  let before: fs.Stats;
  try {
    before = fs.lstatSync(filePath);
  } catch (error) {
    if (isCode(error, "ENOENT")) return;
    throw error;
  }
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new HostStateCorruptionError("Harness journal is not a regular file");
  }
  if (before.size <= maxBytes) return;
  const directory = path.dirname(filePath);
  const basename = path.basename(filePath);
  if (fs.readdirSync(directory).some((name) => name.startsWith(`${basename}.segment-`))) {
    throw new HostStateCorruptionError(
      "Oversized active journal cannot be migrated after segmented history exists",
    );
  }
  cleanupAbandonedMigrationPlanning(directory, basename);
  const token = crypto.randomBytes(12).toString("hex");
  const backup = `${basename}.legacy-${token}`;
  const segments: MigratedSegment[] = [];
  let manifestDurable = false;
  let input: number | undefined;
  let output: number | undefined;
  let outputPath = "";
  let outputBytes = 0;
  let outputStart = 0;
  let outputEnd = 0;
  let outputHash: crypto.Hash | undefined;
  let expectedSequence = 1;
  let chainHead = "0".repeat(64);
  const sourceHash = crypto.createHash("sha256");

  const closeOutput = (): void => {
    if (output === undefined) return;
    fs.fsyncSync(output);
    const stat = fs.fstatSync(output);
    if (!stat.isFile() || stat.size !== outputBytes || stat.size > maxBytes) {
      throw new HostStateCorruptionError("Legacy journal migration segment is invalid");
    }
    fs.closeSync(output);
    output = undefined;
    segments.push({
      temporary: path.basename(outputPath),
      destination: "",
      start: outputStart,
      end: outputEnd,
      size: outputBytes,
      sha256: outputHash!.digest("hex"),
    });
    outputPath = "";
    outputBytes = 0;
    outputHash = undefined;
  };
  const openOutput = (sequence: number): void => {
    outputPath = path.join(directory, `.${basename}.migration-${token}-${segments.length}`);
    output = fs.openSync(
      outputPath,
      fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_WRONLY |
        noFollowFlag(),
      0o600,
    );
    outputStart = sequence;
    outputEnd = sequence;
    outputHash = crypto.createHash("sha256");
  };
  const migrateLine = (line: Buffer): void => {
    if (line.byteLength === 0) return;
    if (line.byteLength > maxBytes) {
      throw new HostStateCorruptionError("Legacy journal event exceeds the segment limit");
    }
    let legacy: JournalEvent;
    try {
      legacy = JSON.parse(line.toString("utf8")) as JournalEvent;
    } catch {
      throw new HostStateCorruptionError(
        `Harness legacy journal is corrupt at sequence ${expectedSequence}`,
      );
    }
    if (
      !validJournalEvent(legacy) ||
      legacy.seq !== expectedSequence ||
      legacy.hash !== undefined ||
      legacy.prevHash !== undefined
    ) {
      throw new HostStateCorruptionError(
        `Harness oversized legacy journal is invalid at sequence ${expectedSequence}`,
      );
    }
    const core = {
      seq: legacy.seq,
      at: legacy.at,
      type: legacy.type,
      data: legacy.data,
      prevHash: chainHead,
    };
    const migrated: JournalEvent = { ...core, hash: hashValue(core) };
    const bytes = Buffer.from(`${JSON.stringify(migrated)}\n`);
    if (bytes.byteLength > maxBytes) {
      throw new HostStateCorruptionError("Migrated journal event exceeds the segment limit");
    }
    if (output !== undefined && outputBytes + bytes.byteLength > maxBytes) closeOutput();
    if (output === undefined) openOutput(legacy.seq);
    if (fs.writeSync(output!, bytes) !== bytes.byteLength) {
      throw new Error("Legacy journal migration write was incomplete");
    }
    outputHash!.update(bytes);
    outputBytes += bytes.byteLength;
    outputEnd = legacy.seq;
    chainHead = migrated.hash!;
    expectedSequence++;
  };

  try {
    input = fs.openSync(filePath, fs.constants.O_RDONLY | noFollowFlag());
    const opened = fs.fstatSync(input);
    if (!sameInode(before, opened) || opened.size !== before.size) {
      throw new HostStateCorruptionError("Harness journal changed before legacy migration");
    }
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let pending = Buffer.alloc(0);
    for (;;) {
      const count = fs.readSync(input, chunk, 0, chunk.byteLength, null);
      if (count === 0) break;
      sourceHash.update(chunk.subarray(0, count));
      pending = Buffer.concat([pending, chunk.subarray(0, count)]);
      let newline: number;
      while ((newline = pending.indexOf(0x0a)) >= 0) {
        migrateLine(pending.subarray(0, newline));
        pending = pending.subarray(newline + 1);
      }
      if (pending.byteLength > maxBytes) {
        throw new HostStateCorruptionError("Legacy journal contains an oversized unterminated event");
      }
    }
    if (pending.byteLength > 0) migrateLine(pending);
    closeOutput();
    fs.closeSync(input);
    input = undefined;
    if (segments.length < 2) {
      throw new HostStateCorruptionError(
        "Oversized legacy journal did not produce multiple bounded segments",
      );
    }
    const revalidated = fs.lstatSync(filePath);
    if (
      !sameInode(before, revalidated) ||
      revalidated.size !== before.size ||
      revalidated.mtimeMs !== before.mtimeMs
    ) {
      throw new HostStateCorruptionError("Harness journal changed during legacy migration");
    }
    for (const [index, segment] of segments.entries()) {
      segment.destination = index === segments.length - 1
        ? basename
        : path.basename(segmentPath(filePath, segment.start, segment.end));
      if (
        index !== segments.length - 1 &&
        pathExists(path.join(directory, segment.destination))
      ) {
        throw new HostStateCorruptionError("Harness journal migration destination already exists");
      }
    }
    const manifest: LegacyJournalMigrationManifest = {
      schema: "one-cli.harness/legacy-journal-migration-v1",
      source: {
        size: before.size,
        sha256: sourceHash.digest("hex"),
      },
      backup,
      segments,
    };
    writeMigrationManifest(filePath, manifest);
    manifestDurable = true;
    onStep?.("after-manifest-durable");
    reconcileLegacyJournalMigration(filePath, maxBytes, onStep);
  } catch (error) {
    if (input !== undefined) fs.closeSync(input);
    if (output !== undefined) fs.closeSync(output);
    if (!manifestDurable && !pathExists(migrationManifestPath(filePath))) {
      for (const candidate of [
        ...segments.map((segment) => path.join(directory, segment.temporary)),
        outputPath,
      ]) {
        if (!candidate) continue;
        try {
          fs.unlinkSync(candidate);
        } catch (cleanupError) {
          if (!isCode(cleanupError, "ENOENT")) throw cleanupError;
        }
      }
    }
    throw error;
  }
}

function reconcileLegacyJournalMigration(
  filePath: string,
  maxBytes: number,
  onStep?: (step: string) => void,
): boolean {
  const manifestPath = migrationManifestPath(filePath);
  if (!pathExists(manifestPath)) return false;
  const manifest = readMigrationManifest(filePath, maxBytes);
  const directory = path.dirname(filePath);
  const activePath = filePath;
  const backupPath = path.join(directory, manifest.backup);
  const source = fileIdentityOrUndefined(activePath, "active journal");
  const backup = fileIdentityOrUndefined(backupPath, "legacy journal backup");
  const sourceMatches = sameFileIdentity(source, manifest.source);
  const backupMatches = sameFileIdentity(backup, manifest.source);

  if (source && sourceMatches && backup) {
    throw new HostStateCorruptionError(
      "Legacy journal migration has duplicate source and backup files",
    );
  }
  if (backup && !backupMatches) {
    throw new HostStateCorruptionError("Legacy journal migration backup identity is corrupt");
  }

  if (!backup) {
    if (sourceMatches) {
      for (const [index, segment] of manifest.segments.entries()) {
        const temporary = fileIdentityOrUndefined(
          path.join(directory, segment.temporary),
          `migration temporary segment ${index + 1}`,
        );
        if (!sameFileIdentity(temporary, segment)) {
          throw new HostStateCorruptionError(
            `Legacy journal migration temporary segment ${index + 1} is corrupt`,
          );
        }
        if (
          index !== manifest.segments.length - 1 &&
          pathExists(path.join(directory, segment.destination))
        ) {
          throw new HostStateCorruptionError(
            `Legacy journal migration destination segment ${index + 1} already exists`,
          );
        }
      }
      fs.renameSync(activePath, backupPath);
      fsyncDirectory(directory);
      onStep?.("after-source-rename");
    } else {
      for (const segment of manifest.segments) {
        requirePlannedSegmentLocation(directory, segment, "destination");
      }
      verifyMigratedJournalChain(directory, manifest);
      onStep?.("after-chain-verification");
      fs.unlinkSync(manifestPath);
      fsyncDirectory(directory);
      return true;
    }
  }

  for (const [index, segment] of manifest.segments.entries()) {
    const temporary = path.join(directory, segment.temporary);
    const destination = path.join(directory, segment.destination);
    const temporaryIdentity = fileIdentityOrUndefined(
      temporary,
      `migration temporary segment ${index + 1}`,
    );
    const destinationIdentity = fileIdentityOrUndefined(
      destination,
      `migration destination segment ${index + 1}`,
    );
    const temporaryMatches = sameFileIdentity(temporaryIdentity, segment);
    const destinationMatches = sameFileIdentity(destinationIdentity, segment);
    if (temporaryIdentity && !temporaryMatches) {
      throw new HostStateCorruptionError(
        `Legacy journal migration temporary segment ${index + 1} is corrupt`,
      );
    }
    if (destinationIdentity && !destinationMatches) {
      throw new HostStateCorruptionError(
        `Legacy journal migration destination segment ${index + 1} is corrupt`,
      );
    }
    if (temporaryIdentity && destinationIdentity) {
      throw new HostStateCorruptionError(
        `Legacy journal migration segment ${index + 1} exists in two locations`,
      );
    }
    if (!destinationIdentity) {
      if (!temporaryIdentity) {
        throw new HostStateCorruptionError(
          `Legacy journal migration segment ${index + 1} is missing`,
        );
      }
      fs.renameSync(temporary, destination);
      fsyncDirectory(directory);
      onStep?.(`after-segment-rename:${index + 1}`);
    }
  }

  verifyMigratedJournalChain(directory, manifest);
  onStep?.("after-chain-verification");
  const durableBackup = fileIdentityOrUndefined(backupPath, "legacy journal backup");
  if (durableBackup) {
    if (!sameFileIdentity(durableBackup, manifest.source)) {
      throw new HostStateCorruptionError("Legacy journal migration backup identity changed");
    }
    fs.unlinkSync(backupPath);
    fsyncDirectory(directory);
    onStep?.("after-backup-removal");
  }
  fs.unlinkSync(manifestPath);
  fsyncDirectory(directory);
  return true;
}

function migrationManifestPath(filePath: string): string {
  return `${filePath}.migration-state.json`;
}

function writeMigrationManifest(
  filePath: string,
  manifest: LegacyJournalMigrationManifest,
): void {
  const directory = path.dirname(filePath);
  const manifestPath = migrationManifestPath(filePath);
  const temporary = path.join(
    directory,
    `.${path.basename(filePath)}.migration-manifest-${crypto.randomBytes(8).toString("hex")}.tmp`,
  );
  const bytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_WRONLY |
        noFollowFlag(),
      0o600,
    );
    if (fs.writeSync(descriptor, bytes) !== bytes.byteLength) {
      throw new Error("Legacy journal migration manifest write was incomplete");
    }
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, manifestPath);
    fsyncDirectory(directory);
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(temporary);
    } catch (cleanupError) {
      if (!isCode(cleanupError, "ENOENT")) throw cleanupError;
    }
    throw error;
  }
}

function readMigrationManifest(
  filePath: string,
  maxBytes: number,
): LegacyJournalMigrationManifest {
  const manifestPath = migrationManifestPath(filePath);
  const identity = fileIdentityOrUndefined(manifestPath, "legacy migration manifest");
  if (!identity || identity.size > 1024 * 1024) {
    throw new HostStateCorruptionError("Legacy journal migration manifest is invalid");
  }
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    throw new HostStateCorruptionError("Legacy journal migration manifest is corrupt");
  }
  if (!isExactRecord(value, ["schema", "source", "backup", "segments"])) {
    throw new HostStateCorruptionError("Legacy journal migration manifest shape is invalid");
  }
  const source = value.source;
  if (
    value.schema !== "one-cli.harness/legacy-journal-migration-v1" ||
    !isExactRecord(source, ["size", "sha256"]) ||
    !Number.isSafeInteger(source.size) ||
    (source.size as number) <= maxBytes ||
    typeof source.sha256 !== "string" ||
    !HASH_PATTERN.test(source.sha256) ||
    typeof value.backup !== "string" ||
    !new RegExp(
      `^${escapeRegExp(path.basename(filePath))}\\.legacy-[0-9a-f]{24}$`,
      "u",
    ).test(value.backup) ||
    !Array.isArray(value.segments) ||
    value.segments.length < 2
  ) {
    throw new HostStateCorruptionError("Legacy journal migration manifest content is invalid");
  }
  const basename = path.basename(filePath);
  const temporaryPattern = new RegExp(
    `^\\.${escapeRegExp(basename)}\\.migration-[0-9a-f]{24}-\\d+$`,
    "u",
  );
  const segments: MigratedSegment[] = [];
  const names = new Set<string>();
  let expectedStart = 1;
  for (const [index, candidate] of value.segments.entries()) {
    if (
      !isExactRecord(candidate, [
        "temporary",
        "destination",
        "start",
        "end",
        "size",
        "sha256",
      ]) ||
      typeof candidate.temporary !== "string" ||
      !temporaryPattern.test(candidate.temporary) ||
      typeof candidate.destination !== "string" ||
      !Number.isSafeInteger(candidate.start) ||
      !Number.isSafeInteger(candidate.end) ||
      candidate.start !== expectedStart ||
      (candidate.end as number) < (candidate.start as number) ||
      !Number.isSafeInteger(candidate.size) ||
      (candidate.size as number) <= 0 ||
      (candidate.size as number) > maxBytes ||
      typeof candidate.sha256 !== "string" ||
      !HASH_PATTERN.test(candidate.sha256)
    ) {
      throw new HostStateCorruptionError(
        `Legacy journal migration segment plan ${index + 1} is invalid`,
      );
    }
    const expectedDestination = index === value.segments.length - 1
      ? basename
      : path.basename(segmentPath(filePath, candidate.start as number, candidate.end as number));
    if (
      candidate.destination !== expectedDestination ||
      names.has(candidate.temporary) ||
      names.has(candidate.destination)
    ) {
      throw new HostStateCorruptionError(
        `Legacy journal migration segment plan ${index + 1} is ambiguous`,
      );
    }
    names.add(candidate.temporary);
    names.add(candidate.destination);
    segments.push({
      temporary: candidate.temporary,
      destination: candidate.destination,
      start: candidate.start as number,
      end: candidate.end as number,
      size: candidate.size as number,
      sha256: candidate.sha256,
    });
    expectedStart = (candidate.end as number) + 1;
  }
  return {
    schema: "one-cli.harness/legacy-journal-migration-v1",
    source: {
      size: source.size as number,
      sha256: source.sha256,
    },
    backup: value.backup,
    segments,
  };
}

function requirePlannedSegmentLocation(
  directory: string,
  segment: MigratedSegment,
  location: "temporary" | "destination",
): void {
  const expected = location === "temporary" ? segment.temporary : segment.destination;
  const absent = location === "temporary" ? segment.destination : segment.temporary;
  const identity = fileIdentityOrUndefined(
    path.join(directory, expected),
    `migration ${location} segment`,
  );
  if (!sameFileIdentity(identity, segment)) {
    throw new HostStateCorruptionError(`Legacy journal migration ${location} segment is corrupt`);
  }
  if (pathExists(path.join(directory, absent))) {
    throw new HostStateCorruptionError("Legacy journal migration segment location is ambiguous");
  }
}

function verifyMigratedJournalChain(
  directory: string,
  manifest: LegacyJournalMigrationManifest,
): void {
  let expectedSequence = 1;
  let chainHead = "0".repeat(64);
  for (const [index, segment] of manifest.segments.entries()) {
    const filePath = path.join(directory, segment.destination);
    const identity = fileIdentityOrUndefined(filePath, `migrated segment ${index + 1}`);
    if (!sameFileIdentity(identity, segment)) {
      throw new HostStateCorruptionError(
        `Legacy journal migrated segment ${index + 1} identity is corrupt`,
      );
    }
    let first = 0;
    let last = 0;
    forEachBoundedLine(filePath, segment.size, (line) => {
      if (line.byteLength === 0) return;
      let event: JournalEvent;
      try {
        event = JSON.parse(line.toString("utf8")) as JournalEvent;
      } catch {
        throw new HostStateCorruptionError(
          `Legacy journal migrated segment ${index + 1} contains invalid JSON`,
        );
      }
      if (
        !validJournalEvent(event) ||
        event.seq !== expectedSequence ||
        !HASH_PATTERN.test(event.prevHash ?? "") ||
        !HASH_PATTERN.test(event.hash ?? "") ||
        event.prevHash !== chainHead ||
        event.hash !== hashValue({
          seq: event.seq,
          at: event.at,
          type: event.type,
          data: event.data,
          prevHash: event.prevHash,
        })
      ) {
        throw new HostStateCorruptionError(
          `Legacy journal migrated chain is corrupt at sequence ${expectedSequence}`,
        );
      }
      first ||= event.seq;
      last = event.seq;
      chainHead = event.hash;
      expectedSequence++;
    });
    if (first !== segment.start || last !== segment.end) {
      throw new HostStateCorruptionError(
        `Legacy journal migrated segment ${index + 1} range is corrupt`,
      );
    }
  }
}

function forEachBoundedLine(
  filePath: string,
  maxLineBytes: number,
  visit: (line: Buffer) => void,
): void {
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollowFlag());
  try {
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let pending = Buffer.alloc(0);
    for (;;) {
      const count = fs.readSync(descriptor, chunk, 0, chunk.byteLength, null);
      if (count === 0) break;
      pending = Buffer.concat([pending, chunk.subarray(0, count)]);
      let newline: number;
      while ((newline = pending.indexOf(0x0a)) >= 0) {
        visit(pending.subarray(0, newline));
        pending = pending.subarray(newline + 1);
      }
      if (pending.byteLength > maxLineBytes) {
        throw new HostStateCorruptionError("Legacy journal migrated event is oversized");
      }
    }
    if (pending.byteLength > 0) visit(pending);
  } finally {
    fs.closeSync(descriptor);
  }
}

function fileIdentityOrUndefined(
  filePath: string,
  label: string,
): { size: number; sha256: string } | undefined {
  let before: fs.Stats;
  try {
    before = fs.lstatSync(filePath);
  } catch (error) {
    if (isCode(error, "ENOENT")) return undefined;
    throw error;
  }
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new HostStateCorruptionError(`${label} is not a regular file`);
  }
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollowFlag());
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || !sameInode(before, opened) || opened.size !== before.size) {
      throw new HostStateCorruptionError(`${label} changed while opening`);
    }
    const digest = crypto.createHash("sha256");
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let size = 0;
    for (;;) {
      const count = fs.readSync(descriptor, chunk, 0, chunk.byteLength, null);
      if (count === 0) break;
      digest.update(chunk.subarray(0, count));
      size += count;
    }
    const after = fs.fstatSync(descriptor);
    if (!sameInode(opened, after) || after.size !== size) {
      throw new HostStateCorruptionError(`${label} changed while hashing`);
    }
    return { size, sha256: digest.digest("hex") };
  } finally {
    fs.closeSync(descriptor);
  }
}

function sameFileIdentity(
  actual: { size: number; sha256: string } | undefined,
  expected: { size: number; sha256: string },
): boolean {
  return actual?.size === expected.size && actual.sha256 === expected.sha256;
}

function cleanupAbandonedMigrationPlanning(directory: string, basename: string): void {
  let removed = false;
  for (const name of fs.readdirSync(directory)) {
    if (!name.startsWith(`.${basename}.migration-`)) continue;
    const candidate = path.join(directory, name);
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new HostStateCorruptionError("Abandoned journal migration artifact is unsafe");
    }
    fs.unlinkSync(candidate);
    removed = true;
  }
  if (removed) fsyncDirectory(directory);
}

function pathExists(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    if (isCode(error, "ENOENT")) return false;
    throw error;
  }
}

function isExactRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\n") === [...keys].sort().join("\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function journalFiles(filePath: string): Array<{
  filePath: string;
  range?: { start: number; end: number };
}> {
  const directory = path.dirname(filePath);
  const basename = path.basename(filePath);
  const prefix = `${basename}.segment-`;
  const archived = fs.readdirSync(directory)
    .filter((name) => name.startsWith(prefix))
    .map((name) => {
      const match = /^(\d{12})-(\d{12})$/u.exec(name.slice(prefix.length));
      if (!match) throw new Error(`Harness journal segment name is invalid: ${name}`);
      const start = Number(match[1]);
      const end = Number(match[2]);
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 1 ||
        end < start
      ) {
        throw new Error(`Harness journal segment range is invalid: ${name}`);
      }
      return { filePath: path.join(directory, name), range: { start, end } };
    })
    .sort((left, right) => left.range.start - right.range.start);
  return [
    ...archived,
    ...(fs.existsSync(filePath) ? [{ filePath }] : []),
  ];
}

function readJournalFile(filePath: string): JournalEvent[] {
  return fs.readFileSync(filePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line) as JournalEvent;
      } catch {
        throw new Error(
          `Harness journal is corrupt at ${path.basename(filePath)} line ${index + 1}`,
        );
      }
    });
}

function validJournalEvent(value: JournalEvent): boolean {
  return (
    Number.isSafeInteger(value.seq) &&
    value.seq > 0 &&
    typeof value.at === "string" &&
    typeof value.type === "string" &&
    Boolean(value.data) &&
    typeof value.data === "object" &&
    !Array.isArray(value.data)
  );
}

function segmentPath(filePath: string, start: number, end: number): string {
  return `${filePath}.segment-${String(start).padStart(12, "0")}-${String(end).padStart(12, "0")}`;
}

function hashValue(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function regularFileStat(
  filePath: string,
  maxBytes: number,
  allowMissing: boolean,
): fs.Stats | undefined {
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > maxBytes) {
      throw new Error("Harness journal is not a bounded regular file");
    }
    return stat;
  } catch (error) {
    if (allowMissing && isCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

function sameInode(
  left: Pick<fs.Stats, "dev" | "ino">,
  right: Pick<fs.Stats, "dev" | "ino">,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameLock(left: LockSnapshot, right: LockSnapshot): boolean {
  return (
    left.pid === right.pid &&
    left.token === right.token &&
    left.startedAt === right.startedAt &&
    sameInode(left, right)
  );
}

function noFollowFlag(): number {
  return fs.constants.O_NOFOLLOW ?? 0;
}

function fsyncDirectory(directoryPath: string): void {
  const directory = fs.openSync(directoryPath, "r");
  try {
    fs.fsyncSync(directory);
  } finally {
    fs.closeSync(directory);
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
  return isCode(error, "EEXIST");
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
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
