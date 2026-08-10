import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import {
  COMMUNITY_CAPABILITY_TOPICS,
  parseCommunityRegistry,
  type CommunityRegistry,
} from "./intake.js";

export const AUTONOMY_SCHEMA = "autonomy.one-cli/v1";
export const AUTONOMY_MODES = ["observe", "propose", "auto-pr", "auto-merge"] as const;
export type AutonomyMode = (typeof AUTONOMY_MODES)[number];

const CommandSchema = z.string().min(1).max(4_096);
const ProductSchema = z
  .object({
    schema: z.literal(AUTONOMY_SCHEMA),
    product: z.object({ name: z.string().min(1), type: z.string().min(1) }).strict(),
    repository: z
      .object({
        owner: z.string().regex(/^[A-Za-z0-9_.-]+$/u),
        name: z.string().regex(/^[A-Za-z0-9_.-]+$/u),
        defaultBranch: z.string().min(1),
        mergeStrategy: z.enum(["merge", "squash", "rebase"]),
      })
      .strict(),
    execution: z.object({ author: z.string().min(1) }).strict(),
    runtime: z
      .object({ node: z.string().min(1), packageManager: z.string().min(1) })
      .strict(),
    commands: z.record(z.string(), CommandSchema),
    limits: z
      .object({
        tickMinutes: z.number().int().positive(),
        commitsMin: z.number().int().positive(),
        commitsMax: z.number().int().positive(),
        loopMinutes: z.number().int().positive(),
        maxRounds: z.number().int().positive().max(100).optional(),
        maxToolCalls: z.number().int().positive().max(10_000).optional(),
        maxWallTimeMinutes: z.number().int().positive().max(24 * 60).optional(),
        maxChangedFiles: z.number().int().positive().optional(),
        maxChangedBytes: z.number().int().positive().optional(),
      })
      .strict(),
    mode: z.enum(AUTONOMY_MODES).optional(),
  })
  .strict();

const IssuePolicySchema = z
  .object({
    schema: z.literal(AUTONOMY_SCHEMA),
    executionAuthor: z.string().min(1),
    sources: z.record(z.string(), z.unknown()),
    authorization: z
      .object({
        apiAuthorExactMatch: z.string().min(1),
        immutable: z.boolean(),
        executableIssueMustBeOpen: z.boolean(),
        issueTextLabelsCommentsAndLinksGrantAuthority: z.boolean(),
        rejectQuarantined: z.boolean(),
        rejectExistingBranchOrPullRequest: z.boolean(),
      })
      .strict(),
    lease: z
      .object({
        maximumActiveIssues: z.number().int().min(1).max(1),
        reconcileGitHubAndLedgerBeforeAcquire: z.boolean(),
        mismatchBlocksAcquisition: z.boolean(),
      })
      .strict(),
    normalization: z
      .object({
        requiredFields: z.array(z.string().min(1)).min(1),
        stripInstructionsAndUnsafeContent: z.boolean(),
        deduplicateAgainst: z.array(z.string()),
      })
      .strict(),
    failureIsolation: z
      .object({
        fingerprintFields: z.array(z.string().min(1)),
        identicalCodeFailureLimit: z.number().int().min(1).max(10),
        firstAndSecondAttemptRequireNewDiagnosisEvidence: z.boolean(),
        thirdFailureState: z.literal("failed"),
        thirdFailureLabel: z.string().min(1),
        thirdFailureAction: z.string().min(1),
        retryOnlyAfterNewEvidenceOrMaintainerChange: z.boolean(),
        transientInfrastructureState: z.literal("waiting"),
        waitingCountsAsCodeFailure: z.boolean(),
        productDecisionBlockReleasesLease: z.boolean(),
      })
      .passthrough(),
  })
  .passthrough();

