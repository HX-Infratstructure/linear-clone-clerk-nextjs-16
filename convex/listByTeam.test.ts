/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { LIST_LIMIT, MAX_LABELS_PER_ISSUE } from "../lib/api-contract";
import { byRank } from "../lib/sort-order";
import { api } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { insertOrgMember, MEMBER_IDENTITY } from "./lib/orgMember.fixture";
import { PAGE_READ_ROWS } from "./lib/paging";
import schema, { issueStatusValidator } from "./schema";

const modules = import.meta.glob("./**/*.*s");

const STATUSES = issueStatusValidator.members.map((member) => member.value);

type Opts = { numItems: number; cursor: string | null; endCursor?: string | null };
type Setup = Awaited<ReturnType<typeof setup>>;

/** Our workspace with one team and one member, and another workspace. */
async function setup(transactionLimits: { databaseQueries?: number } | boolean = false) {
  const t = convexTest({ schema, modules, transactionLimits });
  const ids = await t.run(async (ctx) => {
    const { orgId, memberId } = await insertOrgMember(ctx);
    const otherOrgId = await ctx.db.insert("organizations", { clerkOrgId: "org_other", name: "Other", slug: "other" });
    const teamId = await ctx.db.insert("teams", { orgId, name: "Engineering", key: "ENG", nextIssueNumber: 1 });
    return { memberId, orgId, otherOrgId, teamId };
  });
  const asMember = t.withIdentity(MEMBER_IDENTITY);
  const story = { teamId: ids.teamId, kind: "story", status: "todo", priority: "none", creatorId: ids.memberId } as const;
  return { t, asMember, story, ...ids };
}

type Page = { page: { _id: Id<"issues"> }[]; isDone: boolean; continueCursor: string };

/** Every page, following the cursor until the last page. */
async function allPages<P extends Page>(pageAt: (cursor: string | null) => Promise<P>) {
  const pages: P["page"][] = [];
  let cursor: string | null = null;
  for (;;) {
    const result: P = await pageAt(cursor);
    pages.push(result.page);
    if (result.isDone) {
      return pages;
    }
    cursor = result.continueCursor;
  }
}

const RANKED_QUERIES = [
  {
    name: "listBacklog",
    list: (s: Setup, paginationOpts: Opts) => s.asMember.query(api.issues.listBacklog, { teamId: s.teamId, paginationOpts }),
  },
  {
    name: "listByTeam",
    list: (s: Setup, paginationOpts: Opts) => s.asMember.query(api.issues.listByTeam, { teamId: s.teamId, paginationOpts }),
  },
];

describe.each(RANKED_QUERIES)("issues.$name over the team's rank index", ({ list }) => {
  test("rows from another workspace that name the team appear on no page", async () => {
    const s = await setup();
    const ours = await s.t.run(async (ctx) => {
      const ids = [];
      for (const sortOrder of [5000, 4000, 3000, 2000, 1000, 0]) {
        const foreign = sortOrder % 2000 === 0;
        const id = await ctx.db.insert("issues", { ...s.story, orgId: foreign ? s.otherOrgId : s.orgId, title: `Row ${sortOrder}`, sortOrder });
        if (!foreign) {
          ids.push(id);
        }
      }
      return ids;
    });

    const pages = await allPages((cursor) => list(s, { numItems: 1, cursor }));

    expect(pages.flat().map((issue) => issue._id)).toEqual(ours);
  });

  test("a page stops after PAGE_READ_ROWS rows, and the cursor reaches our story ranked below more foreign ones", async () => {
    const s = await setup();
    const oursId = await s.t.run(async (ctx) => {
      for (let i = 0; i < PAGE_READ_ROWS + 1_000; i++) {
        await ctx.db.insert("issues", { ...s.story, orgId: s.otherOrgId, title: `Foreign ${i}`, sortOrder: 10_000 + i });
      }
      return await ctx.db.insert("issues", { ...s.story, orgId: s.orgId, title: "Ours", sortOrder: 0 });
    });

    const pages = await allPages((cursor) => list(s, { numItems: LIST_LIMIT, cursor }));

    expect(pages[0]).toEqual([]);
    expect(pages.flat().map((issue) => issue._id)).toEqual([oursId]);
  }, 60_000);
});

/**
 * `LIST_LIMIT + 1` issues across every status, ranked in tied pairs out of creation order, some with labels. The
 * oldest, an open Todo story in a cycle with two labels, ranks last. Returns the ids in rank order and each issue's
 * label ids.
 */
