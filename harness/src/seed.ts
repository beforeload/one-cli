import type { GitHubPort, HostIssue } from "./github.js";
import {
  childBody,
  parentBody,
  assertRoadmapParent,
  type Roadmap,
  type RoadmapChild,
} from "./roadmap.js";
import {
  seedOperationId,
  type SeedOperationStore,
} from "./seed-state.js";

export interface SeedAction {
  kind: "create" | "update";
  target: "parent" | string;
  issueNumber?: number;
  title: string;
  labels: readonly string[];
}

export interface SeedResult {
  dryRun: boolean;
  actions: readonly SeedAction[];
  parentNumber?: number;
  childNumbers: Readonly<Record<string, number>>;
}

export async function seedRoadmap(input: {
  roadmap: Roadmap;
  github: GitHubPort;
  apply?: boolean;
  maxMutations?: number;
  activeChildId?: string | null;
  preserveClosedParent?: boolean;
  operations?: SeedOperationStore;
  signal?: AbortSignal;
}): Promise<SeedResult> {
  const apply = input.apply ?? false;
  const maxMutations = input.maxMutations ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(maxMutations) || maxMutations < 0) {
    throw new Error("Seed mutation limit must be a non-negative integer");
  }
  let mutations = 0;
  const actions: SeedAction[] = [];
  let parent = await findSeedIssue(
    input.github,
    input.operations,
    input.roadmap.parent.seedMarker,
    "parent",
    input.signal,
  );
  let persistedParentNumber = parent?.number;
  const desiredParent = {
    title: input.roadmap.parent.title,
    body: parentBody(input.roadmap),
    labels: [...input.roadmap.parent.labels],
  };
  if (parent) assertRoadmapParent(parent, input.roadmap);
  if (!parent) {
    const action: SeedAction = {
      kind: "create",
      target: "parent",
      title: desiredParent.title,
      labels: desiredParent.labels,
    };
    actions.push(action);
    if (apply && mutations < maxMutations) {
      parent = await createSeedIssue(
        input.github,
        input.operations,
        input.roadmap.parent.seedMarker,
        "parent",
        desiredParent,
        input.signal,
      );
      persistedParentNumber = parent.number;
      mutations++;
    } else {
      if (apply) return { dryRun: false, actions, childNumbers: {} };
      parent = {
        number: 1,
        title: desiredParent.title,
        body: desiredParent.body,
        labels: desiredParent.labels,
        state: "open",
        htmlUrl: "",
      };
    }
  } else if (
    parent.state !== "closed" &&
    !sameIssue(parent, desiredParent, "open")
  ) {
    actions.push({
      kind: "update",
      target: "parent",
      issueNumber: parent.number,
      title: desiredParent.title,
      labels: desiredParent.labels,
    });
    if (apply && mutations < maxMutations) {
      parent = await input.github.updateIssue(
        parent.number,
        {
          title: desiredParent.title,
          state: "open",
          body: desiredParent.body,
          labels: desiredParent.labels,
        },
        input.signal,
      );
      mutations++;
    } else {
      return {
        dryRun: !apply,
        actions,
        parentNumber: parent.number,
        childNumbers: {},
      };
    }
  }

  const childNumbers: Record<string, number> = {};
  const found: Array<{ child: RoadmapChild; issue?: HostIssue }> = [];
  for (const child of input.roadmap.children) {
    const issue = await findSeedIssue(
      input.github,
      input.operations,
      child.seedMarker,
      child.id,
      input.signal,
    );
    if (issue) childNumbers[child.id] = issue.number;
    found.push({ child, ...(issue ? { issue } : {}) });
  }
  if (
    parent.state === "closed" &&
    (found.some((entry) => entry.issue === undefined || entry.issue.state !== "closed"))
  ) {
    throw new Error(
      "Closed roadmap parent is inconsistent with child closure; refusing seed mutation",
    );
  }
  const activeIndex =
    input.activeChildId === undefined
      ? firstUndeliveredIndex(found)
      : input.activeChildId === null
        ? -1
        : found.findIndex((entry) => entry.child.id === input.activeChildId);
  if (input.activeChildId !== undefined && input.activeChildId !== null && activeIndex < 0) {
    throw new Error(`Unknown active roadmap child: ${input.activeChildId}`);
  }
  const unexpectedReady = found.filter(
    (entry, index) =>
      entry.issue?.labels.includes("agent-ready") === true &&
      (index !== activeIndex || entry.issue.state !== "open"),
  );
  for (const entry of unexpectedReady) {
    const issue = entry.issue!;
    const labels = issue.labels.filter((label) => label !== "agent-ready");
    actions.push({
      kind: "update",
      target: entry.child.id,
      issueNumber: issue.number,
      title: issue.title,
      labels,
    });
    if (apply && mutations < maxMutations) {
      await input.github.updateIssue(issue.number, { labels }, input.signal);
      mutations++;
    }
  }
  if (apply && unexpectedReady.length > 0) {
    return {
      dryRun: false,
      actions,
      ...(persistedParentNumber === undefined ? {} : { parentNumber: persistedParentNumber }),
      childNumbers,
    };
  }
  for (const [index, entry] of found.entries()) {
    const retainExpectedReady =
      index === activeIndex &&
      entry.issue?.state === "open" &&
      entry.issue.labels.includes("agent-ready");
    const labels = [
      ...entry.child.labels,
      ...(retainExpectedReady ? ["agent-ready"] : []),
    ];
    const desired = {
      title: entry.child.title,
      body: childBody(entry.child, parent.number),
      labels,
    };
    if (!entry.issue) {
      actions.push({
        kind: "create",
        target: entry.child.id,
        title: desired.title,
        labels,
      });
      if (apply && mutations < maxMutations) {
        const created = await createSeedIssue(
          input.github,
          input.operations,
          entry.child.seedMarker,
          entry.child.id,
          desired,
          input.signal,
        );
        childNumbers[entry.child.id] = created.number;
        mutations++;
      } else if (apply) {
        break;
      }
      continue;
    }
    const desiredState = entry.issue.state;
    if (!sameIssue(entry.issue, desired, desiredState)) {
      actions.push({
        kind: "update",
        target: entry.child.id,
        issueNumber: entry.issue.number,
        title: desired.title,
        labels,
      });
      if (apply && mutations < maxMutations) {
        await input.github.updateIssue(
          entry.issue.number,
          { title: desired.title, body: desired.body, labels },
          input.signal,
        );
        mutations++;
      } else if (apply) {
        break;
      }
    }
  }
  if (apply && actions.length > 0) {
    return {
      dryRun: false,
      actions,
      ...(persistedParentNumber === undefined ? {} : { parentNumber: persistedParentNumber }),
      childNumbers,
    };
  }
  const active = activeIndex < 0 ? undefined : found[activeIndex];
  if (
    active?.issue &&
    active.issue.state === "open" &&
    !active.issue.labels.includes("agent-ready")
  ) {
    const labels = [...active.child.labels, "agent-ready"];
    actions.push({
      kind: "update",
      target: active.child.id,
      issueNumber: active.issue.number,
      title: active.child.title,
      labels,
    });
    if (apply && mutations < maxMutations) {
      await input.github.updateIssue(active.issue.number, { labels }, input.signal);
      mutations++;
    }
  }
  return {
    dryRun: !apply,
    actions,
    ...(persistedParentNumber === undefined ? {} : { parentNumber: persistedParentNumber }),
    childNumbers,
  };
}

