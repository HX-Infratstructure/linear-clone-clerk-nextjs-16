/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { StorageActionWriter } from "convex/server";
import { describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import { PAGE_SIZE } from "./admin";
import { CLEANUP_BUDGET, ISSUE_OWNED_TABLES, IssueOwnedCounts } from "./lib/issueCleanup";
import { Doc, Id, TableNames } from "./_generated/dataModel";
import { MutationCtx } from "./_generated/server";
import { createTestingSubtask } from "./lib/rules/testing";
import schema from "./schema";
import { registerRealTimers } from "./test-helpers.fixture";

const modules = import.meta.glob("./**/*.*s");

registerRealTimers();

const CLEARED_ORG = "org_cleared";
const KEPT_ORG = "org_kept";
const LONE_ORG = "org_lone";

const CONTENT_TABLES = [
  "issueLabels",
  "issueRelations",
  "comments",
  "activity",
  "attachments",
  "decisions",
  "issues",
  "cycles",
  "labels",
  "views",
  "projects",
  "teams",
  "idempotencyKeys",
] as const satisfies readonly TableNames[];

const MIRROR_TABLES = ["organizations", "users", "members"] as const satisfies readonly TableNames[];

/** The tables with an organization index, which the mirror refusal checks one row of each. */
const ORG_INDEXED_TABLES = ["activity", "decisions", "issues", "labels", "views", "projects", "teams", "idempotencyKeys"];

const SEEDED_COUNTS = {
  issueLabels: 1,
  issueRelations: 1,
  comments: 1,
  activity: 2,
  attachments: 1,
  decisions: 1,
  issues: 2,
  cycles: 1,
  labels: 1,
  views: 1,
  projects: 1,
  teams: 1,
  idempotencyKeys: 1,
};

const ZERO_COUNTS = Object.fromEntries(CONTENT_TABLES.map((table) => [table, 0]));

async function seedMirror(ctx: MutationCtx, clerkOrgId: string) {
  const userId = await ctx.db.insert("users", {
    clerkId: `user_${clerkOrgId}`,
    name: "Owner",
    email: `${clerkOrgId}@example.com`,
  });
  const orgId = await ctx.db.insert("organizations", {
    clerkOrgId,
    name: clerkOrgId,
    slug: clerkOrgId,
  });
  await ctx.db.insert("members", {
    orgId,
    userId,
    role: "admin",
    clerkMembershipId: `mem_${clerkOrgId}`,
  });
  return { orgId, userId };
}

async function seedOrg(ctx: MutationCtx & { storage: StorageActionWriter }, clerkOrgId: string) {
  const { orgId, userId } = await seedMirror(ctx, clerkOrgId);
  const teamId = await ctx.db.insert("teams", {
    orgId,
    name: "Engineering",
    key: "ENG",
    nextIssueNumber: 3,
  });
  const cycleId = await ctx.db.insert("cycles", {
    orgId,
    teamId,
    number: 1,
    startDate: 0,
    endDate: 1,
  });
  const projectId = await ctx.db.insert("projects", {
    orgId,
    name: "Launch",
    status: "planned",
  });
  const issueIds: Id<"issues">[] = [];
  for (const number of [1, 2]) {
    const issueId = await ctx.db.insert("issues", {
      orgId,
      teamId,
      kind: "story",
      number,
      title: `Issue ${number}`,
      status: "todo",
      priority: "none",
      creatorId: userId,
      projectId,
      cycleId,
      sortOrder: number,
    });
    await ctx.db.insert("activity", { orgId, issueId, actorId: userId, type: "created" });
    issueIds.push(issueId);
  }
  const [firstIssueId, secondIssueId] = issueIds;
  const labelId = await ctx.db.insert("labels", { orgId, name: "Bug", color: "#ff0000" });
  await ctx.db.insert("issueLabels", { issueId: firstIssueId, labelId });
  await ctx.db.insert("issueRelations", {
    issueId: firstIssueId,
    relatedIssueId: secondIssueId,
    type: "blocks",
  });
  await ctx.db.insert("comments", { orgId, issueId: firstIssueId, authorId: userId, body: "Hi" });
  await ctx.db.insert("decisions", { orgId, issueId: firstIssueId, askedBy: userId, question: "Ship?", status: "open" });
  const storageId = await ctx.storage.store(new Blob(["attachment"]));
  await ctx.db.insert("attachments", {
    orgId,
    issueId: firstIssueId,
    storageId,
    fileName: "a.txt",
    fileType: "text/plain",
    fileSize: 10,
    uploadedBy: userId,
  });
  await ctx.db.insert("views", {
    orgId,
    creatorId: userId,
    name: "Mine",
    filters: "{}",
    shared: false,
  });
  await ctx.db.insert("idempotencyKeys", {
    orgId,
    agentId: userId,
    key: "k-1",
    requestHash: "hash",
    body: { done: true },
    createdAt: 1,
  });
  return { orgId, storageId };
}

async function setup() {
  const t = convexTest({ schema, modules, transactionLimits: true });
  const seeded = await t.run(async (ctx) => ({
    cleared: await seedOrg(ctx, CLEARED_ORG),
    kept: await seedOrg(ctx, KEPT_ORG),
  }));
  return { t, ...seeded };
}

type TestConvex = Awaited<ReturnType<typeof setup>>["t"];

async function snapshot<T extends TableNames>(t: TestConvex, tables: readonly T[]) {
  const entries = await t.run((ctx) =>
    Promise.all(tables.map(async (table) => [table, await ctx.db.query(table).collect()] as const))
  );
  return Object.fromEntries(entries) as { [K in T]: Doc<K>[] };
}

function belongsTo(orgId: Id<"organizations">, clearedIssueIds: Set<string>) {
  return (doc: Record<string, unknown>) =>
    doc.orgId === orgId || clearedIssueIds.has(String(doc.issueId));
}

async function addIssues(t: TestConvex, teamId: Id<"teams">, count: number) {
  await t.run(async (ctx) => {
    const team = (await ctx.db.get(teamId))!;
    const creator = (await ctx.db.query("users").first())!;
    for (let number = 100; number < 100 + count; number++) {
      const issueId = await ctx.db.insert("issues", {
        orgId: team.orgId,
        teamId,
        status: "todo",
        priority: "none",
        creatorId: creator._id,
        kind: "story",
        number,
        title: `bulk ${number}`,
        sortOrder: number,
      });
      await ctx.db.insert("activity", { orgId: team.orgId, issueId, actorId: creator._id, type: "created" });
    }
  });
}

/** Activity rows on one issue: more than one run deletes, and more than one Convex mutation can write. */
const HEAVY_ACTIVITY = 20_000;

/** Gives the issue `count` more activity rows, `TEST_BATCH` a transaction. */
async function addActivity(t: TestConvex, issueId: Id<"issues">, count: number) {
  for (let start = 0; start < count; start += TEST_BATCH) {
    await t.run(async (ctx) => {
      const issue = (await ctx.db.get(issueId))!;
      for (let index = start; index < Math.min(start + TEST_BATCH, count); index++) {
        await ctx.db.insert("activity", { orgId: issue.orgId, issueId, actorId: issue.creatorId, type: "updated" });
      }
    });
  }
}

/** Comments on one issue: within the row budget, and past Convex's read limit (`TRANSACTION_LIMITS.bytesRead` in `./lib/transactionLimits`) in all. */
const LARGE_COMMENTS = 4_000;
const COMMENT_CHARS = 5 * 1024;

/** Gives the issue `count` comments of `chars` characters, `TEST_BATCH` a transaction. */
async function addComments(t: TestConvex, issueId: Id<"issues">, count: number, chars: number) {
  for (let start = 0; start < count; start += TEST_BATCH) {
    await t.run(async (ctx) => {
      const issue = (await ctx.db.get(issueId))!;
      for (let index = start; index < Math.min(start + TEST_BATCH, count); index++) {
        await ctx.db.insert("comments", { orgId: issue.orgId, issueId, authorId: issue.creatorId, body: "c".repeat(chars) });
      }
    });
  }
}

/** Owned rows a run's counts say it deleted. */
function ownedRowsDeleted(counts: IssueOwnedCounts) {
  return ISSUE_OWNED_TABLES.reduce((sum, table) => sum + counts[table], 0);
}

/** Gives the team `count` more cycles. */
async function addCycles(t: TestConvex, teamId: Id<"teams">, count: number) {
  await t.run(async (ctx) => {
    const { orgId } = (await ctx.db.get(teamId))!;
    for (let number = 100; number < 100 + count; number++) {
      await ctx.db.insert("cycles", { orgId, teamId, number, startDate: 0, endDate: 1 });
    }
  });
}

/** Cancels every queued run, as if the scheduled continuation had failed. */
async function cancelScheduledRuns(t: TestConvex) {
  await t.run(async (ctx) => {
    for (const job of await ctx.db.system.query("_scheduled_functions").collect()) {
      if (job.state.kind === "pending") {
        await ctx.scheduler.cancel(job._id);
      }
    }
  });
}

/** How each scheduled run ended; a run that threw is `failed`. */
async function scheduledRunStates(t: TestConvex) {
  const jobs = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
  return new Set(jobs.map((job) => job.state.kind));
}

const SCALE_ORG = "org_scale";
const SCALE_TEAMS = ["ENG", "OPS", "WEB", "QA"];
const STORIES_PER_TEAM = 250;

/** Adds a team with one cycle and `STORIES_PER_TEAM` stories, each with its Complete testing sub-task, as `issues.create` writes them. */
async function addTeamOfStories(t: TestConvex, orgId: Id<"organizations">, creatorId: Id<"users">, key: string) {
  await t.run(async (ctx) => {
    const teamId = await ctx.db.insert("teams", { orgId, name: key, key, nextIssueNumber: STORIES_PER_TEAM + 1 });
    await ctx.db.insert("cycles", { orgId, teamId, number: 1, startDate: 0, endDate: 1 });
    for (let number = 1; number <= STORIES_PER_TEAM; number++) {
      const storyId = await ctx.db.insert("issues", {
        orgId,
        teamId,
        kind: "story",
        number,
        nextSubNumber: 1,
        title: `${key}-${number}`,
        status: "todo",
        priority: "none",
        creatorId,
        sortOrder: number,
      });
      await ctx.db.insert("activity", { orgId, issueId: storyId, actorId: creatorId, type: "created" });
      await createTestingSubtask(ctx, (await ctx.db.get(storyId))!);
    }
  });
}

describe("admin.clearOrgContent", () => {
  test("deletes one organization's content and keeps its mirror and the other organization", async () => {
    const { t, cleared } = await setup();
    const contentBefore = await snapshot(t, CONTENT_TABLES);
    const mirrorBefore = await snapshot(t, MIRROR_TABLES);
    const clearedIssueIds = new Set(
      contentBefore.issues.filter((issue) => issue.orgId === cleared.orgId).map((issue) => issue._id)
    );
    const isCleared = belongsTo(cleared.orgId, clearedIssueIds);

    const counts = await t.mutation(internal.admin.clearOrgContent, { clerkOrgId: CLEARED_ORG });

    expect(counts).toEqual(SEEDED_COUNTS);
    const contentAfter = await snapshot(t, CONTENT_TABLES);
    for (const table of CONTENT_TABLES) {
      expect(contentAfter[table], table).toEqual(
        contentBefore[table].filter((doc) => !isCleared(doc))
      );
    }
    expect(await snapshot(t, MIRROR_TABLES)).toEqual(mirrorBefore);
    const storedFile = await t.run((ctx) => ctx.db.system.get(cleared.storageId));
    expect(storedFile).toBeNull();
  });

  test("returns all zeros on a second run", async () => {
    const { t } = await setup();
    await t.mutation(internal.admin.clearOrgContent, { clerkOrgId: CLEARED_ORG });

    const counts = await t.mutation(internal.admin.clearOrgContent, { clerkOrgId: CLEARED_ORG });

    expect(counts).toEqual(ZERO_COUNTS);
  });

  test("refuses an unknown organization", async () => {
    const { t } = await setup();

    await expect(
      t.mutation(internal.admin.clearOrgContent, { clerkOrgId: "org_missing" })
    ).rejects.toThrow("Organization org_missing not found");
  });

  test("deletes one page of issues per run and the scheduled runs delete the rest", async () => {
    vi.useFakeTimers();
    const { t, cleared } = await setup();
    const teamId = await t.run(async (ctx) => (await ctx.db.query("teams").first())!._id);
    await addIssues(t, teamId, PAGE_SIZE);
    const contentBefore = await snapshot(t, CONTENT_TABLES);
    const clearedIssueIds = new Set(
      contentBefore.issues.filter((issue) => issue.orgId === cleared.orgId).map((issue) => issue._id)
    );
    const isCleared = belongsTo(cleared.orgId, clearedIssueIds);

    const counts = await t.mutation(internal.admin.clearOrgContent, { clerkOrgId: CLEARED_ORG });

    expect(counts).toMatchObject({ issues: PAGE_SIZE, teams: 0, labels: 0 });
    expect(await t.run((ctx) => ctx.db.get(teamId))).not.toBeNull();
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const contentAfter = await snapshot(t, CONTENT_TABLES);
    for (const table of CONTENT_TABLES) {
      expect(contentAfter[table], table).toEqual(contentBefore[table].filter((doc) => !isCleared(doc)));
    }
    expect(await t.run((ctx) => ctx.db.system.get(cleared.storageId))).toBeNull();
  });

  test("deletes at most one page of cycles per run across its teams, and the scheduled runs delete the rest", async () => {
    vi.useFakeTimers();
    const { t, cleared } = await setup();
    const teamCycles = Math.ceil(PAGE_SIZE / 2);
    for (const key of ["OPS", "WEB"]) {
      const teamId = await t.run((ctx) => ctx.db.insert("teams", { orgId: cleared.orgId, name: key, key, nextIssueNumber: 1 }));
      await addCycles(t, teamId, teamCycles);
    }
    const contentBefore = await snapshot(t, CONTENT_TABLES);
    const clearedIssueIds = new Set(
      contentBefore.issues.filter((issue) => issue.orgId === cleared.orgId).map((issue) => issue._id)
    );
    const isCleared = belongsTo(cleared.orgId, clearedIssueIds);

    const counts = await t.mutation(internal.admin.clearOrgContent, { clerkOrgId: CLEARED_ORG });

    expect(counts).toMatchObject({ cycles: PAGE_SIZE, issues: 2 });
    expect(counts.teams).toBeLessThan(3);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const contentAfter = await snapshot(t, CONTENT_TABLES);
    for (const table of CONTENT_TABLES) {
      expect(contentAfter[table], table).toEqual(contentBefore[table].filter((doc) => !isCleared(doc)));
    }
    expect(await scheduledRunStates(t)).toEqual(new Set(["success"]));
  });

  test("clears an issue that owns more rows than one run deletes over the scheduled runs, every run succeeding", async () => {
    vi.useFakeTimers();
    const { t, cleared } = await setup();
    const heavyId = await t.run(async (ctx) => {
      const first = await ctx.db.query("issues").withIndex("by_org", (q) => q.eq("orgId", cleared.orgId)).first();
      return first!._id;
    });
    await addActivity(t, heavyId, HEAVY_ACTIVITY);
    const contentBefore = await snapshot(t, CONTENT_TABLES);
    const clearedIssueIds = new Set(
      contentBefore.issues.filter((issue) => issue.orgId === cleared.orgId).map((issue) => issue._id)
    );
    const isCleared = belongsTo(cleared.orgId, clearedIssueIds);

    const counts = await t.mutation(internal.admin.clearOrgContent, { clerkOrgId: CLEARED_ORG });

    expect(ownedRowsDeleted(counts)).toBe(CLEANUP_BUDGET.rows);
    expect(counts).toMatchObject({ issues: 0, teams: 0 });
    expect(await t.run((ctx) => ctx.db.get(heavyId))).not.toBeNull();
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const contentAfter = await snapshot(t, CONTENT_TABLES);
    for (const table of CONTENT_TABLES) {
      expect(contentAfter[table], table).toEqual(contentBefore[table].filter((doc) => !isCleared(doc)));
    }
    expect(await scheduledRunStates(t)).toEqual(new Set(["success"]));
  }, 60_000);

  test("a queued run leaves the workspace once its mirror is created again under the same Clerk id", async () => {
    vi.useFakeTimers();
    const { t } = await setup();
    const teamId = await t.run(async (ctx) => (await ctx.db.query("teams").first())!._id);
    await addIssues(t, teamId, PAGE_SIZE);
    await t.mutation(internal.admin.clearOrgContent, { clerkOrgId: CLEARED_ORG });
    await t.mutation(internal.admin.clearOrgContent, { clerkOrgId: CLEARED_ORG });
    await t.mutation(internal.admin.deleteOrgMirror, { clerkOrgId: CLEARED_ORG });
    await t.run((ctx) => seedOrg(ctx, CLEARED_ORG));
    const before = await snapshot(t, [...CONTENT_TABLES, ...MIRROR_TABLES]);

    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await snapshot(t, [...CONTENT_TABLES, ...MIRROR_TABLES])).toEqual(before);
    expect(await scheduledRunStates(t)).toEqual(new Set(["success"]));
  });

  /**
   * DSH's scale case: 2,000 issue rows under Convex's per-transaction limits. Measured at 7f30129 on HX-15, 8 runs:
   * 20 scheduled runs after the first (19 more pages of issues, then the teams and their cycles), 8.0 to 13.5 s a test.
   * The time is convex-test's in-memory index scan, which reads every document per query; it is the same without limits.
   */
  test("clears 1,000 stories and their testing sub-tasks across four teams inside Convex's transaction limits", async () => {
    vi.useFakeTimers();
    const t = convexTest({ schema, modules, transactionLimits: true });
    const { orgId, userId } = await t.run((ctx) => seedMirror(ctx, SCALE_ORG));
    for (const key of SCALE_TEAMS) {
      await addTeamOfStories(t, orgId, userId, key);
    }
    const mirrorBefore = await snapshot(t, MIRROR_TABLES);

    const counts = await t.mutation(internal.admin.clearOrgContent, { clerkOrgId: SCALE_ORG });

    expect(counts).toEqual({ ...ZERO_COUNTS, issues: PAGE_SIZE, activity: PAGE_SIZE });
    expect(await scheduledRunStates(t)).toEqual(new Set(["pending"]));
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await snapshot(t, CONTENT_TABLES)).toEqual(Object.fromEntries(CONTENT_TABLES.map((table) => [table, []])));
    expect(await snapshot(t, MIRROR_TABLES)).toEqual(mirrorBefore);
    expect(await scheduledRunStates(t)).toEqual(new Set(["success"]));
  }, 60_000);
});

