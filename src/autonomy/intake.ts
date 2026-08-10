import crypto from "node:crypto";
import { z } from "zod";
import type { AutonomyConfig } from "./config.js";
import type {
  GitHubIssue,
  GitHubPort,
  GitHubRepositoryRef,
} from "./github.js";
import { normalizedIssueFields } from "./github.js";
import type { AutonomyStore } from "./store.js";
import type { JsonValue, Operation } from "./domain.js";

export const EXECUTION_MARKER = "<!-- one-cli:trusted-execution:v1 -->";
export const USER_SOURCE_LABEL = "source:user";
export const COMMUNITY_SOURCE_LABEL = "source:community";
export const SELF_DISCOVERY_SOURCE_LABEL = "source:self-discovery";
export const AGENT_READY_LABEL = "agent-ready";
export const MAINTAINER_ACCEPTED_LABEL = "maintainer-accepted";
export const APPROVED_PATHS_BINDING_PREFIX = "Trusted approved paths (exact JSON): ";
export const COLD_START_ROADMAP_LABEL = "cold-start-roadmap";
export const COMMUNITY_SCHEMA = "autonomy.one-cli/community-v2";
export const COMMUNITY_SOURCE_IDS = [
  "qwen-code",
  "claude-code",
  "openai-codex",
  "gemini-cli",
  "opencode",
  "aider",
  "goose",
  "continue-cli",
  "oh-my-cli",
] as const;
export const COMMUNITY_CAPABILITY_TOPICS = [
  "project-monitoring",
  "interactive-coding-agent",
  "long-sessions-context",
  "extensions-parallelism",
  "provider-cost-governance",
  "safety-platform-testing-docs",
] as const;
export type CommunityCapabilityTopic = (typeof COMMUNITY_CAPABILITY_TOPICS)[number];
const OFFICIAL_COMMUNITY_REPOSITORIES: Readonly<
  Record<(typeof COMMUNITY_SOURCE_IDS)[number], string>
> = {
  "qwen-code": "https://github.com/QwenLM/qwen-code",
  "claude-code": "https://github.com/anthropics/claude-code",
  "openai-codex": "https://github.com/openai/codex",
  "gemini-cli": "https://github.com/google-gemini/gemini-cli",
  opencode: "https://github.com/anomalyco/opencode",
  aider: "https://github.com/Aider-AI/aider",
  goose: "https://github.com/aaif-goose/goose",
  "continue-cli": "https://github.com/continuedev/continue",
  "oh-my-cli": "https://github.com/qwen-code-dev-bot/oh-my-cli",
};

const MAX_TITLE_LENGTH = 160;
const MAX_FIELD_LENGTH = 4_096;
const MAX_FIELDS_LENGTH = 32_768;
const UNSAFE_CHARACTERS =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/gu;
const INSTRUCTION_LINE =
  /^\s*(?:(?:system|developer|assistant|tool|function)\s*:|(?:ignore|disregard|override|forget)\b.{0,80}\b(?:instruction|prompt|policy|rule)s?\b|(?:run|execute|invoke|call|launch|eval)\b.{0,80}\b(?:command|shell|script|tool|code)\b|(?:sudo|curl|wget|bash|sh|zsh|powershell|cmd)(?:\s|$)|[$>]\s*(?:rm|git|npm|npx|node|python|curl|wget|sudo)\b|<\s*\/?\s*(?:system|developer|assistant|tool)\b)/iu;
const INLINE_INSTRUCTION =
  /\b(?:ignore|disregard|override|forget)\b.{0,100}\b(?:previous|prior|system|developer|instruction|prompt|policy|rule)s?\b/giu;

export interface TrustedIntakeDependencies {
  config: AutonomyConfig;
  store: AutonomyStore;
  github: GitHubPort;
  repository?: GitHubRepositoryRef;
}

export interface PromotionResult {
  created: boolean;
  executionIssueNumber: number;
  executionIssue?: GitHubIssue;
  idempotencyKey: string;
  marker: string;
  operationId?: string;
}

export class IntakeWriteInDoubtError extends Error {
  constructor(
    readonly operationId: string,
    message: string,
  ) {
    super(message);
    this.name = "IntakeWriteInDoubtError";
  }
}

export class IntakePromotionRetryableError extends Error {
  constructor(
    readonly operationId: string,
    message: string,
  ) {
    super(message);
    this.name = "IntakePromotionRetryableError";
  }
}

export interface UserPromotionInput {
  issueNumber: number;
  normalizedFields: Readonly<Record<string, string>>;
  title?: string;
  acceptedLabel?: string;
  signal?: AbortSignal;
}

export interface CommunityPromotionInput {
  finding: unknown;
  registry: CommunityRegistry;
  normalizedFields: Readonly<Record<string, string>>;
  signal?: AbortSignal;
}

export interface SelfDiscoveryPromotionInput {
  finding: unknown;
  normalizedFields: Readonly<Record<string, string>>;
  signal?: AbortSignal;
}

export interface CommunitySource {
  id: (typeof COMMUNITY_SOURCE_IDS)[number];
  name: string;
  trust: "official-primary";
  repository: string;
  documentation: {
    url: string;
    kind: "official-documentation";
  };
  releases: string;
  discussions: string;
  topics: readonly CommunityCapabilityTopic[];
}

