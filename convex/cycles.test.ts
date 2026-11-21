/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import { LIST_LIMIT } from "../lib/api-contract";
import { insertOrgMember, MEMBER_IDENTITY } from "./lib/orgMember.fixture";
import { CASCADE_BUDGET } from "./lib/orgRows";
import schema from "./schema";

vi.mock("./lib/orgRows", async (importOriginal) => {
  const original = await importOriginal<typeof import("./lib/orgRows")>();
  return { ...original, CASCADE_BUDGET: { ...original.CASCADE_BUDGET } };
});

const modules = import.meta.glob("./**/*.*s");

const DAY = 86_400_000;

async function setup(transactionLimits?: { documentsRead: number }) {
  const t = convexTest({ schema, modules, transactionLimits });
  const ids = await t.run(async (ctx) => {
    const { orgId, memberId: userId } = await insertOrgMember(ctx);
    const teamId = await ctx.db.insert("teams", { orgId, name: "Engineering", key: "ENG", nextIssueNumber: 1 });
    const cycleId = await ctx.db.insert("cycles", { orgId, teamId, number: 1, startDate: 0, endDate: Date.now() + DAY });
    return { orgId, userId, teamId, cycleId };
  });
  return { t, member: t.withIdentity(MEMBER_IDENTITY), ...ids };
}

describe("cycle dates", () => {
  test.each([
    ["create", (s: Awaited<ReturnType<typeof setup>>) =>
      s.member.mutation(api.cycles.create, { teamId: s.teamId, startDate: DAY, endDate: DAY })],
    ["update", (s: Awaited<ReturnType<typeof setup>>) =>
      s.member.mutation(api.cycles.update, { cycleId: s.cycleId, endDate: 0 })],
  ])("%s with an end date not after the start is a typed validation refusal", async (_name, write) => {
    await expect(write(await setup())).rejects.toMatchObject({
      data: { code: "validation", message: "Cycle end date must be after its start date" },
    });
  });
});

describe("a cycle with more than LIST_LIMIT issues", () => {
  test("lists LIST_LIMIT of them, and the index row's progress counts every one", async () => {
    const s = await setup();
    await s.t.run(async (ctx) => {
      for (let number = 1; number <= LIST_LIMIT + 1; number++) {
        await ctx.db.insert("issues", {
          orgId: s.orgId,
          teamId: s.teamId,
          kind: "story",
          number,
          title: `Story ${number}`,
          status: number <= LIST_LIMIT ? "done" : "todo",
          priority: "none",
          creatorId: s.userId,
          cycleId: s.cycleId,
          sortOrder: number,
        });
      }
    });

    const issues = await s.member.query(api.cycles.listIssues, { cycleId: s.cycleId });
    const [cycle] = await s.member.query(api.cycles.list, {});
    const row = await s.member.query(api.cycles.progress, { cycleId: cycle._id });

    const expected = { total: LIST_LIMIT + 1, done: LIST_LIMIT, todo: 1 };
    expect(issues).toHaveLength(LIST_LIMIT);
    expect(row).toMatchObject(expected);
  });
});

describe("cycles.list", () => {
  test("lists every cycle newest first within 10 document reads, so it reads no issues", async () => {
    const s = await setup({ documentsRead: 10 });
    await s.t.run(async (ctx) => {
      const cycleIds = [
        s.cycleId,
        await ctx.db.insert("cycles", { orgId: s.orgId, teamId: s.teamId, number: 2, startDate: DAY, endDate: 2 * DAY }),
        await ctx.db.insert("cycles", { orgId: s.orgId, teamId: s.teamId, number: 3, startDate: 2 * DAY, endDate: 3 * DAY }),
      ];
      let number = 0;
      for (const cycleId of cycleIds) {
        for (let i = 0; i < 20; i++) {
          number++;
          await ctx.db.insert("issues", {
            orgId: s.orgId,
            teamId: s.teamId,
            kind: "story",
            number,
            title: `Story ${number}`,
            status: "todo",
            priority: "none",
            creatorId: s.userId,
            cycleId,
            sortOrder: number,
          });
        }
      }
    });

    const cycles = await s.member.query(api.cycles.list, {});

    expect(cycles.map((cycle) => cycle.number)).toEqual([3, 2, 1]);
  });
});