async function seedTeamPastLimit(s: Setup) {
  return await s.t.run(async (ctx) => {
    const { orgId, teamId } = s;
    const cycleId = await ctx.db.insert("cycles", { orgId, teamId, number: 1, startDate: 0, endDate: 1 });
    const labelIds = [
      await ctx.db.insert("labels", { orgId, name: "Bug", color: "#ff0000" }),
      await ctx.db.insert("labels", { orgId, name: "UI", color: "#0000ff" }),
    ];
    const labelsOf: Record<Id<"issues">, Id<"labels">[]> = {};
    async function insert(row: Pick<Doc<"issues">, "title" | "kind" | "status" | "sortOrder" | "cycleId">, labels: Id<"labels">[]) {
      const issueId = await ctx.db.insert("issues", { ...s.story, orgId, ...row });
      for (const labelId of labels) {
        await ctx.db.insert("issueLabels", { issueId, labelId });
      }
      labelsOf[issueId] = labels;
      return issueId;
    }
    const oldestId = await insert({ title: "Oldest", kind: "story", status: "todo", sortOrder: 0, cycleId }, labelIds);
    for (let i = 1; i <= LIST_LIMIT; i++) {
      const kind = i % 4 === 0 ? "subtask" : "story";
      const sortOrder = (Math.floor(((i * 37) % LIST_LIMIT) / 2) + 1) * 1000;
      await insert({ title: `Issue ${i}`, kind, status: STATUSES[i % STATUSES.length], sortOrder }, labelIds.slice(0, i % 3));
    }
    const rows = await ctx.db.query("issues").withIndex("by_team", (q) => q.eq("teamId", teamId)).collect();
    return { rankOrder: rows.sort(byRank).map((row) => row._id), oldestId, labelsOf, labelIds };
  });
}

/** `count` issues ranked above every earlier one, each linked to `MAX_LABELS_PER_ISSUE` of the shared labels. */
async function seedLabelled(s: Setup, labelIds: Id<"labels">[], count: number, firstRank: number) {
  for (let batch = 0; batch < count / 100; batch++) {
    await s.t.run(async (ctx) => {
      for (let i = 0; i < 100; i++) {
        const n = firstRank + batch * 100 + i;
        const issueId = await ctx.db.insert("issues", { ...s.story, orgId: s.orgId, title: `Labelled ${n}`, sortOrder: n });
        for (let l = 0; l < MAX_LABELS_PER_ISSUE; l++) {
          await ctx.db.insert("issueLabels", { issueId, labelId: labelIds[(n + l) % labelIds.length] });
        }
      }
    });
  }
}

