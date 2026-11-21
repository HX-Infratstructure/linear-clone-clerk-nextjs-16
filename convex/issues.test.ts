/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { PINNED_PAGE_MAX_ROWS } from "./lib/issues/queries";
import { LIST_LIMIT } from "../lib/api-contract";
import { PAGE_READ_ROWS } from "./lib/paging";
import schema from "./schema";
import { insertOrgMember, MEMBER_IDENTITY, ORG_CLAIM } from "./lib/orgMember.fixture";
import { issueReaders, refusalOf } from "./test-helpers.fixture";
import { writeHeaders } from "./workspace.fixture";

const modules = import.meta.glob("./**/*.*s");

const OUTSIDER_CLERK_ID = "user_outsider";
const FIRST_NUMBER = 7;

type Setup = Awaited<ReturnType<typeof setup>>;
/** What the seeding helpers need from a setup. */
type Seed = Pick<Setup, "t" | "orgId" | "teamId" | "memberId">;

async function setup(transactionLimits?: { documentsRead: number }) {
  const t = convexTest({ schema, modules, transactionLimits });
  const { orgId, teamId, memberId } = await t.run(async (ctx) => {
    const { orgId, memberId } = await insertOrgMember(ctx);
    await ctx.db.insert("users", {
      clerkId: OUTSIDER_CLERK_ID,
      name: "Outsider",
      email: "outsider@example.com",
    });
    const teamId = await ctx.db.insert("teams", {
      orgId,
      name: "Engineering",
      key: "ENG",
      nextIssueNumber: FIRST_NUMBER,
    });
    return { orgId, teamId, memberId };
  });
  const asMember = t.withIdentity(MEMBER_IDENTITY);
  const issueCount = () => t.run(async (ctx) => (await ctx.db.query("issues").collect()).length);
  const project = (name: string) =>
    t.run(async (ctx) => await ctx.db.insert("projects", { orgId, name, status: "planned" }));
  return { t, orgId, teamId, memberId, asMember, ...issueReaders(t), issueCount, project };
}

describe("issues.create", () => {
  test("numbers consecutive issues from the team counter and logs each creation", async () => {
    const { teamId, memberId, asMember } = await setup();

    const firstId = await asMember.mutation(api.issues.create, {
      teamId,
      title: "First",
    });
    const secondId = await asMember.mutation(api.issues.create, {
      teamId,
      title: "Second",
    });

    const first = await asMember.query(api.issues.get, { issueId: firstId });
    const second = await asMember.query(api.issues.get, { issueId: secondId });
    expect(first?.number).toBe(FIRST_NUMBER);
    expect(second?.number).toBe(FIRST_NUMBER + 1);

    for (const issueId of [firstId, secondId]) {
      const activity = await asMember.query(api.activity.listByIssue, {
        issueId,
      });
      expect(activity).toHaveLength(1);
      expect(activity[0]).toMatchObject({ type: "created", actorId: memberId });
    }
  });

  test("refuses a caller who is not a member of the active organization", async () => {
    const { t, teamId } = await setup();
    const asOutsider = t.withIdentity({
      subject: OUTSIDER_CLERK_ID,
      org_id: ORG_CLAIM,
    });

    await expect(
      asOutsider.mutation(api.issues.create, { teamId, title: "Intrusion" })
    ).rejects.toMatchObject({ data: { code: "not_found", message: "Not a member of this organization" } });

    const team = await t.run((ctx) => ctx.db.get(teamId));
    expect(team?.nextIssueNumber).toBe(FIRST_NUMBER);
  });
});

describe("issues.create on a free organization", () => {
  test("creates the 101st issue", async () => {
    const { t, teamId, memberId, orgId, asMember } = await setup();
    await t.run(async (ctx) => {
      for (let i = 0; i < 100; i++) {
        await ctx.db.insert("issues", {
          orgId,
          teamId,
          kind: "story",
          number: i + 1,
          title: `Seeded ${i + 1}`,
          status: "todo",
          priority: "none",
          creatorId: memberId,
          sortOrder: (i + 1) * 1000,
        });
      }
    });

    const issueId = await asMember.mutation(api.issues.create, {
      teamId,
      title: "Hundred and first",
    });

    const issues = await t.run((ctx) =>
      ctx.db
        .query("issues")
        .withIndex("by_team", (q) => q.eq("teamId", teamId))
        .collect()
    );
    expect(issues.filter((issue) => issue.kind === "story")).toHaveLength(101);
    expect(issues.map((issue) => issue._id)).toContain(issueId);
  });
});

