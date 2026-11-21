/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { insertOrgMember, MEMBER_IDENTITY } from "./lib/orgMember.fixture";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");

const REFUSED = /^Sprint A belongs to team OPS; pick a cycle from team ENG$/;

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const { orgId } = await insertOrgMember(ctx);
    const teamId = await ctx.db.insert("teams", { orgId, name: "Engineering", key: "ENG", nextIssueNumber: 1 });
    const otherTeamId = await ctx.db.insert("teams", { orgId, name: "Operations", key: "OPS", nextIssueNumber: 1 });
    const otherOrgId = await ctx.db.insert("organizations", {
      clerkOrgId: "org_other",
      name: "Other Org",
      slug: "other-org",
    });
    const foreignTeamId = await ctx.db.insert("teams", {
      orgId: otherOrgId,
      name: "Engineering",
      key: "ENG",
      nextIssueNumber: 1,
    });
    const span = { startDate: 1, endDate: 2 };
    const ownCycleId = await ctx.db.insert("cycles", { orgId, teamId, number: 1, ...span });
    const otherCycleId = await ctx.db.insert("cycles", {
      orgId,
      teamId: otherTeamId,
      number: 1,
      name: "Sprint A",
      ...span,
    });
    const foreignCycleId = await ctx.db.insert("cycles", {
      orgId: otherOrgId,
      teamId: foreignTeamId,
      number: 1,
      ...span,
    });
    return { teamId, ownCycleId, otherCycleId, foreignCycleId };
  });
  const asMember = t.withIdentity(MEMBER_IDENTITY);
  const cycleOf = (issueId: Id<"issues">) =>
    t.run(async (ctx) => (await ctx.db.get(issueId))?.cycleId ?? null);
  return { asMember, cycleOf, ...ids };
}

describe("an issue's cycle belongs to the issue's team", () => {
  test("creating with another team's cycle is refused", async () => {
    const { asMember, teamId, otherCycleId } = await setup();
    await expect(
      asMember.mutation(api.issues.create, { teamId, title: "Story", cycleId: otherCycleId })
    ).rejects.toMatchObject({ data: { code: "rule_refused", message: expect.stringMatching(REFUSED) } });
  });

  test("creating with another org's cycle is refused as not found", async () => {
    const { asMember, teamId, foreignCycleId } = await setup();
    await expect(
      asMember.mutation(api.issues.create, { teamId, title: "Story", cycleId: foreignCycleId })
    ).rejects.toMatchObject({ data: { code: "not_found", message: "Cycle not found" } });
  });

  test("updating to another team's cycle is refused and the cycle is unchanged", async () => {
    const { asMember, cycleOf, teamId, ownCycleId, otherCycleId } = await setup();
    const issueId = await asMember.mutation(api.issues.create, { teamId, title: "Story", cycleId: ownCycleId });
    await expect(
      asMember.mutation(api.issues.update, { issueId, cycleId: otherCycleId })
    ).rejects.toMatchObject({ data: { code: "rule_refused", message: expect.stringMatching(REFUSED) } });
    expect(await cycleOf(issueId)).toBe(ownCycleId);
  });

  test("the same team's cycle is accepted on create and update", async () => {
    const { asMember, cycleOf, teamId, ownCycleId } = await setup();
    const createdIn = await asMember.mutation(api.issues.create, { teamId, title: "One", cycleId: ownCycleId });
    expect(await cycleOf(createdIn)).toBe(ownCycleId);
    const moved = await asMember.mutation(api.issues.create, { teamId, title: "Two" });
    await asMember.mutation(api.issues.update, { issueId: moved, cycleId: ownCycleId });
    expect(await cycleOf(moved)).toBe(ownCycleId);
  });

  test("null clears the cycle", async () => {
    const { asMember, cycleOf, teamId, ownCycleId } = await setup();
    const issueId = await asMember.mutation(api.issues.create, { teamId, title: "Story", cycleId: ownCycleId });
    await asMember.mutation(api.issues.update, { issueId, cycleId: null });
    expect(await cycleOf(issueId)).toBeNull();
  });
});
