/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { insertOrgMember, MEMBER_IDENTITY } from "./lib/orgMember.fixture";
import schema from "./schema";
import { passDoneGate } from "./test-helpers.fixture";

const modules = import.meta.glob("./**/*.*s");

const REFUSED = /^Member already has ENG-1 In Progress; move it to In Review or Done first$/;

async function setup() {
  const t = convexTest(schema, modules);
  const { orgId, teamId, memberId, otherId } = await t.run(async (ctx) => {
    const { orgId, memberId } = await insertOrgMember(ctx);
    const otherId = await ctx.db.insert("users", {
      clerkId: "user_other",
      name: "Other",
      email: "other@example.com",
    });
    await ctx.db.insert("members", { orgId, userId: otherId, role: "member", clerkMembershipId: "mem_other" });
    const teamId = await ctx.db.insert("teams", {
      orgId,
      name: "Engineering",
      key: "ENG",
      nextIssueNumber: 1,
    });
    return { orgId, teamId, memberId, otherId };
  });
  const asMember = t.withIdentity(MEMBER_IDENTITY);
  const story = (title: string, assigneeId?: Id<"users">) =>
    asMember.mutation(api.issues.create, { teamId, title, assigneeId });
  const move = (issueId: Id<"issues">, status: "todo" | "in_progress" | "in_review" | "done") =>
    asMember.mutation(api.issues.update, { issueId, status });
  return { t, asMember, orgId, teamId, memberId, otherId, story, move };
}

describe("one story In Progress per person", () => {
  test("a second story moved to In Progress is refused and names the first", async () => {
    const { memberId, story, move } = await setup();
    const first = await story("First", memberId);
    const second = await story("Second", memberId);
    await move(first, "in_progress");

    await expect(move(second, "in_progress")).rejects.toMatchObject({ data: { code: "rule_refused", message: expect.stringMatching(REFUSED) } });
  });

  test("assigning an In Progress story to someone who holds one is refused", async () => {
    const { asMember, memberId, story, move } = await setup();
    const first = await story("First", memberId);
    const second = await story("Second");
    await move(first, "in_progress");
    await move(second, "in_progress");

    await expect(
      asMember.mutation(api.issues.update, { issueId: second, assigneeId: memberId })
    ).rejects.toMatchObject({ data: { code: "rule_refused", message: expect.stringMatching(REFUSED) } });
  });

  test("creating a story In Progress for someone who holds one is refused", async () => {
    const { asMember, teamId, memberId, story, move } = await setup();
    await move(await story("First", memberId), "in_progress");

    await expect(
      asMember.mutation(api.issues.create, {
        teamId,
        title: "Second",
        status: "in_progress",
        assigneeId: memberId,
      })
    ).rejects.toMatchObject({ data: { code: "rule_refused", message: expect.stringMatching(REFUSED) } });
  });

  test.each([
    ["In Review", "in_review"],
    ["Done", "done"],
    ["unassigning", "unassign"],
  ] as const)("%s frees the slot", async (_label, release) => {
    const { t, asMember, orgId, memberId, story, move } = await setup();
    const first = await story("First", memberId);
    const second = await story("Second", memberId);
    await move(first, "in_progress");

    if (release === "unassign") {
      await asMember.mutation(api.issues.update, { issueId: first, assigneeId: null });
    } else {
      await passDoneGate({ t, asMember, orgId }, first);
      await move(first, release);
    }

    await expect(move(second, "in_progress")).resolves.toBeNull();
  });

  test("different people each get one", async () => {
    const { memberId, otherId, story, move } = await setup();
    await move(await story("Mine", memberId), "in_progress");

    await expect(move(await story("Theirs", otherId), "in_progress")).resolves.toBeNull();
  });

  test.each(["epic", "feature", "subtask"] as const)(
    "a %s in progress is never blocked and never counts",
    async (kind) => {
      const { t, orgId, teamId, memberId, story, move } = await setup();
      const holder = await story("Holder", memberId);
      await move(holder, "in_progress");
      const other = await t.run(async (ctx) => {
        return await ctx.db.insert("issues", {
          orgId,
          teamId,
          kind,
          title: `A ${kind}`,
          status: "todo",
          priority: "none",
          assigneeId: memberId,
          creatorId: memberId,
          sortOrder: 0,
        });
      });

      await expect(move(other, "in_progress")).resolves.toBeNull();
      expect((await t.run((ctx) => ctx.db.get(other)))?.status).toBe("in_progress");
      await move(holder, "todo");
      await expect(move(holder, "in_progress")).resolves.toBeNull();
    }
  );

  test("a story with no assignee can be In Progress and isn't counted", async () => {
    const { asMember, memberId, story, move } = await setup();
    const unassigned = await story("Unassigned");
    const second = await story("Second");
    await move(unassigned, "in_progress");
    await move(second, "in_progress");

    await expect(
      asMember.mutation(api.issues.update, { issueId: unassigned, assigneeId: memberId })
    ).resolves.toBeNull();
  });
});