const QualityGatesSchema = z
  .object({
    schema: z.literal(AUTONOMY_SCHEMA),
    localCommands: z
      .array(
        z
          .object({
            name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
            commandFrom: z.string().regex(/^commands\.[A-Za-z0-9._-]+$/u),
          })
          .strict(),
      )
      .min(1),
    githubChecks: z.object({ required: z.array(z.string().min(1)).min(1) }).strict(),
    branch: z.record(z.string(), z.unknown()),
    evidence: z.record(z.string(), z.unknown()),
    security: z.record(z.string(), z.unknown()),
    selfReview: z
      .object({
        required: z.boolean(),
        independentFromImplementation: z.boolean(),
        maximumCriticalFindings: z.number().int().min(0),
        unresolvedFindingsBlockMerge: z.boolean(),
      })
      .strict(),
    governance: z
      .object({
        protectedPaths: z.array(z.string().min(1)),
        executionAuthor: z.string().min(1),
        changesBlockAutomaticMerge: z.boolean(),
      })
      .passthrough(),
    merge: z.record(z.string(), z.unknown()),
    postMergeDogfood: z.record(z.string(), z.unknown()),
  })
  .strict();

export const RECOVERY_POLICY_SCHEMA = "autonomy.one-cli/recovery-policy-v1";
export const RECOVERY_EVIDENCE_SOURCES = [
  "local-process",
  "worker",
  "github-check",
  "reconciler",
] as const;
export const RecoveryPolicySchema = z
  .object({
    schema: z.literal(RECOVERY_POLICY_SCHEMA),
    receipts: z
      .object({
        maxStdoutBytes: z.number().int().min(256).max(64 * 1024),
        maxStderrBytes: z.number().int().min(256).max(64 * 1024),
        maxSpawnErrorBytes: z.number().int().min(128).max(8 * 1024),
        maxReceiptsPerAttempt: z.number().int().min(1).max(100),
        redaction: z.literal("strict"),
      })
      .strict(),
    machineEvidence: z
      .object({
        maxSummaryBytes: z.number().int().min(64).max(16 * 1024),
        allowedSources: z.tuple([
          z.literal("local-process"),
          z.literal("worker"),
          z.literal("github-check"),
          z.literal("reconciler"),
        ]),
        requireOperationId: z.literal(true),
        requireFailureFingerprint: z.literal(true),
        deduplicateByHash: z.literal(true),
      })
      .strict(),
    manualBreakGlass: z
      .object({
        maxEvidenceBytes: z.number().int().min(64).max(16 * 1024),
        requireNovelEvidence: z.literal(true),
      })
      .strict(),
  })
  .strict();
export type RecoveryPolicy = z.infer<typeof RecoveryPolicySchema>;

export function parseRecoveryPolicy(input: unknown): RecoveryPolicy {
  return RecoveryPolicySchema.parse(input);
}

export const GAP_POLICY_SCHEMA = "autonomy.one-cli/gap-policy-v1";
const ProtectedPathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !path.isAbsolute(value) && !value.split("/").includes(".."), {
    message: "Protected governance paths must be repository-relative",
  });
export const GapPolicySchema = z
  .object({
    schema: z.literal(GAP_POLICY_SCHEMA),
    categories: z.tuple([
      z.literal("project-monitoring"),
      z.literal("interactive-coding-agent"),
      z.literal("long-sessions-context"),
      z.literal("extensions-parallelism"),
      z.literal("provider-cost-governance"),
      z.literal("safety-platform-testing-docs"),
    ]),
    confidenceThreshold: z.literal("likely"),
    minimumScore: z.number().int().min(1).max(100),
    maximumPromotionsPerTick: z.literal(1),
    findingTtlDays: z.number().int().min(1).max(365),
    protectedGovernancePaths: z.array(ProtectedPathSchema).min(1),
    directExecution: z
      .object({
        governance: z.literal("forbidden"),
        speculative: z.literal("forbidden"),
      })
      .strict(),
  })
  .strict()
  .superRefine((policy, context) => {
    if (new Set(policy.protectedGovernancePaths).size !== policy.protectedGovernancePaths.length) {
      context.addIssue({
        code: "custom",
        path: ["protectedGovernancePaths"],
        message: "Protected governance paths must be unique",
      });
    }
    if (
      policy.categories.some(
        (category, index) => category !== COMMUNITY_CAPABILITY_TOPICS[index],
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["categories"],
        message: "Gap categories must match the closed community capability taxonomy",
      });
    }
  });