const FIRST_PAGE = { numItems: LIST_LIMIT, cursor: null };

type BacklogPage = { page: { _id: Id<"issues">; sortOrder: number }[]; isDone: boolean; continueCursor: string };

/** Every page of the backlog, following the cursor until the last page. */
async function backlogPages<Page extends BacklogPage>(pageAt: (cursor: string | null) => Promise<Page>) {
  const pages: Page["page"][] = [];
  let cursor: string | null = null;
  for (;;) {
    const result: Page = await pageAt(cursor);
    pages.push(result.page);
    if (result.isDone) {
      return pages;
    }
    cursor = result.continueCursor;
  }
}

/** `LIST_LIMIT + 1` open stories in one status, the oldest ranked top; their ids in rank order. */
async function seedOldestRankedTop({ t, orgId, teamId, memberId }: Seed) {
  return await t.run(async (ctx) => {
    const ids = [];
    for (let i = 0; i <= LIST_LIMIT; i++) {
      ids.push(
        await ctx.db.insert("issues", {
          orgId,
          teamId,
          kind: "story",
          title: `Story ${i}`,
          status: "todo",
          priority: "none",
          creatorId: memberId,
          sortOrder: (LIST_LIMIT + 1 - i) * 1000,
        })
      );
    }
    return ids;
  });
}

describe("issues.listBacklog", () => {
  test("lists the team's open stories with no cycle, highest sortOrder first", async () => {
    const { t, teamId, memberId, orgId, asMember } = await setup();
    const cycleId = await t.run(async (ctx) => {
      return await ctx.db.insert("cycles", {
        orgId,
        teamId,
        number: 1,
        startDate: 0,
        endDate: 6 * 24 * 60 * 60 * 1000,
      });
    });
    const low = await asMember.mutation(api.issues.create, { teamId, title: "Low" });
    const high = await asMember.mutation(api.issues.create, { teamId, title: "High" });
    await asMember.mutation(api.issues.create, { teamId, title: "Planned", cycleId });
    await t.run(async (ctx) => {
      const rows = [
        { kind: "story", title: "Done", status: "done" },
        { kind: "story", title: "Dropped", status: "canceled" },
        { kind: "epic", title: "Epic", status: "todo" },
      ] as const;
      for (const row of rows) {
        await ctx.db.insert("issues", {
          ...row,
          orgId,
          teamId,
          creatorId: memberId,
          priority: "none",
          sortOrder: 99999,
        });
      }
    });
    await asMember.mutation(api.issues.update, { issueId: low, sortOrder: -5 });

    const { page: backlog } = await asMember.query(api.issues.listBacklog, { teamId, paginationOpts: FIRST_PAGE });

    expect(backlog.map((issue) => issue._id)).toEqual([high, low]);
  });

  test("refuses a caller who is not a member of the active organization", async () => {
    const { t, teamId } = await setup();
    const asOutsider = t.withIdentity({
      subject: OUTSIDER_CLERK_ID,
      org_id: ORG_CLAIM,
    });
    await expect(
      asOutsider.query(api.issues.listBacklog, { teamId, paginationOpts: FIRST_PAGE })
    ).rejects.toThrow();
  });

  test("the first page starts at the top-ranked story, the oldest, when one open status holds more than LIST_LIMIT", async () => {
    const s = await setup();
    const { teamId, asMember } = s;
    const rankOrder = await seedOldestRankedTop(s);

    const first = await asMember.query(api.issues.listBacklog, {
      teamId,
      paginationOpts: { numItems: LIST_LIMIT + 100, cursor: null },
    });

    expect(first.page[0]._id).toBe(rankOrder[0]);
    expect(first.page).toHaveLength(LIST_LIMIT);
    expect(first.isDone).toBe(false);
  });

  test("following the cursor reaches every story once, in rank order across pages", async () => {
    const s = await setup();
    const { teamId, asMember } = s;
    const rankOrder = await seedOldestRankedTop(s);

    const pages = await backlogPages((cursor) =>
      asMember.query(api.issues.listBacklog, { teamId, paginationOpts: { numItems: 200, cursor } })
    );

    const stories = pages.flat();
    expect(pages.length).toBeGreaterThan(2);
    expect(stories.map((issue) => issue._id)).toEqual(rankOrder);
    expect(stories.every((issue, i) => i === 0 || stories[i - 1].sortOrder > issue.sortOrder)).toBe(true);
  });

  test("stories with a cycle, other kinds and closed stories appear on no page", async () => {
    const { t, teamId, memberId, orgId, asMember } = await setup();
    const listed = await t.run(async (ctx) => {
      const cycleId = await ctx.db.insert("cycles", { orgId, teamId, number: 1, startDate: 0, endDate: 1 });
      const story = { orgId, teamId, kind: "story", status: "todo", priority: "none", creatorId: memberId } as const;
      const rows = [
        { ...story, title: "Top", sortOrder: 9000, listed: true },
        { ...story, title: "Planned", sortOrder: 8000, cycleId, listed: false },
        { ...story, title: "Epic", sortOrder: 7000, kind: "epic", listed: false },
        { ...story, title: "Sub-task", sortOrder: 6000, kind: "subtask", listed: false },
        { ...story, title: "In progress", sortOrder: 5000, status: "in_progress", listed: true },
        { ...story, title: "Done", sortOrder: 4000, status: "done", listed: false },
        { ...story, title: "Canceled", sortOrder: 3000, status: "canceled", listed: false },
        { ...story, title: "Backlog", sortOrder: 1000, status: "backlog", listed: true },
      ] as const;
      const ids = [];
      for (const { listed, ...row } of rows) {
        const id = await ctx.db.insert("issues", row);
        if (listed) {
          ids.push(id);
        }
      }
      return ids;
    });

    const pages = await backlogPages((cursor) =>
      asMember.query(api.issues.listBacklog, { teamId, paginationOpts: { numItems: 1, cursor } })
    );

    expect(pages.flat().map((issue) => issue._id)).toEqual(listed);
  });
  test("closed stories count toward a page's reads: a page stops after PAGE_READ_ROWS, and the cursor reaches an open story ranked below them", async () => {
    const { t, teamId, memberId, orgId, asMember } = await setup();
    const openId = await t.run(async (ctx) => {
      const story = { orgId, teamId, kind: "story", priority: "none", creatorId: memberId } as const;
      for (let i = 0; i < PAGE_READ_ROWS + 1_000; i++) {
        await ctx.db.insert("issues", { ...story, title: `Shipped ${i}`, status: "done", sortOrder: 10_000 + i });
      }
      return await ctx.db.insert("issues", { ...story, title: "Open", status: "todo", sortOrder: 0 });
    });

    const pages = await backlogPages((cursor) =>
      asMember.query(api.issues.listBacklog, { teamId, paginationOpts: { numItems: LIST_LIMIT, cursor } })
    );

    expect(pages[0]).toEqual([]);
    expect(pages.flat().map((issue) => issue._id)).toEqual([openId]);
  }, 60_000);
});