async function findSeedIssue(
  github: GitHubPort,
  operations: SeedOperationStore | undefined,
  marker: string,
  target: string,
  signal?: AbortSignal,
): Promise<HostIssue | undefined> {
  const operationId = seedOperationId(marker);
  const operation = operations?.get(operationId);
  if (operation && (operation.marker !== marker || operation.target !== target)) {
    throw new Error(`Seed operation ${operationId} has an invalid durable binding`);
  }
  if (!operation || operation.state === "succeeded") {
    return await github.findIssueByMarker(marker, signal);
  }
  const matches = await github.findIssuesByMarker(marker, signal);
  if (matches.length !== 1) {
    throw new Error(
      `Seed operation ${operationId} is in_doubt with ${matches.length} marker results; manual resolution required`,
    );
  }
  operations!.succeed(operationId, matches[0]!.number);
  return matches[0];
}

async function createSeedIssue(
  github: GitHubPort,
  operations: SeedOperationStore | undefined,
  marker: string,
  target: string,
  desired: { title: string; body: string; labels: readonly string[] },
  signal?: AbortSignal,
): Promise<HostIssue> {
  if (!operations) {
    throw new Error("Applied seed creation requires a durable operation journal");
  }
  const operationId = seedOperationId(marker);
  const operation = operations.reserve({ operationId, marker, target });
  if (operation.state !== "in_doubt") {
    throw new Error(`Seed operation ${operationId} was already completed without an issue`);
  }
  try {
    const created = await github.createIssue(desired, signal);
    operations.succeed(operationId, created.number);
    return created;
  } catch (error) {
    throw new Error(
      `Seed operation ${operationId} is in_doubt; reconcile its unique marker before retry`,
      { cause: error },
    );
  }
}

function firstUndeliveredIndex(
  entries: readonly { child: RoadmapChild; issue?: HostIssue }[],
): number {
  const index = entries.findIndex((entry) => entry.issue?.state !== "closed");
  return index < 0 ? -1 : index;
}

function sameIssue(
  issue: HostIssue,
  desired: { title: string; body: string; labels: readonly string[] },
  state: "open" | "closed",
): boolean {
  return (
    issue.title === desired.title &&
    issue.body === desired.body &&
    issue.state === state &&
    sameStrings(issue.labels, desired.labels)
  );
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    [...left].sort().every((value, index) => value === [...right].sort()[index])
  );
}
