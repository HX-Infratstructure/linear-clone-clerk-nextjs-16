/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import { insertOrgMember, MEMBER_IDENTITY } from "./lib/orgMember.fixture";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");

/** Two teams in our workspace with a "Board" issue each, and another workspace's "Board" issue that points at ENG. */
async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const { orgId, memberId: userId } = await insertOrgMember(ctx);
    const engId = await ctx.db.insert("teams", { orgId, name: "Engineering", key: "ENG", nextIssueNumber: 2 });
    const opsId = await ctx.db.insert("teams", { orgId, name: "Operations", key: "OPS", nextIssueNumber: 2 });
    // convex-test 0.0.54 throws on a search-index row without its search field, so each issue has a description.
    const issue = { kind: "story", status: "todo", priority: "none", creatorId: userId, number: 1, sortOrder: 1, description: "notes" } as const;
    const engIssueId = await ctx.db.insert("issues", { ...issue, orgId, teamId: engId, title: "Board drag fix" });
    const opsIssueId = await ctx.db.insert("issues", { ...issue, orgId, teamId: opsId, title: "Board backup" });
    const otherOrgId = await ctx.db.insert("organizations", { clerkOrgId: "org_other", name: "Other", slug: "other" });
    await ctx.db.insert("issues", { ...issue, orgId: otherOrgId, teamId: engId, title: "Board foreign" });
    return { engId, engIssueId, opsIssueId };
  });
  return { ...ids, member: t.withIdentity(MEMBER_IDENTITY) };
}

describe("search.issues", () => {
  // Catches: the teamId filter dropped from the search index query, or another workspace's issue that points at
  // our team returned. A cross-workspace or missing teamId is refused in orgRows.test.ts ("search.issues (Team)").
  test("with a teamId returns only that team's issues in our workspace, with the team's key and name", async () => {
    const s = await setup();
    const results = await s.member.query(api.search.issues, { query: "Board", teamId: s.engId });
    expect(results.map(({ _id, teamKey, teamName }) => ({ _id, teamKey, teamName }))).toEqual([
      { _id: s.engIssueId, teamKey: "ENG", teamName: "Engineering" },
    ]);
  });

  // Catches: the orgId filter dropped when no team is given.
  test("without a teamId returns every team's issues in our workspace and none from another", async () => {
    const s = await setup();
    const results = await s.member.query(api.search.issues, { query: "Board" });
    expect(results.map((issue) => issue._id).sort()).toEqual([s.engIssueId, s.opsIssueId].sort());
  });
});