describe("issues.listParentCandidates", () => {
  test("offers an older open feature to a story when the team has more than 500 newer issues", async () => {
    const { t, teamId, memberId, orgId, asMember } = await setup();
    const { openFeature } = await t.run(async (ctx) => {
      const base = {
        orgId,
        teamId,
        creatorId: memberId,
        priority: "none",
        sortOrder: 1000,
      } as const;
      const openFeature = await ctx.db.insert("issues", {
        ...base,
        kind: "feature",
        title: "Old open feature",
        status: "todo",
      });
      await ctx.db.insert("issues", { ...base, kind: "feature", title: "Shipped feature", status: "done" });
      await ctx.db.insert("issues", { ...base, kind: "epic", title: "Open epic", status: "todo" });
      for (let i = 0; i < 501; i++) {
        await ctx.db.insert("issues", { ...base, kind: "story", title: `Newer ${i}`, status: "todo" });
      }
      return { openFeature };
    });

    const candidates = await asMember.query(api.issues.listParentCandidates, {
      teamId,
      kind: "story",
    });

    expect(candidates.map((issue) => issue._id)).toEqual([openFeature]);
  });

  test("offers no parent to an epic", async () => {
    const { t, teamId, memberId, orgId, asMember } = await setup();
    await t.run(async (ctx) => {
      await ctx.db.insert("issues", {
        orgId,
        teamId,
        kind: "epic",
        title: "Open epic",
        status: "todo",
        creatorId: memberId,
        priority: "none",
        sortOrder: 1000,
      });
    });

    const candidates = await asMember.query(api.issues.listParentCandidates, {
      teamId,
      kind: "epic",
    });

    expect(candidates).toEqual([]);
  });

  test("refuses a caller who is not a member of the active organization", async () => {
    const { t, teamId } = await setup();
    const asOutsider = t.withIdentity({
      subject: OUTSIDER_CLERK_ID,
      org_id: ORG_CLAIM,
    });
    await expect(
      asOutsider.query(api.issues.listParentCandidates, { teamId, kind: "story" })
    ).rejects.toThrow();
  });

  test("offers at most LIST_LIMIT parents, newest first", async () => {
    const { t, teamId, memberId, orgId, asMember } = await setup();
    const oldestFirst = await t.run(async (ctx) => {
      const ids = [];
      for (let i = 0; i <= LIST_LIMIT; i++) {
        ids.push(
          await ctx.db.insert("issues", {
            orgId,
            teamId,
            kind: "feature",
            title: `Feature ${i}`,
            status: i % 2 === 0 ? "todo" : "in_progress",
            priority: "none",
            creatorId: memberId,
            sortOrder: 1000,
          })
        );
      }
      return ids;
    });

    const candidates = await asMember.query(api.issues.listParentCandidates, { teamId, kind: "story" });

    expect(candidates.map((issue) => issue._id)).toEqual(oldestFirst.slice(1).reverse());
  });
});