async function setupMirrorWith(
  insertRow: (ctx: MutationCtx, orgId: Id<"organizations">) => Promise<unknown>
) {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    const { orgId } = await seedMirror(ctx, LONE_ORG);
    await insertRow(ctx, orgId);
  });
  return t;
}

async function expectMirrorRefused(t: TestConvex, clerkOrgId: string, message: string) {
  const mirrorBefore = await snapshot(t, MIRROR_TABLES);

  await expect(t.mutation(internal.admin.deleteOrgMirror, { clerkOrgId })).rejects.toMatchObject({
    data: { code: "rule_refused", message: expect.stringContaining(message) },
  });
  expect(await snapshot(t, MIRROR_TABLES)).toEqual(mirrorBefore);
}

describe("admin.deleteOrgMirror", () => {
  test("refuses while the organization still has content and names every table with an organization index", async () => {
    const { t } = await setup();

    await expectMirrorRefused(
      t,
      CLEARED_ORG,
      `Organization ${CLEARED_ORG} still has rows in ${ORG_INDEXED_TABLES.join(", ")}.`
    );
  });

  test("refuses an organization that has only a project", async () => {
    const t = await setupMirrorWith((ctx, orgId) =>
      ctx.db.insert("projects", { orgId, name: "Solo", status: "planned" })
    );

    await expectMirrorRefused(t, LONE_ORG, `Organization ${LONE_ORG} still has rows in projects.`);
  });

  test("refuses an organization that has only a label", async () => {
    const t = await setupMirrorWith((ctx, orgId) =>
      ctx.db.insert("labels", { orgId, name: "Solo", color: "#000000" })
    );

    await expectMirrorRefused(t, LONE_ORG, `Organization ${LONE_ORG} still has rows in labels.`);
  });

  test("removes the organization and member rows after clearOrgContent and keeps users", async () => {
    const { t, cleared } = await setup();
    await t.mutation(internal.admin.clearOrgContent, { clerkOrgId: CLEARED_ORG });
    const mirrorBefore = await snapshot(t, MIRROR_TABLES);

    const counts = await t.mutation(internal.admin.deleteOrgMirror, { clerkOrgId: CLEARED_ORG });

    expect(counts).toEqual({ organizations: 1, members: 1 });
    const mirrorAfter = await snapshot(t, MIRROR_TABLES);
    expect(mirrorAfter.users).toEqual(mirrorBefore.users);
    expect(mirrorAfter.organizations).toEqual(
      mirrorBefore.organizations.filter((org) => org._id !== cleared.orgId)
    );
    expect(mirrorAfter.members).toEqual(
      mirrorBefore.members.filter((member) => member.orgId !== cleared.orgId)
    );
  });
});

