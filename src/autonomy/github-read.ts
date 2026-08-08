import { sanitizeUntrustedText } from "./intake.js";
import {
  GitHubGraphqlError,
  type GitHubGraphqlTransport,
} from "./github-graphql.js";
import {
  GitHubHttpError,
  GitHubRestProjection,
  type GitHubRepositoryRef,
  type GitHubTransport,
} from "./github.js";

export interface GitHubReadLimits {
  maxCallsGlobal?: number;
  maxCallsPerSource?: number;
  maxPages?: number;
  maxCommits?: number;
  maxFiles?: number;
  maxReleases?: number;
  maxDiscussions?: number;
  maxBodyBytes?: number;
  maxBodyBytesPerItem?: number;
}

interface ResolvedLimits {
  maxCallsGlobal: number;
  maxCallsPerSource: number;
  maxPages: number;
  maxCommits: number;
  maxFiles: number;
  maxReleases: number;
  maxDiscussions: number;
  maxBodyBytes: number;
  maxBodyBytesPerItem: number;
}

export interface GitHubRepositoryState {
  repository: GitHubRepositoryRef;
  repositoryUrl: string;
  defaultBranch: string;
  sha: string;
}

export interface GitHubCommitDelta {
  sha: string;
  message: string;
  sourceUrl: string;
  committedAt: number;
}

export interface GitHubCompareDelta {
  oldSha: string;
  newSha: string;
  commits: readonly GitHubCommitDelta[];
  files: readonly string[];
  truncated: boolean;
  nextPage?: number;
}

export interface GitHubReleaseRead {
  id: string;
  tag: string;
  title: string;
  body: string;
  sourceUrl: string;
  publishedAt: number;
}

export interface GitHubDiscussionRead {
  id: string;
  number: number;
  title: string;
  body: string;
  sourceUrl: string;
  observedAt: number;
}

export interface GitHubReadListing<T> {
  available: boolean;
  items: readonly T[];
  truncated: boolean;
  nextPage?: number;
  nextCursor?: string;
}

export class GitHubReadTransientError extends Error {
  readonly transient = true;

  constructor(
    message: string,
    readonly cause: unknown,
  ) {
    super(message);
    this.name = "GitHubReadTransientError";
  }
}

export class GitHubReadBudget {
  private globalCalls = 0;
  private readonly sourceCalls = new Map<string, number>();
  private bodyBytes = 0;

  constructor(private readonly limits: ResolvedLimits) {}

  consumeCall(sourceId: string): void {
    const sourceCalls = this.sourceCalls.get(sourceId) ?? 0;
    if (this.globalCalls >= this.limits.maxCallsGlobal) {
      throw new Error("GitHub research global call limit exceeded");
    }
    if (sourceCalls >= this.limits.maxCallsPerSource) {
      throw new Error(`GitHub research call limit exceeded for ${sourceId}`);
    }
    this.globalCalls += 1;
    this.sourceCalls.set(sourceId, sourceCalls + 1);
  }

  sanitizeBody(value: string): string {
    const remaining = this.limits.maxBodyBytes - this.bodyBytes;
    if (remaining <= 0) return "";
    const itemLimit = Math.min(remaining, this.limits.maxBodyBytesPerItem);
    const bounded = truncateUtf8(value, itemLimit);
    const sanitized = sanitizeUntrustedText(bounded, bounded.length || 1);
    const result = truncateUtf8(sanitized, itemLimit);
    this.bodyBytes += Buffer.byteLength(result, "utf8");
    return result;
  }
}