describe("cycles.progress for the index rows", () => {
  test("each row's progress reads within 30 documents", async () => {
    const s = await setup({ documentsRead: 30 });
    await s.t.run(async (ctx) => {
      const cycleIds = [
        s.cycleId,
        await ctx.db.insert("cycles", { orgId: s.orgId, teamId: s.teamId, number: 2, startDate: DAY, endDate: 2 * DAY }),
        await ctx.db.insert("cycles", { orgId: s.orgId, teamId: s.teamId, number: 3, startDate: 2 * DAY, endDate: 3 * DAY }),
      ];
      let number = 0;
      for (const cycleId of cycleIds) {
        for (let i = 0; i < 20; i++) {
          number++;
          await ctx.db.insert("issues", {
            orgId: s.orgId,
            teamId: s.teamId,
            kind: "story",
            number,
            title: `Story ${number}`,
            status: "todo",
            priority: "none",
            creatorId: s.userId,
            cycleId,
            sortOrder: number,
          });
        }
      }
    });

    const cycles = await s.member.query(api.cycles.list, {});

    for (const cycle of cycles) {
      expect(await s.member.query(api.cycles.progress, { cycleId: cycle._id })).toMatchObject({
        total: 20,
        todo: 20,
      });
    }
  });
});

describe("cycles.remove past the cascade budget", () => {
  const TOO_MANY_ISSUES = "This cycle has more than 5 issues. Move some to another cycle before deleting it.";
  const real = { ...CASCADE_BUDGET };
  beforeEach(() => {
    Object.assign(CASCADE_BUDGET, { rows: 5, queries: 4 });
  });
  afterEach(() => {
    Object.assign(CASCADE_BUDGET, real);
  });

  const withStories = async (count: number, transactionLimits?: Parameters<typeof setup>[0]) => {
    const s = await setup(transactionLimits);
    await s.t.run(async (ctx) => {
      for (let number = 1; number <= count; number++) {
        await ctx.db.insert("issues", {
          orgId: s.orgId,
          teamId: s.teamId,
          kind: "story",
          number,
          title: `Story ${number}`,
          status: "todo",
          priority: "none",
          creatorId: s.userId,
          cycleId: s.cycleId,
          sortOrder: number,
        });
      }
    });
    return s;
  };
  const cyclesOf = async (s: Awaited<ReturnType<typeof setup>>) =>
    (await s.t.run((ctx) => ctx.db.query("issues").collect())).map((issue) => issue.cycleId);

  test("refuses a cycle with 6 issues past a cap of 5, and unschedules none", async () => {
    const s = await withStories(6);

    await expect(s.member.mutation(api.cycles.remove, { cycleId: s.cycleId })).rejects.toThrow(TOO_MANY_ISSUES);

    expect(await cyclesOf(s)).toEqual(Array(6).fill(s.cycleId));
  });

  test("deletes a cycle with 5 issues at the cap, and unschedules them all", async () => {
    const s = await withStories(5);

    await s.member.mutation(api.cycles.remove, { cycleId: s.cycleId });

    expect(await cyclesOf(s)).toEqual(Array(5).fill(undefined));
    expect(await s.t.run((ctx) => ctx.db.get(s.cycleId))).toBeNull();
  });

  test("refuses a cycle with 30 issues within 20 document reads, so it never reads all 30", async () => {
    const s = await withStories(30, { documentsRead: 20 });

    await expect(s.member.mutation(api.cycles.remove, { cycleId: s.cycleId })).rejects.toThrow(TOO_MANY_ISSUES);
  });
});