const TEAM_ORG = "org_teams";
const CLEARED_TEAM = "ENG";
const KEPT_TEAM = "OPS";

async function seedTeam(
  ctx: MutationCtx & { storage: StorageActionWriter },
  orgId: Id<"organizations">,
  userId: Id<"users">,
  key: string
) {
  const teamId = await ctx.db.insert("teams", { orgId, name: key, key, nextIssueNumber: 3 });
  const cycleId = await ctx.db.insert("cycles", { orgId, teamId, number: 1, startDate: 0, endDate: 1 });
  const issueFields = { orgId, teamId, status: "todo", priority: "none", creatorId: userId, cycleId } as const;
  const storyId = await ctx.db.insert("issues", {
    ...issueFields,
    kind: "story",
    number: 1,
    title: `${key} story`,
    sortOrder: 1,
  });
  const subtaskId = await ctx.db.insert("issues", {
    ...issueFields,
    kind: "subtask",
    subNumber: 1,
    title: `${key} sub-task`,
    parentIssueId: storyId,
    sortOrder: 2,
  });
  for (const issueId of [storyId, subtaskId]) {
    await ctx.db.insert("activity", { orgId, issueId, actorId: userId, type: "created" });
  }
  await ctx.db.insert("comments", { orgId, issueId: storyId, authorId: userId, body: key });
  await ctx.db.insert("decisions", { orgId, issueId: storyId, askedBy: userId, question: key, status: "open" });
  await ctx.db.insert("issueRelations", { issueId: storyId, relatedIssueId: subtaskId, type: "blocks" });
  const storageId = await ctx.storage.store(new Blob([key]));
  await ctx.db.insert("attachments", {
    orgId,
    issueId: storyId,
    storageId,
    fileName: `${key}.txt`,
    fileType: "text/plain",
    fileSize: 3,
    uploadedBy: userId,
  });
  return { teamId, storyId, storageId };
}

