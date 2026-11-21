/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { RELATION_LIMIT } from "./lib/issueRelations";
import { insertOrgMember, MEMBER_IDENTITY } from "./lib/orgMember.fixture";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");

async function setup() {
  const t = convexTest(schema, modules);
  const teamId = await t.run(async (ctx) => {
    const { orgId } = await insertOrgMember(ctx);
    return ctx.db.insert("teams", { orgId, name: "Citadel", key: "REL", nextIssueNumber: 1 });
  });
  const asMember = t.withIdentity(MEMBER_IDENTITY);
  let nextNumber = 1;

  /** Inserts `count` stories and returns their ids. */
  const stories = (count: number) =>
    t.run(async (ctx) => {
      const { orgId } = (await ctx.db.get(teamId))!;
      const creatorId = (await ctx.db.query("users").first())!._id;
      const ids: Id<"issues">[] = [];
      for (let index = 0; index < count; index++) {
        const number = nextNumber++;
        ids.push(
          await ctx.db.insert("issues", {
            orgId,
            teamId,
            kind: "story",
            number,
            title: `Story ${number}`,
            status: "todo",
            priority: "none",
            creatorId,
            sortOrder: number,
          })
        );
      }
      return ids;
    });

  /** Gives `issueId` `count` relations, half stored on it and half on the other end. */
  const relate = async (issueId: Id<"issues">, count: number) => {
    const others = await stories(count);
    await t.run(async (ctx) => {
      for (const [index, otherId] of others.entries()) {
        const stored = index % 2 === 0;
        await ctx.db.insert("issueRelations", {
          issueId: stored ? issueId : otherId,
          relatedIssueId: stored ? otherId : issueId,
          type: "blocks",
        });
      }
    });
  };

  const relationCount = () => t.run(async (ctx) => (await ctx.db.query("issueRelations").collect()).length);

  return { asMember, stories, relate, relationCount };
}

const REFUSED = { data: { code: "rule_refused", message: expect.stringMatching(`already has ${RELATION_LIMIT} relations`) } };

describe("issueRelations.create", () => {
  test("refuses a relation on an issue that holds the limit on both sides, and adds nothing", async () => {
    const { asMember, stories, relate, relationCount } = await setup();
    const [full, other] = await stories(2);
    await relate(full, RELATION_LIMIT);
    const before = await relationCount();

    await expect(
      asMember.mutation(api.issueRelations.create, { issueId: full, relatedIssueId: other, type: "related" })
    ).rejects.toMatchObject(REFUSED);
    expect(await relationCount()).toBe(before);
  });

  test("refuses a relation whose related issue holds the limit", async () => {
    const { asMember, stories, relate } = await setup();
    const [issue, full] = await stories(2);
    await relate(full, RELATION_LIMIT);

    await expect(
      asMember.mutation(api.issueRelations.create, { issueId: issue, relatedIssueId: full, type: "blocked_by" })
    ).rejects.toMatchObject(REFUSED);
  });

  test("links an issue one below the limit, and the list shows every relation in its direction", async () => {
    const { asMember, stories, relate } = await setup();
    const [issue, blocker] = await stories(2);
    await relate(issue, RELATION_LIMIT - 1);

    await asMember.mutation(api.issueRelations.create, { issueId: issue, relatedIssueId: blocker, type: "blocked_by" });

    const listed = await asMember.query(api.issueRelations.listForIssue, { issueId: issue });
    expect(listed).toHaveLength(RELATION_LIMIT);
    const directions = listed.map((relation) => relation.type);
    expect(directions.filter((type) => type === "blocks")).toHaveLength(RELATION_LIMIT / 2);
    expect(directions.filter((type) => type === "blocked_by")).toHaveLength(RELATION_LIMIT / 2);
    expect(listed.find((relation) => relation.issue._id === blocker)?.type).toBe("blocked_by");
  });

  test("refuses a pair that is already linked in either direction", async () => {
    const { asMember, stories } = await setup();
    const [first, second] = await stories(2);
    await asMember.mutation(api.issueRelations.create, { issueId: first, relatedIssueId: second, type: "blocks" });

    for (const [issueId, relatedIssueId] of [
      [first, second],
      [second, first],
    ]) {
      await expect(
        asMember.mutation(api.issueRelations.create, { issueId, relatedIssueId, type: "related" })
      ).rejects.toMatchObject({ data: { code: "rule_refused", message: "These issues are already linked" } });
    }
  });
});
