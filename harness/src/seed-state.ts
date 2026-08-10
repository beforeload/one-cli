import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface SeedOperation {
  operationId: string;
  marker: string;
  target: string;
  state: "in_doubt" | "succeeded";
  issueNumber?: number;
}

export interface SeedOperationStore {
  get(operationId: string): SeedOperation | undefined;
  reserve(input: { operationId: string; marker: string; target: string }): SeedOperation;
  succeed(operationId: string, issueNumber: number): SeedOperation;
}

export function seedOperationId(marker: string): string {
  return `seed-${crypto.createHash("sha256").update(marker).digest("hex").slice(0, 24)}`;
}

export class SeedOperationJournal implements SeedOperationStore {
  private readonly operations = new Map<string, SeedOperation>();

  constructor(readonly filePath: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    if (!fs.existsSync(filePath)) return;
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 16 * 1024 * 1024) {
      throw new Error("Seed operation journal is not a bounded regular file");
    }
    for (const [index, line] of fs.readFileSync(filePath, "utf8").split("\n").entries()) {
      if (!line) continue;
      try {
        const operation = parseOperation(JSON.parse(line) as unknown);
        this.operations.set(operation.operationId, operation);
      } catch {
        throw new Error(`Seed operation journal is corrupt at line ${index + 1}`);
      }
    }
  }

  get(operationId: string): SeedOperation | undefined {
    return this.operations.get(operationId);
  }

  reserve(input: { operationId: string; marker: string; target: string }): SeedOperation {
    const existing = this.operations.get(input.operationId);
    if (existing) {
      if (existing.marker !== input.marker || existing.target !== input.target) {
        throw new Error("Seed operation ID is already bound to another request");
      }
      return existing;
    }
    const operation: SeedOperation = { ...input, state: "in_doubt" };
    this.append(operation);
    return operation;
  }

  succeed(operationId: string, issueNumber: number): SeedOperation {
    const existing = this.operations.get(operationId);
    if (!existing) throw new Error("Seed operation reservation is missing");
    if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
      throw new Error("Seed issue number must be positive");
    }
    if (existing.state === "succeeded") {
      if (existing.issueNumber !== issueNumber) {
        throw new Error("Seed operation was reconciled to another issue");
      }
      return existing;
    }
    const operation: SeedOperation = { ...existing, state: "succeeded", issueNumber };
    this.append(operation);
    return operation;
  }

  private append(operation: SeedOperation): void {
    const descriptor = fs.openSync(this.filePath, "a", 0o600);
    try {
      fs.writeSync(descriptor, `${JSON.stringify(operation)}\n`);
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
    this.operations.set(operation.operationId, operation);
  }
}

function parseOperation(value: unknown): SeedOperation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("shape");
  const operation = value as Record<string, unknown>;
  if (
    typeof operation.operationId !== "string" ||
    typeof operation.marker !== "string" ||
    typeof operation.target !== "string" ||
    (operation.state !== "in_doubt" && operation.state !== "succeeded") ||
    (operation.issueNumber !== undefined &&
      (typeof operation.issueNumber !== "number" ||
        !Number.isSafeInteger(operation.issueNumber) ||
        operation.issueNumber <= 0)) ||
    (operation.state === "succeeded" && operation.issueNumber === undefined)
  ) {
    throw new Error("shape");
  }
  return operation as unknown as SeedOperation;
}