const DISCUSSIONS_QUERY = `
  query OneCliResearchDiscussions(
    $owner: String!
    $name: String!
    $first: Int!
    $after: String
  ) {
    repository(owner: $owner, name: $name) {
      discussions(first: $first, after: $after, orderBy: {field: UPDATED_AT, direction: DESC}) {
        nodes {
          id
          number
          title
          bodyText
          url
          createdAt
          updatedAt
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

export class GitHubReadClient {
  private readonly limits: ResolvedLimits;

  constructor(
    private readonly rest: GitHubTransport,
    private readonly graphql: GitHubGraphqlTransport,
    limits: GitHubReadLimits = {},
  ) {
    this.limits = resolveLimits(limits);
  }

  createBudget(): GitHubReadBudget {
    return new GitHubReadBudget(this.limits);
  }

  async getRepositoryState(
    sourceId: string,
    repositoryUrl: string,
    budget: GitHubReadBudget,
    signal?: AbortSignal,
  ): Promise<GitHubRepositoryState> {
    const repository = parseGitHubRepositoryUrl(repositoryUrl);
    const basePath = repositoryPath(repository);
    const value = record(
      await this.restRequest(sourceId, budget, {
        method: "GET",
        path: basePath,
        ...(signal === undefined ? {} : { signal }),
      }),
      "repository",
    );
    const defaultBranch = checkedBranch(string(value.default_branch, "default branch"));
    const commit = record(
      await this.restRequest(sourceId, budget, {
        method: "GET",
        path: `${basePath}/commits/${encodePath(defaultBranch)}`,
        ...(signal === undefined ? {} : { signal }),
      }),
      "repository head",
    );
    return {
      repository,
      repositoryUrl: canonicalRepositoryUrl(repository),
      defaultBranch,
      sha: checkedSha(string(commit.sha, "repository head SHA")),
    };
  }

  async compare(
    sourceId: string,
    state: GitHubRepositoryState,
    oldShaValue: string,
    budget: GitHubReadBudget,
    signal?: AbortSignal,
    startPage = 1,
  ): Promise<GitHubCompareDelta> {
    const oldSha = checkedSha(oldShaValue);
    const newSha = checkedSha(state.sha);
    const commits: GitHubCommitDelta[] = [];
    const files: string[] = [];
    let page = positiveInteger(startPage, "compare start page");
    let truncated = false;
    while (page - startPage < this.limits.maxPages && commits.length < this.limits.maxCommits) {
      const perPage = Math.min(100, this.limits.maxCommits - commits.length);
      const value = record(
        await this.restRequest(sourceId, budget, {
          method: "GET",
          path:
            `${repositoryPath(state.repository)}/compare/${oldSha}...${newSha}` +
            `?per_page=${perPage}&page=${page}`,
          ...(signal === undefined ? {} : { signal }),
        }),
        "compare response",
      );
      const rawCommits = array(value.commits, "compare commits");
      for (const rawCommit of rawCommits.slice(0, this.limits.maxCommits - commits.length)) {
        const commit = record(rawCommit, "compare commit");
        const details = record(commit.commit, "compare commit details");
        const committer =
          details.committer === null
            ? record(details.author, "compare commit author")
            : record(details.committer, "compare commit committer");
        const sha = checkedSha(string(commit.sha, "compare commit SHA"));
        const message = budget.sanitizeBody(string(details.message, "compare commit message"));
        commits.push({
          sha,
          message,
          sourceUrl: assertUrlWithin(
            string(commit.html_url, "compare commit URL"),
            state.repositoryUrl,
          ),
          committedAt: parseTimestamp(string(committer.date, "compare commit date")),
        });
      }
      if (page === 1 && value.files !== undefined) {
        const rawFiles = array(value.files, "compare files");
        for (const rawFile of rawFiles.slice(0, this.limits.maxFiles)) {
          files.push(sanitizePath(string(record(rawFile, "compare file").filename, "file path")));
        }
        if (rawFiles.length > this.limits.maxFiles) truncated = true;
      }
      if (rawCommits.length < perPage) break;
      page += 1;
    }
    if (
      commits.length >= this.limits.maxCommits ||
      page - startPage >= this.limits.maxPages
    ) {
      truncated = true;
    }
    return {
      oldSha,
      newSha,
      commits,
      files,
      truncated,
      ...(truncated ? { nextPage: page } : {}),
    };
  }

  async listRecentReleases(
    sourceId: string,
    state: GitHubRepositoryState,
    releasesUrl: string,
    budget: GitHubReadBudget,
    signal?: AbortSignal,
    startPage = 1,
  ): Promise<GitHubReadListing<GitHubReleaseRead>> {
    assertExactKindUrl(releasesUrl, state.repositoryUrl, "releases");
    const items: GitHubReleaseRead[] = [];
    let page = positiveInteger(startPage, "release start page");
    let truncated = false;
    try {
      while (
        page - startPage < this.limits.maxPages &&
        items.length < this.limits.maxReleases
      ) {
        const perPage = Math.min(100, this.limits.maxReleases - items.length);
        const value = await this.restRequest(sourceId, budget, {
          method: "GET",
          path: `${repositoryPath(state.repository)}/releases?per_page=${perPage}&page=${page}`,
          projection: GitHubRestProjection.ReleaseListMetadata,
          ...(signal === undefined ? {} : { signal }),
        });
        const rawReleases = array(value, "releases");
        for (const rawRelease of rawReleases.slice(0, this.limits.maxReleases - items.length)) {
          const release = record(rawRelease, "release");
          const tag = sanitizeMetadata(string(release.tag_name, "release tag"), 200);
          const rawName = release.name === null ? "" : string(release.name, "release name");
          const title = budget.sanitizeBody(rawName) || tag || "GitHub release";
          const body = budget.sanitizeBody(
            release.body === null ? "" : string(release.body, "release body"),
          );
          items.push({
            id: stableId(release.node_id ?? release.id, "release id"),
            tag,
            title,
            body,
            sourceUrl: assertUrlWithin(
              string(release.html_url, "release URL"),
              releasesUrl,
            ),
            publishedAt: parseTimestamp(
              string(release.published_at ?? release.created_at, "release timestamp"),
            ),
          });
        }
        if (rawReleases.length < perPage) break;
        page += 1;
      }
      if (
        items.length >= this.limits.maxReleases ||
        page - startPage >= this.limits.maxPages
      ) {
        truncated = true;
      }
      return {
        available: true,
        items,
        truncated,
        ...(truncated ? { nextPage: page } : {}),
      };
    } catch (error) {
      if (error instanceof GitHubHttpError && error.status === 404) {
        return { available: false, items: [], truncated: false };
      }
      throw classifyTransient(error);
    }
  }

  async listRecentDiscussions(
    sourceId: string,
    state: GitHubRepositoryState,
    discussionsUrl: string,
    budget: GitHubReadBudget,
    signal?: AbortSignal,
    startCursor: string | null = null,
  ): Promise<GitHubReadListing<GitHubDiscussionRead>> {
    assertExactKindUrl(discussionsUrl, state.repositoryUrl, "discussions");
    const items: GitHubDiscussionRead[] = [];
    let cursor: string | null = startCursor;
    let page = 1;
    let truncated = false;
    let hasMore = false;
    try {
      while (page <= this.limits.maxPages && items.length < this.limits.maxDiscussions) {
        const first = Math.min(100, this.limits.maxDiscussions - items.length);
        budget.consumeCall(sourceId);
        const data = record(
          await this.graphql.request({
            query: DISCUSSIONS_QUERY,
            variables: {
              owner: state.repository.owner,
              name: state.repository.repo,
              first,
              after: cursor,
            },
            ...(signal === undefined ? {} : { signal }),
          }),
          "discussions data",
        );
        if (data.repository === null) {
          return { available: false, items: [], truncated: false };
        }
        const repository = record(data.repository, "discussions repository");
        if (repository.discussions === null) {
          return { available: false, items: [], truncated: false };
        }
        const connection = record(repository.discussions, "discussions connection");
        const nodes = array(connection.nodes, "discussion nodes");
        for (const rawNode of nodes.slice(0, this.limits.maxDiscussions - items.length)) {
          const discussion = record(rawNode, "discussion");
          const numberValue = positiveInteger(discussion.number, "discussion number");
          const title = budget.sanitizeBody(string(discussion.title, "discussion title"));
          const body = budget.sanitizeBody(string(discussion.bodyText, "discussion body"));
          items.push({
            id: stableId(discussion.id, "discussion id"),
            number: numberValue,
            title: title || `Discussion #${numberValue}`,
            body,
            sourceUrl: assertUrlWithin(
              string(discussion.url, "discussion URL"),
              discussionsUrl,
            ),
            observedAt: parseTimestamp(
              string(discussion.updatedAt ?? discussion.createdAt, "discussion timestamp"),
            ),
          });
        }
        const pageInfo = record(connection.pageInfo, "discussion page info");
        const hasNextPage = boolean(pageInfo.hasNextPage, "discussion hasNextPage");
        hasMore = hasNextPage;
        if (!hasNextPage) break;
        cursor =
          pageInfo.endCursor === null
            ? null
            : string(pageInfo.endCursor, "discussion end cursor");
        if (!cursor) throw new Error("GitHub discussions hasNextPage without an end cursor");
        page += 1;
      }
      if (hasMore && (items.length >= this.limits.maxDiscussions || page > this.limits.maxPages)) {
        truncated = true;
      }
      return {
        available: true,
        items,
        truncated,
        ...(truncated && cursor ? { nextCursor: cursor } : {}),
      };
    } catch (error) {
      if (
        (error instanceof GitHubHttpError && error.status === 404) ||
        (error instanceof GitHubGraphqlError &&
          error.errors.some(
            (detail) =>
              detail.path?.[0] === "repository" &&
              detail.path[1] === "discussions" &&
              ["FORBIDDEN", "NOT_FOUND"].includes(detail.type ?? ""),
          ))
      ) {
        return { available: false, items: [], truncated: false };
      }
      throw classifyTransient(error);
    }
  }

  private async restRequest(
    sourceId: string,
    budget: GitHubReadBudget,
    request: Parameters<GitHubTransport["request"]>[0],
  ): Promise<unknown> {
    budget.consumeCall(sourceId);
    try {
      return await this.rest.request(request);
    } catch (error) {
      throw classifyTransient(error);
    }
  }
}