export type GapPolicy = z.infer<typeof GapPolicySchema>;

export function parseGapPolicy(input: unknown): GapPolicy {
  return GapPolicySchema.parse(input);
}

export interface ConfiguredCommand {
  name: string;
  executable: string;
  args: readonly string[];
  network: boolean;
}

export interface AutonomyConfig {
  repoRoot: string;
  repoKey: string;
  stateRoot: string;
  policyHash: string;
  researchPolicyHash: string;
  /** Maximum authority declared by trusted tracked configuration. */
  maximumMode: AutonomyMode;
  /** Authority selected for this invocation (defaults to propose). */
  mode: AutonomyMode;
  product: z.infer<typeof ProductSchema>;
  issuePolicy: z.infer<typeof IssuePolicySchema>;
  qualityGates: z.infer<typeof QualityGatesSchema>;
  recoveryPolicy: RecoveryPolicy;
  community: CommunityRegistry;
  gapPolicy: GapPolicy;
  commands: Readonly<Record<string, ConfiguredCommand>>;
}

export interface LoadAutonomyConfigOptions {
  env?: NodeJS.ProcessEnv;
  mode?: AutonomyMode;
}

export function loadAutonomyConfig(
  repoRoot: string,
  options: LoadAutonomyConfigOptions = {},
): AutonomyConfig {
  const canonicalRoot = fs.realpathSync(repoRoot);
  const directory = path.join(canonicalRoot, ".autonomy");
  const productValue = readYaml(path.join(directory, "product.yml"));
  const issuePolicyValue = readYaml(path.join(directory, "issue-policy.yml"));
  const qualityGatesValue = readYaml(path.join(directory, "quality-gates.yml"));
  const recoveryPolicyValue = readYaml(path.join(directory, "recovery-policy.yml"));
  const communityValue = readYaml(path.join(directory, "community.yml"));
  const gapPolicyValue = readYaml(path.join(directory, "gap-policy.yml"));
  rejectSecretKeys({
    productValue,
    issuePolicyValue,
    qualityGatesValue,
    recoveryPolicyValue,
    communityValue,
    gapPolicyValue,
  });

  const product = ProductSchema.parse(productValue);
  const issuePolicy = IssuePolicySchema.parse(issuePolicyValue);
  const qualityGates = QualityGatesSchema.parse(qualityGatesValue);
  const recoveryPolicy = parseRecoveryPolicy(recoveryPolicyValue);
  const community = parseCommunityRegistry(communityValue);
  const gapPolicy = parseGapPolicy(gapPolicyValue);
  if (
    product.execution.author !== issuePolicy.executionAuthor ||
    product.execution.author !== issuePolicy.authorization.apiAuthorExactMatch ||
    product.execution.author !== qualityGates.governance.executionAuthor
  ) {
    throw new Error("Autonomy execution author is inconsistent across policy files");
  }
  if (product.limits.commitsMin > product.limits.commitsMax) {
    throw new Error("Autonomy commit limits are invalid");
  }
  if (new Set(qualityGates.githubChecks.required).size !== qualityGates.githubChecks.required.length) {
    throw new Error("Duplicate required GitHub check names are forbidden");
  }

  const commands: Record<string, ConfiguredCommand> = {};
  const referenced = new Set<string>();
  for (const gate of qualityGates.localCommands) {
    if (referenced.has(gate.name)) throw new Error(`Duplicate local command: ${gate.name}`);
    referenced.add(gate.name);
    const key = gate.commandFrom.slice("commands.".length);
    const command = product.commands[key];
    if (command === undefined) throw new Error(`Unknown configured command: ${gate.commandFrom}`);
    const [executable, ...args] = parseCommand(command);
    if (executable === undefined) throw new Error(`Configured command is empty: ${key}`);
    commands[gate.name] = { name: gate.name, executable, args, network: gate.name === "install" };
  }

  const maximumMode = product.mode ?? "propose";
  const mode = narrowMode(maximumMode, options.mode ?? "propose");
  const repoKey = repositoryKey(product.repository.owner, product.repository.name);
  const environment = options.env ?? process.env;
  const home = environment.ONE_CLI_HOME ?? path.join(os.homedir(), ".one-cli");
  const stateRoot = path.join(path.resolve(home), "autonomy", repoKey);
  if (mode !== "observe") {
    fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(stateRoot, 0o700);
    } catch {
      // POSIX permissions are best-effort on non-POSIX filesystems.
    }
  }

  return {
    repoRoot: canonicalRoot,
    repoKey,
    stateRoot,
    policyHash: policyHash({
      product,
      issuePolicy,
      qualityGates,
      recoveryPolicy,
      community,
      gapPolicy,
    }),
    researchPolicyHash: policyHash({ community, gapPolicy }),
    maximumMode,
    mode,
    product,
    issuePolicy,
    qualityGates,
    recoveryPolicy,
    community,
    gapPolicy,
    commands,
  };
}