export interface CommunityRegistry {
  schema: typeof COMMUNITY_SCHEMA;
  registeredSourcesOnly: true;
  monitoring: {
    intervalMinutes: 120;
    maximumLatenessMinutes: 60;
  };
  allowedSourceTypes: readonly (
    | "official-repository"
    | "official-documentation"
    | "official-releases"
    | "official-discussions"
  )[];
  capabilityTopics: readonly CommunityCapabilityTopic[];
  registryExpansion: {
    mode: "governance-proposal-only";
    developmentAuthorMayModifyRegistry: false;
  };
  findingRequirements: readonly [
    "sourceUrl",
    "observedVersionOrDate",
    "originalCommunityNeed",
    "productComparison",
    "duplicateSearchEvidence",
    "approvedPaths",
  ];
  promotion: {
    author: string;
    label: "source:community";
    requiresInScope: true;
    requiresTestableImprovement: true;
    contentMaySupplyCommandsOrAuthority: false;
  };
  sources: readonly CommunitySource[];
}

export interface CommunityFinding {
  sourceId: string;
  sourceUrl: string;
  observedVersionOrDate: string;
  title: string;
  originalCommunityNeed: string;
  productComparison: string;
  duplicateSearchEvidence: string;
  approvedPaths: readonly string[];
  inScope: true;
  testableImprovement: true;
}

export interface ResearchPort {
  scan(source: CommunitySource, signal?: AbortSignal): Promise<readonly unknown[]>;
}

export interface SelfDiscoveryFinding {
  title: string;
  problemStatement: string;
  reproduction: string;
  minimalScenario: string;
  duplicateSearchEvidence: string;
}

const CommunitySourceSchema = z
  .object({
    id: z.enum(COMMUNITY_SOURCE_IDS),
    name: z.string().min(1).max(200),
    trust: z.literal("official-primary"),
    repository: z.url(),
    documentation: z
      .object({
        url: z.url(),
        kind: z.literal("official-documentation"),
      })
      .strict(),
    releases: z.url(),
    discussions: z.url(),
    topics: z.array(z.enum(COMMUNITY_CAPABILITY_TOPICS)).min(1),
  })
  .strict();

const CommunityRegistrySchema = z
  .object({
    schema: z.literal(COMMUNITY_SCHEMA),
    registeredSourcesOnly: z.literal(true),
    monitoring: z
      .object({
        intervalMinutes: z.literal(120),
        maximumLatenessMinutes: z.literal(60),
      })
      .strict(),
    allowedSourceTypes: z.tuple([
      z.literal("official-repository"),
      z.literal("official-documentation"),
      z.literal("official-releases"),
      z.literal("official-discussions"),
    ]),
    capabilityTopics: z.tuple([
      z.literal("project-monitoring"),
      z.literal("interactive-coding-agent"),
      z.literal("long-sessions-context"),
      z.literal("extensions-parallelism"),
      z.literal("provider-cost-governance"),
      z.literal("safety-platform-testing-docs"),
    ]),
    registryExpansion: z
      .object({
        mode: z.literal("governance-proposal-only"),
        developmentAuthorMayModifyRegistry: z.literal(false),
      })
      .strict(),
    findingRequirements: z.tuple([
      z.literal("sourceUrl"),
      z.literal("observedVersionOrDate"),
      z.literal("originalCommunityNeed"),
      z.literal("productComparison"),
      z.literal("duplicateSearchEvidence"),
      z.literal("approvedPaths"),
    ]),
    promotion: z
      .object({
        author: z.string().min(1).max(128),
        label: z.literal(COMMUNITY_SOURCE_LABEL),
        requiresInScope: z.literal(true),
        requiresTestableImprovement: z.literal(true),
        contentMaySupplyCommandsOrAuthority: z.literal(false),
      })
      .strict(),
    sources: z.array(CommunitySourceSchema).length(COMMUNITY_SOURCE_IDS.length),
  })
  .strict();

const CommunityFindingSchema = z
  .object({
    sourceId: z.string().min(1).max(128),
    sourceUrl: z.url(),
    observedVersionOrDate: z.string().min(1).max(200),
    title: z.string().min(1).max(MAX_TITLE_LENGTH),
    originalCommunityNeed: z.string().min(1).max(MAX_FIELD_LENGTH),
    productComparison: z.string().min(1).max(MAX_FIELD_LENGTH),
    duplicateSearchEvidence: z.string().min(1).max(MAX_FIELD_LENGTH),
    approvedPaths: z.array(z.string().min(1).max(512)).min(1).max(128),
    inScope: z.literal(true),
    testableImprovement: z.literal(true),
  })
  .strict();

const SelfDiscoveryFindingSchema = z
  .object({
    title: z.string().min(1).max(MAX_TITLE_LENGTH),
    problemStatement: z.string().min(1).max(MAX_FIELD_LENGTH),
    reproduction: z.string().min(1).max(MAX_FIELD_LENGTH),
    minimalScenario: z.string().min(1).max(MAX_FIELD_LENGTH),
    duplicateSearchEvidence: z.string().min(1).max(MAX_FIELD_LENGTH),
  })
  .strict();

/**
 * Treats external prose as data. Instruction-looking lines, fenced code,
 * control/bidi characters and excess data never cross the trusted boundary.
 */