describe("issues.update projectId: null", () => {
  async function setupProject() {
    const { t, teamId, orgId, asMember } = await setup();
    const projectId = await t.run(async (ctx) => {
      return await ctx.db.insert("projects", {
        orgId,
        name: "Phase 2",
        status: "planned",
      });
    });
    return { t, teamId, asMember, projectId };
  }

  test("refuses to clear the project a story inherits from its feature", async () => {
    const { teamId, asMember, projectId } = await setupProject();
    const epic = await asMember.mutation(api.issues.create, {
      teamId,
      kind: "epic",
      title: "Epic",
      projectId,
    });
    const feature = await asMember.mutation(api.issues.create, {
      teamId,
      kind: "feature",
      title: "Feature",
      parentIssueId: epic,
    });
    const story = await asMember.mutation(api.issues.create, {
      teamId,
      title: "Story",
      parentIssueId: feature,
    });

    await expect(
      asMember.mutation(api.issues.update, { issueId: story, projectId: null })
    ).rejects.toThrow("project comes from its feature");

    const after = await asMember.query(api.issues.get, { issueId: story });
    expect(after!.projectId).toBe(projectId);
  });

  test("clears the project of a standalone story", async () => {
    const { teamId, asMember, projectId } = await setupProject();
    const story = await asMember.mutation(api.issues.create, {
      teamId,
      title: "Story",
      projectId,
    });

    await asMember.mutation(api.issues.update, { issueId: story, projectId: null });

    const after = await asMember.query(api.issues.get, { issueId: story });
    expect(after!.projectId).toBeUndefined();
  });
});

describe("issues.update with an unchanged project", () => {
  test("saves an epic with many features without walking its tree", async () => {
    const { t, teamId, memberId, orgId, asMember } = await setup({ documentsRead: 30 });
    const { epic, projectId } = await t.run(async (ctx) => {
      const projectId = await ctx.db.insert("projects", {
        orgId,
        name: "Phase 2",
        status: "planned",
      });
      const fields = {
        orgId,
        teamId,
        status: "todo",
        priority: "none",
        creatorId: memberId,
        projectId,
        sortOrder: 0,
      } as const;
      const epic = await ctx.db.insert("issues", { ...fields, kind: "epic", title: "Epic" });
      for (let i = 0; i < 40; i++) {
        await ctx.db.insert("issues", {
          ...fields,
          kind: "feature",
          title: `Feature ${i}`,
          parentIssueId: epic,
        });
      }
      return { epic, projectId };
    });

    await asMember.mutation(api.issues.update, { issueId: epic, projectId, title: "Renamed" });

    const after = await asMember.query(api.issues.get, { issueId: epic });
    expect(after).toMatchObject({ title: "Renamed", projectId });
  });
});

/** Stories in To Do at the given ranks, inserted in order, so each is newer than the one before. */
async function storiesAt({ t, orgId, teamId, memberId }: Seed, ranks: Record<string, number>) {
  return await t.run(async (ctx) => {
    const story = { orgId, teamId, kind: "story", status: "todo", priority: "none", creatorId: memberId } as const;
    const ids: Record<string, Id<"issues">> = {};
    for (const [title, sortOrder] of Object.entries(ranks)) {
      ids[title] = await ctx.db.insert("issues", { ...story, title, sortOrder });
    }
    return ids;
  });
}

const ranksOf = (t: Setup["t"], ids: Id<"issues">[]) =>
  t.run(async (ctx) => Promise.all(ids.map(async (id) => (await ctx.db.get(id))!.sortOrder)));

