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
  id: string;
  name: string;
  trust: "official-primary";
  repository?: string;
  documentation?: string;
  releases?: string;
  discussions?: string;
}

export interface CommunityRegistry {
  schema: "autonomy.one-cli/v1";
  registeredSourcesOnly: true;
  allowedSourceTypes: readonly (
    | "official-repository"
    | "official-documentation"
    | "official-releases"
    | "official-discussions"
  )[];
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
    id: z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9._-]*$/u),
    name: z.string().min(1).max(200),
    trust: z.literal("official-primary"),
    repository: z.url().optional(),
    documentation: z.url().optional(),
    releases: z.url().optional(),
    discussions: z.url().optional(),
  })
  .strict()
  .refine(
    (source) =>
      source.repository !== undefined ||
      source.documentation !== undefined ||
      source.releases !== undefined ||
      source.discussions !== undefined,
    "Community source must declare at least one allowlisted URL",
  );

const CommunityRegistrySchema = z
  .object({
    schema: z.literal("autonomy.one-cli/v1"),
    registeredSourcesOnly: z.literal(true),
    allowedSourceTypes: z
      .array(
        z.enum([
          "official-repository",
          "official-documentation",
          "official-releases",
          "official-discussions",
        ]),
      )
      .min(1),
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
    sources: z.array(CommunitySourceSchema).min(1),
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
    const value = sanitizeUntrustedText(fields[key] ?? "", Math.min(MAX_FIELD_LENGTH, remaining));
    if (value) {
      sanitized[key] = value;
      remaining -= value.length;
    }
  }
  return sanitized;
}

export function executionMarker(idempotencyKey: string): string {
  return `${EXECUTION_MARKER}\n<!-- one-cli:idempotency:${digest(idempotencyKey)} -->`;
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
  }
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
            result: { issueNumber: lookup.issue.number, marker },
          });
          reconciled += 1;
          continue;
        }
        if (!lookup.absenceProven || this.writeBegan(operation)) {
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
    const key = `intake:community:${digest(
      `${finding.sourceId}\n${finding.sourceUrl}\n${finding.originalCommunityNeed}`,
    )}:v1`;
    const marker = executionMarker(key);
    const fields = this.executionFields(input.normalizedFields, {
      sourceType: "community",
      sourceLinkOrEvidence: [
        finding.sourceUrl,
        `Observed: ${finding.observedVersionOrDate}`,
        marker,
      ].join("\n"),
      problemStatement: finding.originalCommunityNeed,
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
        };
      }
      throw new Error(`Promotion ${input.key} is already reserved and requires reconciliation`);
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
        result: { issueNumber: created.number, marker: input.marker },
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

    if (input.originalIssueNumber !== undefined) {
      await this.commentOnOriginal(input.originalIssueNumber, created, input.key, input.signal);
    }
    return {
      created: true,
      executionIssueNumber: created.number,
      executionIssue: created,
      idempotencyKey: input.key,
      marker: input.marker,
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
    } catch (error) {
      this.dependencies.store.appendEvent({
        aggregateType: "operation",
        aggregateId: retry.operation.id,
        type: "operation.write-outcome-uncertain",
        data: { error: errorMessage(error) },
      });
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
  return [source.repository, source.documentation, source.releases, source.discussions].filter(
    (value): value is string => value !== undefined,
  );
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