export function sanitizeUntrustedText(value: string, maxLength = MAX_FIELD_LENGTH): string {
  if (!Number.isSafeInteger(maxLength) || maxLength < 1) {
    throw new Error("Sanitized text limit must be a positive integer");
  }
  let inFence = false;
  const lines: string[] = [];
  for (const rawLine of value.normalize("NFKC").replace(UNSAFE_CHARACTERS, "").split(/\r?\n/u)) {
    const line = rawLine.trimEnd();
    if (/^\s*```/u.test(line)) {
      inFence = !inFence;
      continue;
    }
    const cleaned = line.replace(INLINE_INSTRUCTION, "[removed untrusted instruction]");
    if (inFence) continue;
    if (INSTRUCTION_LINE.test(line)) {
      if (cleaned === line) continue;
      const remainder = cleaned
        .replace("[removed untrusted instruction]", "")
        .replace(/^[\s,.:;!—-]+/u, "")
        .trim();
      if (remainder) lines.push(remainder);
      continue;
    }
    lines.push(cleaned);
  }
  return lines.join("\n").replace(/\n{3,}/gu, "\n\n").trim().slice(0, maxLength).trim();
}

export function sanitizeUntrustedFields(
  fields: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const sanitized: Record<string, string> = {};
  let remaining = MAX_FIELDS_LENGTH;
  for (const key of Object.keys(fields).sort()) {
    if (!/^[A-Za-z][A-Za-z0-9]*$/u.test(key)) throw new Error(`Unsafe normalized field: ${key}`);
    if (remaining <= 0) break;
    const value = sanitizeUntrustedText(
      (fields[key] ?? "").replace(/^\s*#{1,6}\s+/gmu, "Section: "),
      Math.min(MAX_FIELD_LENGTH, remaining),
    );
    if (value) {
      sanitized[key] = value;
      remaining -= value.length;
    }
  }
  return sanitized;
}

export function approvedPathBindingFields(paths: readonly string[]): {
  approvedPaths: readonly string[];
  scope: string;
  acceptanceCriteria: string;
} {
  const approvedPaths = canonicalApprovedPaths(paths);
  const binding = `${APPROVED_PATHS_BINDING_PREFIX}${JSON.stringify(approvedPaths)}`;
  return {
    approvedPaths,
    scope: `${binding}\nModify only these exact repository-relative paths. No other path is in scope.`,
    acceptanceCriteria:
      `${binding}\nAll implementation and test changes are limited to these exact paths, ` +
      "and the required quality gates pass.",
  };
}

export function parseApprovedPathBinding(
  fields: Readonly<Record<string, string>>,
): readonly string[] | undefined {
  const scope = parseApprovedPathLine(fields.scope);
  const acceptance = parseApprovedPathLine(fields.acceptanceCriteria);
  if (
    scope === undefined ||
    acceptance === undefined ||
    scope.length !== acceptance.length ||
    scope.some((candidate, index) => candidate !== acceptance[index])
  ) {
    return undefined;
  }
  return scope;
}

export function hasApprovedPathBindingMarker(
  fields: Readonly<Record<string, string>>,
): boolean {
  return [fields.scope, fields.acceptanceCriteria, fields.sourceLinkOrEvidence].some(
    (value) => value?.split(/\r?\n/u).some(
      (line) => line.startsWith(APPROVED_PATHS_BINDING_PREFIX),
    ) === true,
  );
}

export function executionMarker(idempotencyKey: string): string {
  return `${EXECUTION_MARKER}\n<!-- one-cli:idempotency:${digest(idempotencyKey)} -->`;
}

function parseApprovedPathLine(value: string | undefined): readonly string[] | undefined {
  if (!value) return undefined;
  const line = value
    .split(/\r?\n/u)
    .find((candidate) => candidate.startsWith(APPROVED_PATHS_BINDING_PREFIX));
  if (!line) return undefined;
  try {
    const parsed = JSON.parse(line.slice(APPROVED_PATHS_BINDING_PREFIX.length)) as unknown;
    return Array.isArray(parsed) && parsed.every((candidate) => typeof candidate === "string")
      ? canonicalApprovedPaths(parsed)
      : undefined;
  } catch {
    return undefined;
  }
}

function canonicalApprovedPaths(paths: readonly string[]): readonly string[] {
  if (paths.length === 0 || paths.length > 128) {
    throw new Error("Approved path binding must contain between 1 and 128 paths");
  }
  const canonical = paths.map((candidate) => {
    const value = candidate.replace(/\\/gu, "/").replace(/^\.\//u, "");
    if (
      !value ||
      value.length > 512 ||
      value.startsWith("/") ||
      value.startsWith("-") ||
      /^[A-Za-z]:\//u.test(value) ||
      value.split("/").some((segment) => !segment || segment === "." || segment === "..")
    ) {
      throw new Error("Approved path binding contains an unsafe path");
    }
    return value;
  });
  if (new Set(canonical).size !== canonical.length) {
    throw new Error("Approved path binding contains duplicate paths");
  }
  return canonical;
}

export function communityPromotionIdentity(
  input: unknown,
  registry: CommunityRegistry,
): { key: string; marker: string; operationId: string } {
  const finding = validateCommunityFinding(input, registry);
  const key = `intake:community:${digest(
    `${finding.sourceId}\n${finding.sourceUrl}\n${finding.originalCommunityNeed}\n` +
      JSON.stringify(finding.approvedPaths),
  )}:v2`;
  return { key, marker: executionMarker(key), operationId: operationId(key) };
}

export function isTrustedExecutionIssue(issue: GitHubIssue, exactAuthor: string): boolean {
  return (
    issue.state === "open" &&
    issue.user?.login === exactAuthor &&
    issue.labels.includes(AGENT_READY_LABEL) &&
    issue.body?.includes(EXECUTION_MARKER) === true
  );
}

export function canExecuteOriginalUserIssue(issue: GitHubIssue): boolean {
  return !issue.labels.includes(USER_SOURCE_LABEL);
}

export function isDirectUserExecutionRejected(issue: GitHubIssue): boolean {
  return !canExecuteOriginalUserIssue(issue);
}

export function assertNotDirectUserExecution(issue: GitHubIssue): void {
  if (!canExecuteOriginalUserIssue(issue)) {
    throw new Error("User-authored intake is untrusted and cannot be executed directly");
  }
}

export function validateUserIssueForPromotion(
  issue: GitHubIssue,
  acceptedLabel = MAINTAINER_ACCEPTED_LABEL,
): Readonly<Record<string, string>> {
  if (issue.state !== "open") throw new Error("User issue must be open for promotion");
  if (!issue.labels.includes(USER_SOURCE_LABEL)) {
    throw new Error(`User issue must have the ${USER_SOURCE_LABEL} label`);
  }
  if (!issue.labels.includes(acceptedLabel)) {
    throw new Error(`User issue must have the ${acceptedLabel} label`);
  }
  const fields = parseIssueFields(issue.body);
  requireOne(fields, ["problem", "userProblem", "problemStatement"], "problem");
  requireOne(
    fields,
    ["minimalReproduction", "reproduction", "minimalScenario"],
    "minimal reproduction",
  );
  requireOne(
    fields,
    ["expectedBehavior", "expected", "desiredOutcome", "acceptanceCriteria"],
    "expected outcome",
  );
  return fields;
}

export function parseCommunityRegistry(input: unknown): CommunityRegistry {
  const registry = CommunityRegistrySchema.parse(input) as CommunityRegistry;
  const ids = new Set<string>();
  for (const source of registry.sources) {
    if (ids.has(source.id)) throw new Error(`Duplicate community source id: ${source.id}`);
    ids.add(source.id);
    for (const url of sourceUrls(source)) assertSafeResearchUrl(url);
    const repository = OFFICIAL_COMMUNITY_REPOSITORIES[source.id];
    if (
      source.repository !== repository ||
      source.releases !== `${repository}/releases` ||
      source.discussions !== `${repository}/discussions`
    ) {
      throw new Error(`Community source ${source.id} does not use its official GitHub endpoints`);
    }
    if (new Set(source.topics).size !== source.topics.length) {
      throw new Error(`Duplicate capability topic for community source: ${source.id}`);
    }
  }
  const missing = COMMUNITY_SOURCE_IDS.filter((id) => !ids.has(id));
  if (missing.length > 0) throw new Error(`Community registry is missing sources: ${missing.join(", ")}`);
  return registry;
}

export function validateCommunityFinding(
  input: unknown,
  registry: CommunityRegistry,
): CommunityFinding {
  const finding = CommunityFindingSchema.parse(input);
  const source = registry.sources.find((candidate) => candidate.id === finding.sourceId);
  if (!source) throw new Error(`Community source is not registered: ${finding.sourceId}`);
  assertSafeResearchUrl(finding.sourceUrl);
  if (!sourceUrls(source).some((allowed) => isUrlWithin(finding.sourceUrl, allowed))) {
    throw new Error(`Community finding URL is not allowlisted for ${finding.sourceId}`);
  }
  return {
    ...finding,
    approvedPaths: canonicalApprovedPaths(finding.approvedPaths),
    title: requiredSanitized(finding.title, "community title", MAX_TITLE_LENGTH),
    observedVersionOrDate: requiredSanitized(
      finding.observedVersionOrDate,
      "observed version or date",
      200,
    ),
    originalCommunityNeed: requiredSanitized(
      finding.originalCommunityNeed,
      "original community need",
    ),
    productComparison: requiredSanitized(finding.productComparison, "product comparison"),
    duplicateSearchEvidence: requiredSanitized(
      finding.duplicateSearchEvidence,
      "duplicate search evidence",
    ),
  };
}

export async function scanCommunityRegistry(
  registry: CommunityRegistry,
  research: ResearchPort,
  signal?: AbortSignal,
): Promise<readonly CommunityFinding[]> {
  const findings: CommunityFinding[] = [];
  for (const source of registry.sources) {
    const results = await research.scan(source, signal);
    if (!Array.isArray(results)) throw new Error("Research port returned a non-array result");
    findings.push(...results.map((result) => validateCommunityFinding(result, registry)));
  }
  return findings;
}

export function normalizeSelfDiscoveryFinding(input: unknown): SelfDiscoveryFinding {
  const finding = SelfDiscoveryFindingSchema.parse(input);
  return {
    title: requiredSanitized(finding.title, "self-discovery title", MAX_TITLE_LENGTH),
    problemStatement: requiredSanitized(finding.problemStatement, "problem statement"),
    reproduction: requiredSanitized(finding.reproduction, "reproduction"),
    minimalScenario: requiredSanitized(finding.minimalScenario, "minimal scenario"),
    duplicateSearchEvidence: requiredSanitized(
      finding.duplicateSearchEvidence,
      "duplicate search evidence",
    ),
  };
}

export class TrustedIntake {
  readonly repository: GitHubRepositoryRef;

  constructor(private readonly dependencies: TrustedIntakeDependencies) {
    this.repository =
      dependencies.repository ?? {
        owner: dependencies.config.product.repository.owner,
        repo: dependencies.config.product.repository.name,
      };
  }

  /**
   * Reconciles intake crash windows by deterministic markers. Ambiguous writes
   * remain reserved; only a proven-absent operation with no write-began event
   * is superseded and safely attempted again.
   */
  async reconcileReservedOperations(signal?: AbortSignal): Promise<{
    reconciled: number;
    retried: number;
    inDoubt: number;
  }> {
    let reconciled = 0;
    let retried = 0;
    let inDoubt = 0;
    for (const operation of this.dependencies.store.listOperations()) {
      if (operation.state === "succeeded") {
        const issueNumber = resultIssueNumber(operation.result);
        const finding = this.dependencies.store.getGapFindingByOperationId(operation.id);
        if (
          issueNumber !== undefined &&
          finding &&
          ["retryable", "in_doubt"].includes(finding.status)
        ) {
          const result = jsonObject(operation.result ?? null);
          this.reconcileBoundGapFinding(
            operation,
            issueNumber,
            result.created === false ? "duplicate" : "promoted",
          );
          reconciled += 1;
        }
        continue;
      }
      if (
        operation.state !== "reserved" ||
        ![
          "github.create-normalized-execution-issue",
          "github.comment-promotion-link",
        ].includes(operation.kind)
      ) {
        continue;
      }
      try {
      const request = jsonObject(operation.request);
      const marker = typeof request.marker === "string" ? request.marker : undefined;
      if (!marker) {
        this.markBoundGapInDoubt(operation, "reserved operation has no reconciliation marker");
        inDoubt += 1;
        continue;
      }
      if (operation.kind === "github.create-normalized-execution-issue") {
        const lookup = await this.dependencies.github.findIssueByMarker(
          this.repository,
          marker,
          signal,
        );
        if (lookup.issue) {
          this.dependencies.store.reconcileOperation({
            idempotencyKey: operation.idempotencyKey,
            state: "succeeded",
            result: {
              issueNumber: lookup.issue.number,
              marker,
              created: this.writeBegan(operation),
            },
          });
          this.reconcileBoundGapFinding(
            operation,
            lookup.issue.number,
            this.writeBegan(operation) ? "promoted" : "duplicate",
          );
          reconciled += 1;
          continue;
        }
        if (!lookup.absenceProven || this.writeBegan(operation)) {
          this.markBoundGapInDoubt(
            operation,
            lookup.absenceProven
              ? "GitHub write began but no marker is currently visible"
              : "GitHub marker absence could not be proven",
          );
          inDoubt += 1;
          continue;
        }
        await this.retryCreateOperation(operation, request, marker, signal);
        retried += 1;
        continue;
      }
      const issueNumber = request.issueNumber;
      if (typeof issueNumber !== "number" || !Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
        inDoubt += 1;
        continue;
      }
      const lookup = await this.dependencies.github.findIssueCommentByMarker(
        this.repository,
        issueNumber,
        marker,
        signal,
      );
      if (lookup.comment) {
        this.dependencies.store.reconcileOperation({
          idempotencyKey: operation.idempotencyKey,
          state: "succeeded",
          result: { commentId: lookup.comment.id, marker },
        });
        reconciled += 1;
        continue;
      }
      if (!lookup.absenceProven || this.writeBegan(operation)) {
        inDoubt += 1;
        continue;
      }
      await this.retryCommentOperation(operation, request, marker, issueNumber, signal);
      retried += 1;
      } catch (error) {
        this.markBoundGapInDoubt(operation, "GitHub marker reconciliation was inconclusive");
        inDoubt += 1;
        this.dependencies.store.appendEvent({
          aggregateType: "operation",
          aggregateId: operation.id,
          type: "operation.reconcile-in-doubt",
          data: { error: errorMessage(error) },
        });
      }
    }
    return { reconciled, retried, inDoubt };
  }

  async promoteUserIssue(input: UserPromotionInput): Promise<PromotionResult> {
    const original = await this.dependencies.github.getIssue(
      this.repository,
      positiveIssueNumber(input.issueNumber),
      input.signal,
    );
    validateUserIssueForPromotion(original, input.acceptedLabel);
    const key = `intake:user:${this.repository.owner}/${this.repository.repo}#${original.number}:v1`;
    const marker = executionMarker(key);
    const fields = this.executionFields(input.normalizedFields, {
      sourceType: "user",
      sourceLinkOrEvidence: `${original.htmlUrl}\n${marker}`,
      parentChildRelationship: `Promoted from untrusted user issue #${original.number}.`,
    });
    return await this.promote({
      key,
      marker,
      title: input.title ?? original.title,
      fields,
      labels: [USER_SOURCE_LABEL, AGENT_READY_LABEL],
      originalIssueNumber: original.number,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  }

  async promoteCommunityFinding(input: CommunityPromotionInput): Promise<PromotionResult> {
    const finding = validateCommunityFinding(input.finding, input.registry);
    const { key, marker } = communityPromotionIdentity(finding, input.registry);
    const pathBinding = approvedPathBindingFields(finding.approvedPaths);
    const fields = this.executionFields(input.normalizedFields, {
      sourceType: "community",
      sourceLinkOrEvidence: [
        finding.sourceUrl,
        `Observed: ${finding.observedVersionOrDate}`,
        `${APPROVED_PATHS_BINDING_PREFIX}${JSON.stringify(pathBinding.approvedPaths)}`,
        marker,
      ].join("\n"),
      problemStatement: finding.originalCommunityNeed,
      scope: pathBinding.scope,
      acceptanceCriteria: pathBinding.acceptanceCriteria,
      duplicateSearchEvidence: finding.duplicateSearchEvidence,
    });
    return await this.promote({
      key,
      marker,
      title: finding.title,
      fields,
      labels: [COMMUNITY_SOURCE_LABEL, AGENT_READY_LABEL],
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  }

  async promoteSelfDiscovery(input: SelfDiscoveryPromotionInput): Promise<PromotionResult> {
    const finding = normalizeSelfDiscoveryFinding(input.finding);
    const key = `intake:self-discovery:${digest(
      `${finding.problemStatement}\n${finding.reproduction}\n${finding.minimalScenario}`,
    )}:v1`;
    const marker = executionMarker(key);
    const fields = this.executionFields(input.normalizedFields, {
      sourceType: "self-discovery",
      sourceLinkOrEvidence: [
        `Reproduction: ${finding.reproduction}`,
        `Minimal scenario: ${finding.minimalScenario}`,
        marker,
      ].join("\n"),
      problemStatement: finding.problemStatement,
      duplicateSearchEvidence: finding.duplicateSearchEvidence,
    });
    return await this.promote({
      key,
      marker,
      title: finding.title,
      fields,
      labels: [SELF_DISCOVERY_SOURCE_LABEL, AGENT_READY_LABEL],
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  }

  private executionFields(
    supplied: Readonly<Record<string, string>>,
    trustedBindings: Readonly<Record<string, string>>,
  ): Readonly<Record<string, string>> {
    const fields = {
      ...sanitizeUntrustedFields(supplied),
      ...trustedBindings,
    };
    const required = this.dependencies.config.issuePolicy.normalization.requiredFields;
    const missing = required.filter((field) => !fields[field]?.trim());
    if (missing.length > 0) {
      throw new Error(`Promotion is missing normalized fields: ${missing.join(", ")}`);
    }
    return fields;
  }

  private async promote(input: {
    key: string;
    marker: string;
    title: string;
    fields: Readonly<Record<string, string>>;
    labels: readonly string[];
    originalIssueNumber?: number;
    signal?: AbortSignal;
  }): Promise<PromotionResult> {
    const candidates = await this.dependencies.github.listCandidateIssues(
      this.repository,
      [AGENT_READY_LABEL],
      input.signal,
    );
    const duplicate = candidates.find((issue) => issue.body?.includes(input.marker));
    if (duplicate) {
      if (input.originalIssueNumber !== undefined) {
        await this.commentOnOriginal(
          input.originalIssueNumber,
          duplicate,
          input.key,
          input.signal,
        );
      }
      return {
        created: false,
        executionIssueNumber: duplicate.number,
        executionIssue: duplicate,
        idempotencyKey: input.key,
        marker: input.marker,
        operationId: operationId(input.key),
      };
    }

    const request = {
      title: requiredSanitized(input.title, "execution issue title", MAX_TITLE_LENGTH),
      fields: input.fields,
      requiredFields: this.dependencies.config.issuePolicy.normalization.requiredFields,
      labels: input.labels,
      marker: input.marker,
    };
    const reservation = this.dependencies.store.reserveOperation({
      id: operationId(input.key),
      idempotencyKey: input.key,
      kind: "github.create-normalized-execution-issue",
      request,
    });
    if (!reservation.created) {
      const issueNumber = resultIssueNumber(reservation.operation.result);
      if (issueNumber !== undefined) {
        return {
          created: false,
          executionIssueNumber: issueNumber,
          idempotencyKey: input.key,
          marker: input.marker,
          operationId: reservation.operation.id,
        };
      }
      if (this.writeBegan(reservation.operation)) {
        throw new IntakeWriteInDoubtError(
          reservation.operation.id,
          `Promotion ${input.key} has an uncertain reserved write`,
        );
      }
      throw new IntakePromotionRetryableError(
        reservation.operation.id,
        `Promotion ${input.key} is reserved and awaits reconciliation`,
      );
    }

    let created: GitHubIssue;
    try {
      this.recordWriteBegan(reservation.operation);
      created = await this.dependencies.github.createNormalizedIssue(
        this.repository,
        request,
        input.signal,
      );
      this.dependencies.store.reconcileOperation({
        idempotencyKey: input.key,
        state: "succeeded",
        result: { issueNumber: created.number, marker: input.marker, created: true },
      });
    } catch (error) {
      this.dependencies.store.appendEvent({
        aggregateType: "operation",
        aggregateId: reservation.operation.id,
        type: "operation.write-outcome-uncertain",
        data: { error: errorMessage(error) },
      });
      throw new IntakeWriteInDoubtError(
        reservation.operation.id,
        "GitHub execution issue write outcome is uncertain",
      );
    }

    if (input.originalIssueNumber !== undefined) {
      await this.commentOnOriginal(input.originalIssueNumber, created, input.key, input.signal);
    }
    return {
      created: true,
      executionIssueNumber: created.number,
      executionIssue: created,
      idempotencyKey: input.key,
      marker: input.marker,
      operationId: reservation.operation.id,
    };
  }

  private async commentOnOriginal(
    originalIssueNumber: number,
    executionIssue: GitHubIssue,
    promotionKey: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const key = `${promotionKey}:comment`;
    const marker = `<!-- one-cli:promotion-link:${digest(promotionKey)} -->`;
    const body = `Promoted to trusted execution issue #${executionIssue.number}: ${executionIssue.htmlUrl}\n\n${marker}`;
    const reservation = this.dependencies.store.reserveOperation({
      id: operationId(key),
      idempotencyKey: key,
      kind: "github.comment-promotion-link",
      request: { issueNumber: originalIssueNumber, body, marker },
    });
    if (!reservation.created) return;
    try {
      this.recordWriteBegan(reservation.operation);
      const comment = await this.dependencies.github.createComment(
        this.repository,
        originalIssueNumber,
        body,
        signal,
      );
      this.dependencies.store.reconcileOperation({
        idempotencyKey: key,
        state: "succeeded",
        result: { commentId: comment.id, marker },
      });
    } catch (error) {
      this.dependencies.store.appendEvent({
        aggregateType: "operation",
        aggregateId: reservation.operation.id,
        type: "operation.write-outcome-uncertain",
        data: { error: errorMessage(error) },
      });
      throw error;
    }
  }

  private writeBegan(operation: Operation): boolean {
    return this.dependencies.store
      .listEvents({ aggregateType: "operation", aggregateId: operation.id })
      .some((event) => event.type === "operation.write-began");
  }

  private recordWriteBegan(operation: Operation): void {
    this.dependencies.store.appendEvent({
      aggregateType: "operation",
      aggregateId: operation.id,
      type: "operation.write-began",
      data: { idempotencyKey: operation.idempotencyKey },
    });
  }

  private reconcileBoundGapFinding(
    operation: Operation,
    issueNumber: number,
    status: "promoted" | "duplicate",
  ): void {
    const finding = this.dependencies.store.getGapFindingByOperationId(operation.id);
    if (!finding) return;
    this.dependencies.store.updateGapFinding({
      fingerprint: finding.fingerprint,
      status,
      retryAfter: null,
      evidence: {
        ...jsonObject(finding.evidence),
        promotion: { status, executionIssueNumber: issueNumber, operationId: operation.id },
      },
    });
  }

  private markBoundGapInDoubt(operation: Operation, reason: string): void {
    const finding = this.dependencies.store.getGapFindingByOperationId(operation.id);
    if (!finding || ["promoted", "duplicate", "blocked", "rejected", "expired"].includes(finding.status)) {
      return;
    }
    this.dependencies.store.updateGapFinding({
      fingerprint: finding.fingerprint,
      status: "in_doubt",
      retryAfter: null,
      evidence: {
        ...jsonObject(finding.evidence),
        promotion: { status: "in_doubt", operationId: operation.id, reason },
      },
    });
  }

  private async retryCreateOperation(
    original: Operation,
    request: Record<string, JsonValue>,
    marker: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const retry = this.dependencies.store.reserveOperation({
      id: `${original.id}-retry`,
      idempotencyKey: `${original.idempotencyKey}:retry:${original.id}`,
      kind: original.kind,
      request: { ...request, originalOperationId: original.id },
    });
    const boundFinding = this.dependencies.store.getGapFindingByOperationId(original.id);
    if (boundFinding) {
      this.dependencies.store.updateGapFinding({
        fingerprint: boundFinding.fingerprint,
        status: "retryable",
        operationId: retry.operation.id,
        retryAfter: null,
        evidence: {
          ...jsonObject(boundFinding.evidence),
          promotion: {
            status: "retryable",
            operationId: retry.operation.id,
            supersedesOperationId: original.id,
          },
        },
      });
    }
    this.dependencies.store.reconcileOperation({
      idempotencyKey: original.idempotencyKey,
      state: "failed",
      error: `Safely superseded by ${retry.operation.id}`,
    });
    if (!retry.created) return;
    const fields = stringRecord(request.fields);
    const requiredFields = stringArray(request.requiredFields);
    const labels = stringArray(request.labels);
    if (typeof request.title !== "string") throw new Error("Reserved intake title is invalid");
    this.recordWriteBegan(retry.operation);
    try {
      const issue = await this.dependencies.github.createNormalizedIssue(
        this.repository,
        { title: request.title, fields, requiredFields, labels },
        signal,
      );
      this.dependencies.store.reconcileOperation({
        idempotencyKey: retry.operation.idempotencyKey,
        state: "succeeded",
        result: { issueNumber: issue.number, marker, originalOperationId: original.id },
      });
      this.reconcileBoundGapFinding(retry.operation, issue.number, "promoted");
    } catch (error) {
      this.dependencies.store.appendEvent({
        aggregateType: "operation",
        aggregateId: retry.operation.id,
        type: "operation.write-outcome-uncertain",
        data: { error: errorMessage(error) },
      });
      const finding = this.dependencies.store.getGapFindingByOperationId(retry.operation.id);
      if (finding) {
        this.dependencies.store.updateGapFinding({
          fingerprint: finding.fingerprint,
          status: "in_doubt",
          evidence: {
            ...jsonObject(finding.evidence),
            promotion: {
              status: "in_doubt",
              operationId: retry.operation.id,
              reason: "GitHub retry write outcome is uncertain",
            },
          },
        });
      }
    }
  }

  private async retryCommentOperation(
    original: Operation,
    request: Record<string, JsonValue>,
    marker: string,
    issueNumber: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const retry = this.dependencies.store.reserveOperation({
      id: `${original.id}-retry`,
      idempotencyKey: `${original.idempotencyKey}:retry:${original.id}`,
      kind: original.kind,
      request: { ...request, originalOperationId: original.id },
    });
    this.dependencies.store.reconcileOperation({
      idempotencyKey: original.idempotencyKey,
      state: "failed",
      error: `Safely superseded by ${retry.operation.id}`,
    });
    if (!retry.created) return;
    if (typeof request.body !== "string") throw new Error("Reserved intake comment is invalid");
    this.recordWriteBegan(retry.operation);
    try {
      const comment = await this.dependencies.github.createComment(
        this.repository,
        issueNumber,
        request.body,
        signal,
      );
      this.dependencies.store.reconcileOperation({
        idempotencyKey: retry.operation.idempotencyKey,
        state: "succeeded",
        result: { commentId: comment.id, marker, originalOperationId: original.id },
      });
    } catch (error) {
      this.dependencies.store.appendEvent({
        aggregateType: "operation",
        aggregateId: retry.operation.id,
        type: "operation.write-outcome-uncertain",
        data: { error: errorMessage(error) },
      });
    }
  }
}

export function createTrustedIntake(dependencies: TrustedIntakeDependencies): TrustedIntake {
  return new TrustedIntake(dependencies);
}

function parseIssueFields(body: string | null): Readonly<Record<string, string>> {
  if (!body) throw new Error("User issue must contain complete structured fields");
  const headings = [...body.matchAll(/^##\s+(.+?)\s*$/gmu)];
  const fields: Record<string, string> = {};
  for (let index = 0; index < headings.length; index++) {
    const heading = headings[index]!;
    const key = toFieldName(heading[1]!);
    const start = (heading.index ?? 0) + heading[0].length;
    const end = headings[index + 1]?.index ?? body.length;
    const value = requiredSanitized(body.slice(start, end), heading[1]!);
    fields[key] = value;
  }
  return fields;
}

function requireOne(
  fields: Readonly<Record<string, string>>,
  candidates: readonly string[],
  label: string,
): void {
  if (!candidates.some((candidate) => Boolean(fields[candidate]?.trim()))) {
    throw new Error(`User issue is missing a complete ${label} field`);
  }
}

function toFieldName(heading: string): string {
  const words = heading.normalize("NFKC").match(/[A-Za-z0-9]+/gu) ?? [];
  return words
    .map((word, index) =>
      index === 0
        ? word.toLowerCase()
        : `${word[0]?.toUpperCase() ?? ""}${word.slice(1).toLowerCase()}`,
    )
    .join("");
}

function requiredSanitized(value: string, label: string, maxLength = MAX_FIELD_LENGTH): string {
  const sanitized = sanitizeUntrustedText(value, maxLength);
  if (!sanitized) throw new Error(`${label} is empty after unsafe content is removed`);
  return sanitized;
}

function sourceUrls(source: CommunitySource): string[] {
  return [source.repository, source.documentation.url, source.releases, source.discussions];
}

function assertSafeResearchUrl(value: string): void {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    throw new Error(`Community URL must be a credential-free HTTPS URL: ${value}`);
  }
}

function isUrlWithin(candidateValue: string, allowedValue: string): boolean {
  const candidate = new URL(candidateValue);
  const allowed = new URL(allowedValue);
  const allowedPath = allowed.pathname.replace(/\/+$/u, "");
  return (
    candidate.origin === allowed.origin &&
    (candidate.pathname === allowedPath ||
      candidate.pathname.startsWith(`${allowedPath}/`) ||
      (allowedPath === "" && candidate.pathname.startsWith("/")))
  );
}

function positiveIssueNumber(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Issue number must be positive");
  return value;
}

function operationId(key: string): string {
  return `intake-${digest(key).slice(0, 24)}`;
}

function digest(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function resultIssueNumber(value: unknown): number | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const issueNumber = (value as Record<string, unknown>).issueNumber;
  return typeof issueNumber === "number" && Number.isSafeInteger(issueNumber) && issueNumber > 0
    ? issueNumber
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000);
}

function jsonObject(value: JsonValue): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, JsonValue>) }
    : {};
}

function stringArray(value: JsonValue | undefined): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function stringRecord(value: JsonValue | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, nested] of Object.entries(jsonObject(value ?? null))) {
    if (typeof nested === "string") result[key] = nested;
  }
  return result;
}

// Exported for integrations that want to preflight the exact normalized shape.
export function hasCompleteNormalizedFields(
  issue: GitHubIssue,
  config: AutonomyConfig,
): boolean {
  return (
    normalizedIssueFields(issue, config.issuePolicy.normalization.requiredFields) !== undefined
  );
}