describe("issue ranking", () => {
  test("ranks each new issue above the highest rank, even one re-ranked after it was created", async () => {
    const { teamId, asMember } = await setup();
    const older = await asMember.mutation(api.issues.create, { teamId, title: "Older" });
    const newer = await asMember.mutation(api.issues.create, { teamId, title: "Newer" });
    const newerRank = (await asMember.query(api.issues.get, { issueId: newer }))!.sortOrder;
    await asMember.mutation(api.issues.update, { issueId: older, sortOrder: newerRank + 1000 });

    const first = await asMember.mutation(api.issues.create, { teamId, title: "First" });
    const second = await asMember.mutation(api.issues.create, { teamId, title: "Second" });

    const rank = async (issueId: typeof older) =>
      (await asMember.query(api.issues.get, { issueId }))!.sortOrder;
    expect(await rank(first)).toBeGreaterThan(await rank(older));
    expect(await rank(second)).toBeGreaterThan(await rank(first));
  });

  test("moving a story between two tied neighbours lands strictly between them, the pair in the order the list shows", async () => {
    const s = await setup();
    const { teamId, asMember } = s;
    const { older, newer, moved } = await storiesAt(s, { older: 5000, newer: 5000, moved: 1000 });
    const { page: before } = await asMember.query(api.issues.listBacklog, { teamId, paginationOpts: FIRST_PAGE });
    expect(before.map((issue) => issue._id)).toEqual([newer, older, moved]);

    await asMember.mutation(api.issues.update, { issueId: moved, sortOrder: 5000 });

    const { page: backlog } = await asMember.query(api.issues.listBacklog, { teamId, paginationOpts: FIRST_PAGE });
    expect(new Set(backlog.map((issue) => issue.sortOrder)).size).toBe(3);
    expect(backlog.map((issue) => issue._id)).toEqual([newer, moved, older]);
  });

  test("moving a story into a tie whose gap to the next higher rank holds no new number widens the run upward", async () => {
    const s = await setup();
    const { t, teamId, asMember } = s;
    const rows = await storiesAt(s, {
      top: 2000,
      up2: 1000.0000000000002,
      up1: 1000.0000000000001,
      tie: 1000,
      bottom: 0,
      moved: -5000,
    });

    await asMember.mutation(api.issues.update, { issueId: rows.moved, sortOrder: 1000 });

    const { page: backlog } = await asMember.query(api.issues.listBacklog, { teamId, paginationOpts: FIRST_PAGE });
    const ranks = backlog.map((issue) => issue.sortOrder);
    expect(new Set(ranks).size).toBe(6);
    expect(backlog.map((issue) => issue._id)).toEqual([rows.top, rows.up2, rows.up1, rows.tie, rows.moved, rows.bottom]);
    expect(await ranksOf(t, [rows.top, rows.moved, rows.bottom])).toEqual([2000, 1000, 0]);
  });

});

describe("a tie repair goes upward and keeps the order the list shows", () => {
  test("a story dropped between a story and its testing sub-task, tied at one rank, lands between them with the pair in order", async () => {
    const { teamId, asMember } = await setup();
    const story = await asMember.mutation(api.issues.create, { teamId, title: "S", kind: "story" });
    const dropped = await asMember.mutation(api.issues.create, { teamId, title: "X", kind: "story" });
    const { page: before } = await asMember.query(api.issues.listByTeam, { teamId, paginationOpts: FIRST_PAGE });
    const testing = before.find((issue) => issue.parentIssueId === story)!._id;
    const tie = before.find((issue) => issue._id === story)!.sortOrder;

    await asMember.mutation(api.issues.update, { issueId: dropped, sortOrder: tie });

    const { page } = await asMember.query(api.issues.listByTeam, { teamId, paginationOpts: FIRST_PAGE });
    const order = page.map((issue) => issue._id).filter((id) => [story, testing, dropped].includes(id));
    expect(order).toEqual([testing, dropped, story]);
    expect(Math.min(...page.map((issue) => issue.sortOrder))).toBeGreaterThanOrEqual(tie);
  });

  test("a story moved into a tie of three lands inside the tied run, which keeps its order above the tie", async () => {
    const s = await setup();
    const { t, teamId, asMember } = s;
    const { first, second, third, moved } = await storiesAt(s, { first: 5000, second: 5000, third: 5000, moved: 1000 });

    await asMember.mutation(api.issues.update, { issueId: moved, sortOrder: 5000 });

    const { page: backlog } = await asMember.query(api.issues.listBacklog, { teamId, paginationOpts: FIRST_PAGE });
    expect(backlog.map((issue) => issue._id)).toEqual([third, second, moved, first]);
    expect(Math.min(...(await ranksOf(t, [first, second, third, moved])))).toBe(5000);
  });

  test("a tie repair leaves a row of another workspace that names the team untouched, and spaces within the team's own gap", async () => {
    const s = await setup();
    const { t, teamId, memberId, asMember } = s;
    const rows = await storiesAt(s, { top: 7000, older: 5000, newer: 5000, moved: 1000 });
    const foreign = await t.run(async (ctx) => {
      const orgId = await ctx.db.insert("organizations", { clerkOrgId: "org_other", name: "Other", slug: "other" });
      const fields = { orgId, teamId, kind: "story", status: "todo", priority: "none", creatorId: memberId } as const;
      return await ctx.db.insert("issues", { ...fields, title: "Foreign", sortOrder: 5500 });
    });
    const foreignBefore = await t.run((ctx) => ctx.db.get(foreign));

    await asMember.mutation(api.issues.update, { issueId: rows.moved, sortOrder: 5000 });

    expect(await t.run((ctx) => ctx.db.get(foreign))).toEqual(foreignBefore);
    const [newer, moved, older] = await ranksOf(t, [rows.newer, rows.moved, rows.older]);
    expect(newer).toBeGreaterThan(5500);
    expect([newer > moved, moved > older, older === 5000]).toEqual([true, true, true]);
  });
});