async function setupTeams() {
  const t = convexTest({ schema, modules, transactionLimits: true });
  const seeded = await t.run(async (ctx) => {
    const { orgId, userId } = await seedMirror(ctx, TEAM_ORG);
    const cleared = await seedTeam(ctx, orgId, userId, CLEARED_TEAM);
    const kept = await seedTeam(ctx, orgId, userId, KEPT_TEAM);
    const labelId = await ctx.db.insert("labels", { orgId, name: "Bug", color: "#ff0000" });
    await ctx.db.insert("issueLabels", { issueId: cleared.storyId, labelId });
    await ctx.db.insert("issueLabels", { issueId: kept.storyId, labelId });
    await ctx.db.insert("issueRelations", {
      issueId: kept.storyId,
      relatedIssueId: cleared.storyId,
      type: "blocks",
    });
    await ctx.db.insert("projects", { orgId, name: "Shared", status: "planned" });
    await ctx.db.insert("views", { orgId, creatorId: userId, name: "Mine", filters: "{}", shared: true });
    await ctx.db.insert("idempotencyKeys", {
      orgId,
      agentId: userId,
      key: "k-1",
      requestHash: "hash",
      body: { done: true },
      createdAt: 1,
    });
    return { cleared, kept };
  });
  return { t, ...seeded };
}