export function parseGitHubRepositoryUrl(value: string): GitHubRepositoryRef {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("GitHub repository URL is invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "github.com" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  ) {
    throw new Error("GitHub repository URL must be a credential-free github.com HTTPS URL");
  }
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 2 || (url.pathname.endsWith("/") && url.pathname !== "/")) {
    throw new Error("GitHub repository URL must contain exactly owner and repository");
  }
  const [owner, repo] = segments.map((segment) => checkedSlug(decodePathSegment(segment!)));
  return { owner: owner!, repo: repo! };
}

function resolveLimits(input: GitHubReadLimits): ResolvedLimits {
  const resolved = {
    maxCallsGlobal: input.maxCallsGlobal ?? 16,
    maxCallsPerSource: input.maxCallsPerSource ?? 16,
    maxPages: input.maxPages ?? 2,
    maxCommits: input.maxCommits ?? 100,
    maxFiles: input.maxFiles ?? 100,
    maxReleases: input.maxReleases ?? 25,
    maxDiscussions: input.maxDiscussions ?? 25,
    maxBodyBytes: input.maxBodyBytes ?? 256 * 1024,
    maxBodyBytesPerItem: input.maxBodyBytesPerItem ?? 16 * 1024,
  };
  for (const [label, value] of Object.entries(resolved)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`GitHub read ${label} must be a positive integer`);
    }
  }
  return resolved;
}