test("PINNED_PAGE_MAX_ROWS covers a pinned page that grew to twice LIST_LIMIT (an arithmetic guard; the read itself is checked in listByTeam.test.ts)", () => {
  expect(PINNED_PAGE_MAX_ROWS).toBeGreaterThanOrEqual(2 * LIST_LIMIT);
});

describe("the assignee is a member of the workspace", () => {
  const refused = { code: "not_found", message: "Assignee not found" };

  /** The outsider is a member of another workspace, so its id is one a caller could learn. */
  async function setupWithOutsider() {
    const s = await setup();
    const outsiderId = await s.t.run(async (ctx) => {
      const outsider = await ctx.db
        .query("users")
        .withIndex("by_clerk_id", (q) => q.eq("clerkId", OUTSIDER_CLERK_ID))
        .unique();
      const otherOrgId = await ctx.db.insert("organizations", {
        clerkOrgId: "org_other",
        name: "Other Org",
        slug: "other-org",
      });
      await ctx.db.insert("members", {
        orgId: otherOrgId,
        userId: outsider!._id,
        role: "member",
        clerkMembershipId: "mem_outsider",
      });
      return outsider!._id;
    });
    return { ...s, outsiderId };
  }

  test("create refuses another workspace's user without naming them and writes nothing", async () => {
    const { t, teamId, outsiderId, asMember } = await setupWithOutsider();
    const error = await asMember
      .mutation(api.issues.create, { teamId, title: "Story", assigneeId: outsiderId })
      .catch((thrown: unknown) => thrown);

    expect(refusalOf(error)).toEqual(refused);
    expect(String(error)).not.toContain("Outsider");
    expect(await t.run((ctx) => ctx.db.query("issues").collect())).toEqual([]);
  });

  test("update refuses another workspace's user without naming them; the member stays and can be unassigned", async () => {
    const { t, teamId, memberId, outsiderId, asMember } = await setupWithOutsider();
    const issueId = await asMember.mutation(api.issues.create, { teamId, title: "Story", assigneeId: memberId });
    const assignee = async () => (await t.run((ctx) => ctx.db.get(issueId)))?.assigneeId;
    expect(await assignee()).toBe(memberId);

    const error = await asMember
      .mutation(api.issues.update, { issueId, assigneeId: outsiderId })
      .catch((thrown: unknown) => thrown);
    expect(refusalOf(error)).toEqual(refused);
    expect(String(error)).not.toContain("Outsider");
    expect(await assignee()).toBe(memberId);

    await asMember.mutation(api.issues.update, { issueId, assigneeId: null });
    expect(await assignee()).toBeUndefined();
  });
});