function belongsToTeam(teamId: Id<"teams">, teamIssueIds: Set<string>) {
  return (doc: Record<string, unknown>) =>
    doc._id === teamId ||
    doc.teamId === teamId ||
    teamIssueIds.has(String(doc.issueId)) ||
    teamIssueIds.has(String(doc.relatedIssueId));
}

/** Convex's per-transaction read limit, which one read of every saved view can pass. */
const TRANSACTION_READ_BYTES = 16 * 1024 * 1024;
/** Near the 4096 characters `views.create` accepts. */
const LARGE_FILTER_CHARS = 4000;
/** Rows one test transaction writes or reads, well inside the limits. */
const TEST_BATCH = 1000;

/** Saved-view filters as `serializeSavedView` writes them; `labelChars` pads the label filter. */
function savedView(teamId: Id<"teams">, labelChars = 0) {
  return JSON.stringify({
    v: 1,
    teamId,
    display: "board",
    filters: { statuses: ["todo"], priorities: [], assignees: [], labels: ["x".repeat(labelChars)] },
  });
}

/** Inserts `count` saved views; every third opens the cleared team, the rest the kept one. Returns the third. */
async function insertViews(
  t: TestConvex,
  teams: { cleared: Id<"teams">; kept: Id<"teams"> },
  count: number,
  labelChars: number
) {
  const opensCleared = new Set<Id<"views">>();
  for (let start = 0; start < count; start += TEST_BATCH) {
    await t.run(async (ctx) => {
      const { orgId } = (await ctx.db.get(teams.kept))!;
      const creatorId = (await ctx.db.query("users").first())!._id;
      for (let index = start; index < Math.min(start + TEST_BATCH, count); index++) {
        const teamId = index % 3 === 0 ? teams.cleared : teams.kept;
        const filters = savedView(teamId, labelChars);
        const viewId = await ctx.db.insert("views", { orgId, creatorId, name: `View ${index}`, filters, shared: true });
        if (teamId === teams.cleared) {
          opensCleared.add(viewId);
        }
      }
    });
  }
  return opensCleared;
}

/** Every saved view's id, read in pages so no test transaction passes the read limit. */
async function allViewIds(t: TestConvex) {
  const ids: Id<"views">[] = [];
  let cursor: string | null = null;
  for (let isDone = false; !isDone; ) {
    const page = await t.run((ctx) => ctx.db.query("views").paginate({ cursor, numItems: TEST_BATCH }));
    ids.push(...page.page.map((view) => view._id));
    cursor = page.continueCursor;
    isDone = page.isDone;
  }
  return ids;
}

/** Queues a scheduled run for the cleared team, then a second clear deletes the team before that run. */
async function queueRunThenClearTeam(t: TestConvex, teamId: Id<"teams">) {
  await addIssues(t, teamId, PAGE_SIZE);
  await t.mutation(internal.admin.clearTeamContent, { clerkOrgId: TEAM_ORG, teamKey: CLEARED_TEAM });
  await t.mutation(internal.admin.clearTeamContent, { clerkOrgId: TEAM_ORG, teamKey: CLEARED_TEAM });
  expect(await t.run((ctx) => ctx.db.get(teamId))).toBeNull();
}