export function repositoryKey(owner: string, repository: string): string {
  const slug = `${owner}-${repository}`.toLowerCase().replace(/[^a-z0-9._-]+/gu, "-");
  const digest = crypto.createHash("sha256").update(`${owner}/${repository}`).digest("hex").slice(0, 12);
  return `${slug.slice(0, 80)}-${digest}`;
}

export function policyHash(value: unknown): string {
  return crypto.createHash("sha256").update(stableJson(value)).digest("hex");
}

export function narrowMode(configured: AutonomyMode, requested?: AutonomyMode): AutonomyMode {
  if (requested === undefined) return configured;
  if (AUTONOMY_MODES.indexOf(requested) > AUTONOMY_MODES.indexOf(configured)) {
    throw new Error(`CLI mode ${requested} would broaden configured mode ${configured}`);
  }
  return requested;
}

/** Parse a deliberately small command grammar into direct executable argv. */
export function parseCommand(command: string): readonly string[] {
  if (/[\0\r\n;&|<>`$(){}]/u.test(command)) {
    throw new Error("Configured command contains shell syntax");
  }
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let started = false;
  for (const character of command.trim()) {
    if (escaped) {
      token += character;
      escaped = false;
      started = true;
    } else if (character === "\\") {
      escaped = true;
      started = true;
    } else if (quote !== null) {
      if (character === quote) quote = null;
      else token += character;
      started = true;
    } else if (character === "'" || character === '"') {
      quote = character;
      started = true;
    } else if (/\s/u.test(character)) {
      if (started) {
        tokens.push(token);
        token = "";
        started = false;
      }
    } else {
      token += character;
      started = true;
    }
  }
  if (escaped || quote !== null) throw new Error("Configured command has incomplete quoting");
  if (started) tokens.push(token);
  if (tokens.length === 0 || tokens[0]!.startsWith("-")) {
    throw new Error("Configured command must contain a safe executable");
  }
  return tokens;
}

function readYaml(filePath: string): unknown {
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error(`Invalid autonomy config: ${filePath}`);
  try {
    return YAML.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Invalid YAML in ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function rejectSecretKeys(value: unknown, trail = "config"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectSecretKeys(item, `${trail}[${index}]`));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (/^(?:token|secret|password|credentials?|private[_-]?key|api[_-]?key)$/iu.test(key)) {
      throw new Error(`Secrets are forbidden in tracked autonomy configuration (${trail}.${key})`);
    }
    rejectSecretKeys(nested, `${trail}.${key}`);
  }
}