describe("issues.listByTeam pages", () => {
  test("following the cursor reaches the oldest issue, an open Todo story in a cycle ranked last, with every row once in rank order", async () => {
    const s = await setup();
    const { rankOrder, oldestId } = await seedTeamPastLimit(s);

    const pages = await allPages((cursor) =>
      s.asMember.query(api.issues.listByTeam, { teamId: s.teamId, paginationOpts: { numItems: LIST_LIMIT + 100, cursor } })
    );

    const rows = pages.flat();
    expect(pages[0]).toHaveLength(LIST_LIMIT);
    expect(rows.map((issue) => issue._id)).toEqual(rankOrder);
    expect(rows.at(-1)?._id).toBe(oldestId);
  });

  test("every row carries its labelIds, the oldest included", async () => {
    const s = await setup();
    const { oldestId, labelsOf, labelIds } = await seedTeamPastLimit(s);

    const pages = await allPages((cursor) =>
      s.asMember.query(api.issues.listByTeam, { teamId: s.teamId, paginationOpts: { numItems: LIST_LIMIT, cursor } })
    );

    const listed = Object.fromEntries(pages.flat().map((issue) => [issue._id, issue.labelIds]));
    expect(listed).toEqual(labelsOf);
    expect(listed[oldestId]).toEqual(labelIds);
  });

  test("a page pinned by its end cursor that grew to twice LIST_LIMIT, MAX_LABELS_PER_ISSUE links per issue over 50 shared labels, stays inside Convex's transaction limits", async () => {
    const s = await setup(true);
    const labelIds = await s.t.run(async (ctx) => {
      const ids = [];
      for (let i = 0; i < 50; i++) {
        ids.push(await ctx.db.insert("labels", { orgId: s.orgId, name: `Label ${i}`, color: "#5e6ad2" }));
      }
      return ids;
    });
    await seedLabelled(s, labelIds, LIST_LIMIT, 0);
    const first = await s.asMember.query(api.issues.listByTeam, { teamId: s.teamId, paginationOpts: { numItems: LIST_LIMIT, cursor: null } });
    await seedLabelled(s, labelIds, LIST_LIMIT, LIST_LIMIT);

    const pinned = await s.asMember.query(api.issues.listByTeam, {
      teamId: s.teamId,
      paginationOpts: { numItems: LIST_LIMIT, cursor: null, endCursor: first.continueCursor },
    });

    expect(pinned.page).toHaveLength(2 * LIST_LIMIT);
    expect(pinned.page.every((issue) => issue.labelIds.length === MAX_LABELS_PER_ISSUE)).toBe(true);
  }, 120_000);

  test("the hook's load and split protocol, over byte-heavy rows that make a page SplitRequired, keeps the loaded rows a rank prefix, per status too", async () => {
    const s = await setup();
    const allByRank = await s.t.run(async (ctx) => {
      let n = 0;
      const ours = (sortOrder: number, description?: string) =>
        ctx.db.insert("issues", { ...s.story, orgId: s.orgId, title: `Ours ${n}`, status: STATUSES[n++ % STATUSES.length], sortOrder, description });
      for (let i = 0; i < 100; i++) {
        await ours(1e9 - i);
      }
      for (let i = 0; i < PAGE_READ_ROWS + 500; i++) {
        await ctx.db.insert("issues", { ...s.story, orgId: s.otherOrgId, title: `Foreign ${i}`, sortOrder: 1e8 - i });
      }
      const heavy = "x".repeat(20 * 1024);
      for (let i = 0; i < 450; i++) {
        await ours(1e7 - i, heavy);
      }
      for (let i = 0; i < 200; i++) {
        await ours(1e6 - Math.floor(i / 2));
        if (i % 50 === 0) {
          await ctx.db.insert("issues", { ...s.story, orgId: s.otherOrgId, title: `Foreign low ${i}`, status: "done", sortOrder: 1e6 - i });
        }
      }
      const rows = await ctx.db.query("issues").withIndex("by_team", (q) => q.eq("teamId", s.teamId)).collect();
      return rows
        .filter((row) => row.orgId === s.orgId)
        .sort(byRank)
        .map(({ _id, status }) => ({ _id, status }));
    });
    expect(allByRank.length).toBeGreaterThan(LIST_LIMIT);

    const loaded: Pick<Doc<"issues">, "_id" | "status">[] = [];
    let splitRequiredPages = 0;
    function expectRankPrefix() {
      expect(loaded.map((row) => row._id)).toEqual(allByRank.slice(0, loaded.length).map((row) => row._id));
      for (const status of STATUSES) {
        const column = loaded.filter((row) => row.status === status).map((row) => row._id);
        const top = allByRank.filter((row) => row.status === status).slice(0, column.length).map((row) => row._id);
        expect(column, `${status} column is that status's top ${column.length}`).toEqual(top);
      }
    }
    async function load(paginationOpts: Opts, depth = 0): Promise<{ continueCursor: string; isDone: boolean }> {
      const result = await s.asMember.query(api.issues.listByTeam, { teamId: s.teamId, paginationOpts });
      if (result.pageStatus === "SplitRequired") {
        splitRequiredPages += 1;
        expect(result.splitCursor, "SplitRequired without a splitCursor would stall the hook").toBeTruthy();
        expect(depth).toBeLessThan(20);
        expectRankPrefix();
        await load({ ...paginationOpts, endCursor: result.splitCursor! }, depth + 1);
        return await load({ ...paginationOpts, cursor: result.splitCursor!, endCursor: result.continueCursor }, depth + 1);
      }
      loaded.push(...result.page.map(({ _id, status }) => ({ _id, status })));
      expectRankPrefix();
      return result;
    }

    let last = await load({ numItems: LIST_LIMIT, cursor: null });
    for (let loadMores = 0; !last.isDone && loadMores < 50; loadMores++) {
      last = await load({ numItems: LIST_LIMIT, cursor: last.continueCursor });
    }

    expect(last.isDone).toBe(true);
    expect(loaded.map((row) => row._id)).toEqual(allByRank.map((row) => row._id));
    expect(splitRequiredPages).toBeGreaterThan(0);
  }, 300_000);
});

describe("issues.listByTeam label reads", () => {
  test("a page reads one index range per row, however many labels its rows carry, and returns each row's linked label ids in link order", async () => {
    const ROWS = 10;
    const USER_WORKSPACE_MEMBERSHIP_LOOKUPS = 3;
    const TEAM_GET = 1;
    const PAGE_QUERY = 1;
    const s = await setup({ databaseQueries: USER_WORKSPACE_MEMBERSHIP_LOOKUPS + TEAM_GET + PAGE_QUERY + ROWS });
    const linked = await s.t.run(async (ctx) => {
      const labelIds = [];
      for (let i = 0; i < 3 * ROWS; i++) {
        labelIds.push(await ctx.db.insert("labels", { orgId: s.orgId, name: `Label ${i}`, color: "#5e6ad2" }));
      }
      const labelsOf: Record<Id<"issues">, Id<"labels">[]> = {};
      for (let i = 0; i < ROWS; i++) {
        const issueId = await ctx.db.insert("issues", { ...s.story, orgId: s.orgId, title: `Issue ${i}`, sortOrder: i });
        // Linked against creation order, so only link order matches.
        labelsOf[issueId] = labelIds.slice(3 * i, 3 * i + 3).reverse();
        for (const labelId of labelsOf[issueId]) {
          await ctx.db.insert("issueLabels", { issueId, labelId });
        }
      }
      return labelsOf;
    });

    const { page } = await s.asMember.query(api.issues.listByTeam, { teamId: s.teamId, paginationOpts: { numItems: ROWS, cursor: null } });

    expect(Object.fromEntries(page.map((issue) => [issue._id, issue.labelIds]))).toEqual(linked);
  });
});