describe("admin.clearTeamContent", () => {
  test("deletes one team's content and the team, and keeps the other team, org rows and the mirror", async () => {
    const { t, cleared, kept } = await setupTeams();
    const contentBefore = await snapshot(t, CONTENT_TABLES);
    const mirrorBefore = await snapshot(t, MIRROR_TABLES);
    const clearedIssueIds = new Set(
      contentBefore.issues.filter((issue) => issue.teamId === cleared.teamId).map((issue) => issue._id)
    );
    const isCleared = belongsToTeam(cleared.teamId, clearedIssueIds);

    const counts = await t.mutation(internal.admin.clearTeamContent, {
      clerkOrgId: TEAM_ORG,
      teamKey: CLEARED_TEAM,
    });

    expect(counts).toEqual({
      issueLabels: 1,
      issueRelations: 2,
      comments: 1,
      activity: 2,
      attachments: 1,
      decisions: 1,
      issues: 2,
      cycles: 1,
      views: 0,
      teams: 1,
    });
    const contentAfter = await snapshot(t, CONTENT_TABLES);
    for (const table of CONTENT_TABLES) {
      expect(contentAfter[table], table).toEqual(contentBefore[table].filter((doc) => !isCleared(doc)));
    }
    expect(contentAfter.issues.map((issue) => issue.title)).toEqual(["OPS story", "OPS sub-task"]);
    expect(contentAfter.issueRelations).toHaveLength(1);
    expect(await snapshot(t, MIRROR_TABLES)).toEqual(mirrorBefore);
    const files = await t.run(async (ctx) => ({
      cleared: await ctx.db.system.get(cleared.storageId),
      kept: await ctx.db.system.get(kept.storageId),
    }));
    expect(files.cleared).toBeNull();
    expect(files.kept).not.toBeNull();
  });

  test("clears a team larger than one page over the scheduled runs", async () => {
    vi.useFakeTimers();
    const { t, cleared, kept } = await setupTeams();
    await addIssues(t, cleared.teamId, 600);
    const contentBefore = await snapshot(t, CONTENT_TABLES);
    const clearedIssueIds = new Set(
      contentBefore.issues.filter((issue) => issue.teamId === cleared.teamId).map((issue) => issue._id)
    );
    const isCleared = belongsToTeam(cleared.teamId, clearedIssueIds);

    const counts = await t.mutation(internal.admin.clearTeamContent, { clerkOrgId: TEAM_ORG, teamKey: CLEARED_TEAM });

    expect(counts).toMatchObject({ issues: PAGE_SIZE, cycles: 0, teams: 0 });
    expect(await t.run((ctx) => ctx.db.get(cleared.teamId))).not.toBeNull();
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const contentAfter = await snapshot(t, CONTENT_TABLES);
    for (const table of CONTENT_TABLES) {
      expect(contentAfter[table], table).toEqual(contentBefore[table].filter((doc) => !isCleared(doc)));
    }
    expect(await t.run((ctx) => ctx.db.get(kept.teamId))).not.toBeNull();
  });

  test("clears a team with more cycles than one page over the scheduled runs", async () => {
    vi.useFakeTimers();
    const { t, cleared, kept } = await setupTeams();
    await addCycles(t, cleared.teamId, PAGE_SIZE + 5);
    const cyclesOf = (teamId: Id<"teams">) =>
      t.run((ctx) => ctx.db.query("cycles").withIndex("by_team", (q) => q.eq("teamId", teamId)).collect());

    const counts = await t.mutation(internal.admin.clearTeamContent, { clerkOrgId: TEAM_ORG, teamKey: CLEARED_TEAM });

    expect(counts).toMatchObject({ issues: 2, cycles: PAGE_SIZE, teams: 0 });
    expect(await t.run((ctx) => ctx.db.get(cleared.teamId))).not.toBeNull();
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.run((ctx) => ctx.db.get(cleared.teamId))).toBeNull();
    expect(await cyclesOf(cleared.teamId)).toEqual([]);
    expect(await cyclesOf(kept.teamId)).toHaveLength(1);
    expect(await scheduledRunStates(t)).toEqual(new Set(["success"]));
  });

  test("a rerun after a scheduled run failed finishes the clear", async () => {
    vi.useFakeTimers();
    const { t, cleared } = await setupTeams();
    await addIssues(t, cleared.teamId, PAGE_SIZE + 5);
    await t.mutation(internal.admin.clearTeamContent, { clerkOrgId: TEAM_ORG, teamKey: CLEARED_TEAM });
    await cancelScheduledRuns(t);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const left = () =>
      t.run(async (ctx) => ({
        team: await ctx.db.get(cleared.teamId),
        issues: await ctx.db.query("issues").withIndex("by_team", (q) => q.eq("teamId", cleared.teamId)).collect(),
      }));
    expect((await left()).team).not.toBeNull();
    expect((await left()).issues.length).toBeGreaterThan(0);

    await t.mutation(internal.admin.clearTeamContent, { clerkOrgId: TEAM_ORG, teamKey: CLEARED_TEAM });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await left()).toEqual({ team: null, issues: [] });
  });

  test("clears a team whose issue owns more rows than one run deletes over the scheduled runs, every run succeeding", async () => {
    vi.useFakeTimers();
    const { t, cleared, kept } = await setupTeams();
    await addActivity(t, cleared.storyId, HEAVY_ACTIVITY);
    const contentBefore = await snapshot(t, CONTENT_TABLES);
    const clearedIssueIds = new Set(
      contentBefore.issues.filter((issue) => issue.teamId === cleared.teamId).map((issue) => issue._id)
    );
    const isCleared = belongsToTeam(cleared.teamId, clearedIssueIds);

    const counts = await t.mutation(internal.admin.clearTeamContent, { clerkOrgId: TEAM_ORG, teamKey: CLEARED_TEAM });

    expect(ownedRowsDeleted(counts)).toBe(CLEANUP_BUDGET.rows);
    expect(counts).toMatchObject({ issues: 0, cycles: 0, teams: 0 });
    expect(await t.run((ctx) => ctx.db.get(cleared.storyId))).not.toBeNull();
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const contentAfter = await snapshot(t, CONTENT_TABLES);
    for (const table of CONTENT_TABLES) {
      expect(contentAfter[table], table).toEqual(contentBefore[table].filter((doc) => !isCleared(doc)));
    }
    expect(await t.run((ctx) => ctx.db.get(kept.teamId))).not.toBeNull();
    expect(await t.run((ctx) => ctx.db.system.get(cleared.storageId))).toBeNull();
    expect(await scheduledRunStates(t)).toEqual(new Set(["success"]));
  }, 60_000);

  test("a rerun after a scheduled run failed partway through a heavy issue finishes the clear", async () => {
    vi.useFakeTimers();
    const { t, cleared } = await setupTeams();
    await addActivity(t, cleared.storyId, HEAVY_ACTIVITY);
    await t.mutation(internal.admin.clearTeamContent, { clerkOrgId: TEAM_ORG, teamKey: CLEARED_TEAM });
    await cancelScheduledRuns(t);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const left = () =>
      t.run(async (ctx) => ({
        team: await ctx.db.get(cleared.teamId),
        story: await ctx.db.get(cleared.storyId),
        activity: (
          await ctx.db.query("activity").withIndex("by_issue", (q) => q.eq("issueId", cleared.storyId)).take(1)
        ).length,
      }));
    expect(await left()).toMatchObject({ activity: 1 });
    expect((await left()).story).not.toBeNull();

    await t.mutation(internal.admin.clearTeamContent, { clerkOrgId: TEAM_ORG, teamKey: CLEARED_TEAM });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await left()).toEqual({ team: null, story: null, activity: 0 });
  }, 60_000);

  test("clears a team whose issue's comments pass the read limit over the scheduled runs, every run succeeding", async () => {
    vi.useFakeTimers();
    const { t, cleared } = await setupTeams();
    await addComments(t, cleared.storyId, LARGE_COMMENTS, COMMENT_CHARS);

    await t.mutation(internal.admin.clearTeamContent, { clerkOrgId: TEAM_ORG, teamKey: CLEARED_TEAM });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await scheduledRunStates(t)).toEqual(new Set(["success"]));
    const left = await t.run(async (ctx) => ({
      team: await ctx.db.get(cleared.teamId),
      story: await ctx.db.get(cleared.storyId),
      comments: (
        await ctx.db.query("comments").withIndex("by_issue", (q) => q.eq("issueId", cleared.storyId)).take(1)
      ).length,
    }));
    expect(left).toEqual({ team: null, story: null, comments: 0 });
  }, 60_000);

  test("a queued run for a team that is already gone stops without error", async () => {
    vi.useFakeTimers();
    const { t, cleared } = await setupTeams();
    await queueRunThenClearTeam(t, cleared.teamId);
    const before = await snapshot(t, CONTENT_TABLES);

    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await scheduledRunStates(t)).toEqual(new Set(["success"]));
    expect(await snapshot(t, CONTENT_TABLES)).toEqual(before);
  });

  test("a queued run leaves a new team created with the cleared team's key", async () => {
    vi.useFakeTimers();
    const { t, cleared, kept } = await setupTeams();
    await queueRunThenClearTeam(t, cleared.teamId);
    const newTeamId = await t.run(async (ctx) => {
      const { orgId } = (await ctx.db.get(kept.teamId))!;
      const teamId = await ctx.db.insert("teams", { orgId, name: CLEARED_TEAM, key: CLEARED_TEAM, nextIssueNumber: 1 });
      const creatorId = (await ctx.db.query("users").first())!._id;
      await ctx.db.insert("views", { orgId, creatorId, name: "New board", filters: savedView(teamId), shared: true });
      return teamId;
    });
    await addIssues(t, newTeamId, 3);
    const before = await snapshot(t, CONTENT_TABLES);

    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await snapshot(t, CONTENT_TABLES)).toEqual(before);
  });

  test("checks every saved view a page per run, deletes those that open the team and keeps the rest", async () => {
    vi.useFakeTimers();
    const { t, cleared, kept } = await setupTeams();
    const teams = { cleared: cleared.teamId, kept: kept.teamId };
    const viewCount = Math.ceil(TRANSACTION_READ_BYTES / LARGE_FILTER_CHARS) + PAGE_SIZE;
    const opensCleared = await insertViews(t, teams, viewCount, LARGE_FILTER_CHARS);
    const idsBefore = await allViewIds(t);

    await t.mutation(internal.admin.clearTeamContent, { clerkOrgId: TEAM_ORG, teamKey: CLEARED_TEAM });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await allViewIds(t)).toEqual(idsBefore.filter((id) => !opensCleared.has(id)));
    expect(await t.run((ctx) => ctx.db.get(cleared.teamId))).toBeNull();
    expect(await scheduledRunStates(t)).toEqual(new Set(["success"]));
  }, 60_000);

  test("a rerun after a scheduled run failed in the saved-view scan finishes the clear", async () => {
    vi.useFakeTimers();
    const { t, cleared, kept } = await setupTeams();
    const opensCleared = await insertViews(t, { cleared: cleared.teamId, kept: kept.teamId }, PAGE_SIZE * 2 + 10, 0);
    const idsBefore = await allViewIds(t);
    await t.mutation(internal.admin.clearTeamContent, { clerkOrgId: TEAM_ORG, teamKey: CLEARED_TEAM });
    await cancelScheduledRuns(t);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.run((ctx) => ctx.db.get(cleared.teamId))).not.toBeNull();

    await t.mutation(internal.admin.clearTeamContent, { clerkOrgId: TEAM_ORG, teamKey: CLEARED_TEAM });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await allViewIds(t)).toEqual(idsBefore.filter((id) => !opensCleared.has(id)));
    expect(await t.run((ctx) => ctx.db.get(cleared.teamId))).toBeNull();
  });

  test("leaves another workspace's rows that point at a cleared issue", async () => {
    const { t, cleared } = await setupTeams();
    const foreign = await t.run(async (ctx) => {
      const { orgId, userId } = await seedMirror(ctx, "org_foreign");
      const issueId = cleared.storyId;
      const storageId = await ctx.storage.store(new Blob(["foreign"]));
      const rows = [
        await ctx.db.insert("comments", { orgId, issueId, authorId: userId, body: "foreign" }),
        await ctx.db.insert("activity", { orgId, issueId, actorId: userId, type: "commented" }),
        await ctx.db.insert("decisions", { orgId, issueId, askedBy: userId, question: "foreign", status: "open" }),
        await ctx.db.insert("attachments", {
          orgId,
          issueId,
          storageId,
          fileName: "foreign.txt",
          fileType: "text/plain",
          fileSize: 3,
          uploadedBy: userId,
        }),
      ];
      return { rows, storageId };
    });

    await t.mutation(internal.admin.clearTeamContent, { clerkOrgId: TEAM_ORG, teamKey: CLEARED_TEAM });

    const after = await t.run(async (ctx) => ({
      rows: await Promise.all(foreign.rows.map((id) => ctx.db.get(id))),
      file: await ctx.db.system.get(foreign.storageId),
    }));
    expect(after.rows.every((row) => row !== null)).toBe(true);
    expect(after.file).not.toBeNull();
  });

  test("deletes the saved views that open the cleared team and keeps the others", async () => {
    const { t, cleared, kept } = await setupTeams();
    const viewIds = await t.run(async (ctx) => {
      const keptStory = (await ctx.db.get(kept.storyId))!;
      const view = (name: string, filters: string) =>
        ctx.db.insert("views", { orgId: keptStory.orgId, creatorId: keptStory.creatorId, name, filters, shared: true });
      return {
        clearedTeam: await view("Cleared board", savedView(cleared.teamId)),
        keptTeam: await view("Kept board", savedView(kept.teamId)),
        notAView: await view("Null", "null"),
      };
    });

    const counts = await t.mutation(internal.admin.clearTeamContent, { clerkOrgId: TEAM_ORG, teamKey: CLEARED_TEAM });

    expect(counts.views).toBe(1);
    const views = await t.run(async (ctx) => ({
      clearedTeam: await ctx.db.get(viewIds.clearedTeam),
      keptTeam: await ctx.db.get(viewIds.keptTeam),
      notAView: await ctx.db.get(viewIds.notAView),
      all: await ctx.db.query("views").collect(),
    }));
    expect(views.clearedTeam).toBeNull();
    expect(views.keptTeam).not.toBeNull();
    expect(views.notAView).not.toBeNull();
    expect(views.all).toHaveLength(3);
  });

  test("finds the team by a lower-case, padded key", async () => {
    const { t, cleared, kept } = await setupTeams();

    const counts = await t.mutation(internal.admin.clearTeamContent, { clerkOrgId: TEAM_ORG, teamKey: " eng " });

    expect(counts).toMatchObject({ issues: 2, teams: 1 });
    const teams = await t.run(async (ctx) => ({
      cleared: await ctx.db.get(cleared.teamId),
      kept: await ctx.db.get(kept.teamId),
    }));
    expect(teams.cleared).toBeNull();
    expect(teams.kept).not.toBeNull();
  });

  test("refuses an unknown lower-case team with the upper-case key", async () => {
    const { t } = await setupTeams();

    await expect(
      t.mutation(internal.admin.clearTeamContent, { clerkOrgId: TEAM_ORG, teamKey: "nope" })
    ).rejects.toThrow("Team NOPE not found");
  });

  test("refuses an unknown team and changes nothing", async () => {
    const { t } = await setupTeams();
    const before = await snapshot(t, [...CONTENT_TABLES, ...MIRROR_TABLES]);

    await expect(
      t.mutation(internal.admin.clearTeamContent, { clerkOrgId: TEAM_ORG, teamKey: "NOPE" })
    ).rejects.toThrow("Team NOPE not found");
    expect(await snapshot(t, [...CONTENT_TABLES, ...MIRROR_TABLES])).toEqual(before);
  });

  test("refuses an unknown organization", async () => {
    const { t } = await setupTeams();

    await expect(
      t.mutation(internal.admin.clearTeamContent, { clerkOrgId: "org_missing", teamKey: CLEARED_TEAM })
    ).rejects.toThrow("Organization org_missing not found");
  });
});