function classifyTransient(error: unknown): unknown {
  if (error instanceof GitHubReadTransientError) return error;
  if (
    error instanceof GitHubHttpError &&
    (error.status >= 500 ||
      (error.status === 403 && /\b(?:rate limit|secondary rate)\b/iu.test(error.message)))
  ) {
    return new GitHubReadTransientError(`Transient GitHub failure: ${error.message}`, error);
  }
  if (
    error instanceof GitHubGraphqlError &&
    error.errors.some(
      (detail) =>
        detail.type === "RATE_LIMITED" || /\b(?:rate limit|secondary rate)\b/iu.test(detail.message),
    )
  ) {
    return new GitHubReadTransientError(`Transient GitHub GraphQL failure: ${error.message}`, error);
  }
  return error;
}

function repositoryPath(repository: GitHubRepositoryRef): string {
  return `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`;
}

function canonicalRepositoryUrl(repository: GitHubRepositoryRef): string {
  return `https://github.com/${repository.owner}/${repository.repo}`;
}

function assertExactKindUrl(value: string, repositoryUrl: string, kind: string): void {
  const expected = `${repositoryUrl}/${kind}`;
  if (value !== expected) throw new Error(`GitHub ${kind} URL does not match the repository`);
}

function assertUrlWithin(value: string, allowedValue: string): string {
  const candidate = safeUrl(value);
  const allowed = safeUrl(allowedValue);
  const allowedPath = allowed.pathname.replace(/\/+$/u, "");
  if (
    candidate.origin !== allowed.origin ||
    (candidate.pathname !== allowedPath && !candidate.pathname.startsWith(`${allowedPath}/`))
  ) {
    throw new Error("GitHub source URL escaped its registered prefix");
  }
  return candidate.toString();
}

function safeUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "github.com" ||
    url.username ||
    url.password ||
    url.port
  ) {
    throw new Error("GitHub source URL is not a safe github.com HTTPS URL");
  }
  if (/%(?:2e|2f|5c)/iu.test(url.pathname) || url.pathname.includes("\\")) {
    throw new Error("GitHub source URL contains encoded path traversal");
  }
  const decoded = decodeURIComponent(url.pathname);
  if (decoded.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new Error("GitHub source URL contains path traversal");
  }
  url.hash = "";
  return url;
}

function checkedSlug(value: string): string {
  if (!/^[A-Za-z0-9_.-]+$/u.test(value) || value === "." || value === "..") {
    throw new Error("GitHub repository URL has an invalid slug");
  }
  return value;
}

function checkedBranch(value: string): string {
  if (
    !value ||
    value.startsWith("-") ||
    value.includes("..") ||
    value.includes("@{") ||
    /[\0-\x20~^:?*[\]\\]/u.test(value)
  ) {
    throw new Error("GitHub default branch is invalid");
  }
  return value;
}

function checkedSha(value: string): string {
  if (!/^[a-fA-F0-9]{40}$/u.test(value)) {
    throw new Error("GitHub SHA must be an exact 40-character object id");
  }
  return value.toLowerCase();
}

function stableId(value: unknown, label: string): string {
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0))
  ) {
    throw new Error(`GitHub ${label} is invalid`);
  }
  const result = String(value);
  if (!result || result.length > 512 || /[\0\r\n]/u.test(result)) {
    throw new Error(`GitHub ${label} is invalid`);
  }
  return result;
}

function sanitizeMetadata(value: string, limit: number): string {
  return sanitizeUntrustedText(value, limit).replace(/\s+/gu, " ").trim();
}

function sanitizePath(value: string): string {
  const result = value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/gu, "")
    .slice(0, 512)
    .trim();
  if (!result) throw new Error("GitHub compare file path is empty after sanitization");
  return result;
}

function parseTimestamp(value: string): number {
  const result = Date.parse(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error("GitHub timestamp is invalid");
  return result;
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  return bytes.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD$/u, "");
}

function decodePathSegment(value: string): string {
  if (/%(?:2e|2f|5c)/iu.test(value)) throw new Error("GitHub repository URL is encoded unsafely");
  return decodeURIComponent(value);
}

function encodePath(value: string): string {
  return value.split("/").map(encodeURIComponent).join("/");
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`GitHub ${label} is not an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`GitHub ${label} is not an array`);
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`GitHub ${label} is not a string`);
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`GitHub ${label} is not a boolean`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`GitHub ${label} is not a positive integer`);
  }
  return value;
}