describe("a title is never blank", () => {
  const blank = { code: "validation", message: "Title cannot be empty" };

  const rest = (t: Awaited<ReturnType<typeof setup>>["t"], method: string, path: string, body: unknown) =>
    t.fetch(`/api/v1/issues${path}`, {
      method,
      headers: writeHeaders(),
      body: JSON.stringify(body),
    });

  beforeEach(() => {
    process.env.HX_WORKSPACE_ORG_ID = ORG_CLAIM;
  });

  afterEach(() => {
    delete process.env.HX_WORKSPACE_ORG_ID;
  });

  async function written(t: Awaited<ReturnType<typeof setup>>["t"]) {
    return await t.run(async (ctx) => ({
      issues: await ctx.db.query("issues").collect(),
      activity: await ctx.db.query("activity").collect(),
    }));
  }

  test("a create with an all-blank title is refused as validation and writes nothing", async () => {
    const { t, teamId, asMember } = await setup();

    const error = await asMember.mutation(api.issues.create, { teamId, title: "  " }).catch(refusalOf);

    expect(error).toEqual(blank);
    expect(await written(t)).toEqual({ issues: [], activity: [] });
    expect((await t.run((ctx) => ctx.db.get(teamId)))?.nextIssueNumber).toBe(FIRST_NUMBER);
  });

  test("an update to an all-blank title is refused as validation and changes nothing", async () => {
    const { t, teamId, asMember } = await setup();
    const issueId = await asMember.mutation(api.issues.create, { teamId, title: "  Story  " });
    const before = await written(t);
    expect(before.issues.find((issue) => issue._id === issueId)?.title).toBe("Story");

    const error = await asMember.mutation(api.issues.update, { issueId, title: " \t " }).catch(refusalOf);

    expect(error).toEqual(blank);
    expect(await written(t)).toEqual(before);
  });

  test("REST POST with an all-blank title is 400 validation and creates nothing", async () => {
    const { t } = await setup();

    const response = await rest(t, "POST", "", { teamKey: "ENG", title: "  " });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(blank);
    expect(await written(t)).toEqual({ issues: [], activity: [] });
  });

  test("REST PATCH with an empty title is 400 validation and changes nothing", async () => {
    const { t } = await setup();
    expect((await rest(t, "POST", "", { teamKey: "ENG", title: "Story" })).status).toBe(201);
    const before = await written(t);

    const response = await rest(t, "PATCH", `/ENG-${FIRST_NUMBER}`, { title: "" });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(blank);
    expect(await written(t)).toEqual(before);
  });
});

describe("issue write branches", () => {
  // Catches a create that still reads the parent with its own lookup, which says "Issue not found", instead of only
  // through `assertValidParent`, which says "Parent issue not found"; or one that writes an issue anyway.
  test("create with a missing parent refuses with Parent issue not found", async () => {
    const s = await setup();
    const goneId = await s.asMember.mutation(api.issues.create, { teamId: s.teamId, title: "Gone" });
    await s.t.run((ctx) => ctx.db.delete(goneId));
    const issuesBefore = await s.issueCount();

    const error = await s.asMember
      .mutation(api.issues.create, { teamId: s.teamId, kind: "subtask", parentIssueId: goneId, title: "Orphan" })
      .catch(refusalOf);

    expect(error).toEqual({ code: "not_found", message: "Parent issue not found" });
    expect(await s.issueCount()).toBe(issuesBefore);
  });

  // Catches a create that reads the parent before `assertValidParent`'s project check, so an epic with no project
  // and a missing parent hears "Issue not found" instead of "An epic needs a project"; or one that writes an issue.
  test("create with no project and a missing parent refuses for the project first", async () => {
    const s = await setup();
    const goneId = await s.asMember.mutation(api.issues.create, { teamId: s.teamId, title: "Gone" });
    await s.t.run((ctx) => ctx.db.delete(goneId));
    const issuesBefore = await s.issueCount();

    const error = await s.asMember
      .mutation(api.issues.create, { teamId: s.teamId, kind: "epic", parentIssueId: goneId, title: "Unplaced" })
      .catch(refusalOf);

    expect(error).toEqual({ code: "rule_refused", message: "An epic needs a project" });
    expect(await s.issueCount()).toBe(issuesBefore);
  });

  // Catches an update that stores the title untrimmed, or logs and bumps a padded copy of the same title.
  test("update trims the title", async () => {
    const s = await setup();
    const storyId = await s.asMember.mutation(api.issues.create, { teamId: s.teamId, title: "Story" });

    await s.asMember.mutation(api.issues.update, { issueId: storyId, title: "  Renamed  " });

    expect((await s.issue(storyId)).title).toBe("Renamed");
    expect((await s.feed(storyId)).at(-1)).toMatchObject({
      type: "title_changed",
      field: "title",
      oldValue: "Story",
      newValue: "Renamed",
    });
    const before = await s.footprint(storyId);
    await s.asMember.mutation(api.issues.update, { issueId: storyId, title: " Renamed\t" });
    expect(await s.footprint(storyId)).toEqual(before);
  });

  // Catches a description step that writes, logs or bumps the version when the text is unchanged.
  test("update with the same description writes no activity and no version bump", async () => {
    const s = await setup();
    const storyId = await s.asMember.mutation(api.issues.create, {
      teamId: s.teamId,
      title: "Story",
      description: "Notes",
    });
    const before = await s.footprint(storyId);

    await s.asMember.mutation(api.issues.update, { issueId: storyId, description: "Notes" });

    expect(await s.footprint(storyId)).toEqual(before);
    expect((await s.issue(storyId)).description).toBe("Notes");
  });

  // Catches a priority step that writes, logs or bumps the version when the priority is unchanged.
  test("update with the same priority writes no activity and no version bump", async () => {
    const s = await setup();
    const storyId = await s.asMember.mutation(api.issues.create, { teamId: s.teamId, title: "Story", priority: "high" });
    const before = await s.footprint(storyId);

    await s.asMember.mutation(api.issues.update, { issueId: storyId, priority: "high" });

    expect(await s.footprint(storyId)).toEqual(before);
    expect((await s.issue(storyId)).priority).toBe("high");
  });

  // Catches a rank step that re-ranks, logs or bumps the version when the sort order is unchanged.
  test("update with the same sortOrder writes no activity and no version bump", async () => {
    const s = await setup();
    const storyId = await s.asMember.mutation(api.issues.create, { teamId: s.teamId, title: "Story" });
    const { sortOrder } = await s.issue(storyId);
    const before = await s.footprint(storyId);

    await s.asMember.mutation(api.issues.update, { issueId: storyId, sortOrder });

    expect(await s.footprint(storyId)).toEqual(before);
    expect((await s.issue(storyId)).sortOrder).toBe(sortOrder);
  });

  // Catches a project step that lets a child take a project other than the one its parent passes down.
  test("update to a project other than the parent's refuses", async () => {
    const s = await setup();
    const inherited = await s.project("Phase 1");
    const other = await s.project("Phase 2");
    const storyId = await s.asMember.mutation(api.issues.create, { teamId: s.teamId, title: "Story", projectId: inherited });
    const subtaskId = await s.asMember.mutation(api.issues.create, {
      teamId: s.teamId,
      kind: "subtask",
      parentIssueId: storyId,
      title: "Write API",
    });
    const before = await s.footprint(subtaskId);

    const error = await s.asMember
      .mutation(api.issues.update, { issueId: subtaskId, projectId: other })
      .catch(refusalOf);

    expect(error).toEqual({ code: "rule_refused", message: "A subtask's project must match its story's project" });
    expect((await s.issue(subtaskId)).projectId).toBe(inherited);
    expect(await s.footprint(subtaskId)).toEqual(before);
  });

  // Catches an estimate step that drops the cleared key, so the estimate stays and no row is logged.
  test("update estimate null clears it and logs the clear", async () => {
    const s = await setup();
    const storyId = await s.asMember.mutation(api.issues.create, { teamId: s.teamId, title: "Story", estimate: 3 });
    const rowsBefore = (await s.feed(storyId)).length;

    await s.asMember.mutation(api.issues.update, { issueId: storyId, estimate: null });

    expect(await s.issue(storyId)).not.toHaveProperty("estimate");
    const rows = await s.feed(storyId);
    expect(rows).toHaveLength(rowsBefore + 1);
    expect(rows.at(-1)).toMatchObject({ type: "estimate_changed", field: "estimate", oldValue: "3" });
    expect(rows.at(-1)!.newValue).toBeUndefined();
  });

  // Catches a due-date step that drops the cleared key, so the due date stays and no row is logged.
  test("update dueDate null clears it and logs the clear", async () => {
    const s = await setup();
    const dueDate = 1700000000000;
    const storyId = await s.asMember.mutation(api.issues.create, { teamId: s.teamId, title: "Story", dueDate });
    const rowsBefore = (await s.feed(storyId)).length;

    await s.asMember.mutation(api.issues.update, { issueId: storyId, dueDate: null });

    expect(await s.issue(storyId)).not.toHaveProperty("dueDate");
    const rows = await s.feed(storyId);
    expect(rows).toHaveLength(rowsBefore + 1);
    expect(rows.at(-1)).toMatchObject({ type: "dueDate_changed", field: "dueDate", oldValue: String(dueDate) });
    expect(rows.at(-1)!.newValue).toBeUndefined();
  });
});
