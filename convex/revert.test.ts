/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { MCP_TOOL_NAMES } from "../lib/mcp/tools";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import http from "./http";
import { LIST_LIMIT } from "../lib/api-contract";
import { parseIssuePath } from "./lib/httpApi";
import schema from "./schema";
import { MEMBER_CLERK_ID, MEMBER_IDENTITY, ORG_CLAIM } from "./lib/orgMember.fixture";
import { issueReaders, passDoneGate, refusalOf } from "./test-helpers.fixture";

const modules = import.meta.glob("./**/*.*s");

async function setup() {
  const t = convexTest(schema, modules);
  const { orgId, teamId, ownerId, memberId } = await t.run(async (ctx) => {
    const ownerId = await ctx.db.insert("users", { clerkId: "user_owner", name: "Owner", email: "o@example.com" });
    const memberId = await ctx.db.insert("users", { clerkId: MEMBER_CLERK_ID, name: "Member", email: "m@example.com" });
    const orgId = await ctx.db.insert("organizations", { clerkOrgId: ORG_CLAIM, name: "Test Org", slug: "test-org" });
    await ctx.db.insert("members", { orgId, userId: ownerId, role: "admin", clerkMembershipId: "mem_owner" });
    await ctx.db.insert("members", { orgId, userId: memberId, role: "member", clerkMembershipId: "mem_member" });
    const teamId = await ctx.db.insert("teams", { orgId, name: "Engineering", key: "ENG", nextIssueNumber: 1 });
    return { orgId, teamId, ownerId, memberId };
  });
  const asOwner = t.withIdentity({ subject: "user_owner", org_id: ORG_CLAIM });
  const asMember = t.withIdentity(MEMBER_IDENTITY);
  const story = (title: string, assigneeId?: Id<"users">) =>
    asMember.mutation(api.issues.create, { teamId, title, assigneeId });
  const readers = issueReaders(t);
  const lastChange = async (issueId: Id<"issues">, type: string) =>
    (await readers.feed(issueId)).filter((row) => row.type === type).at(-1)!._id;
  const revert = (activityId: Id<"activity">) => asOwner.mutation(api.issues.revertChange, { activityId });
  const revertible = async (issueId: Id<"issues">) =>
    (await asOwner.query(api.activity.listByIssue, { issueId })).filter((row) => row.revertible).map((row) => row._id);
  return { t, asOwner, asMember, orgId, teamId, ownerId, memberId, story, ...readers, lastChange, revert, revertible };
}

describe("owner revert from the activity log", () => {
  const cases = [
    { field: "status", change: { status: "in_progress" as const }, read: "status", restored: "todo" },
    { field: "priority", change: { priority: "urgent" as const }, read: "priority", restored: "none" },
    { field: "title", change: { title: "Renamed" }, read: "title", restored: "Original" },
    { field: "assignee", change: { assigneeId: null }, read: "assigneeId", restored: "member" },
  ] as const;

  for (const { field, change, read, restored } of cases) {
    test(`a ${field} revert restores the old value, bumps the version once and logs one reverted row`, async () => {
      const s = await setup();
      const storyId = await s.story("Original", s.memberId);
      await s.asMember.mutation(api.issues.update, { issueId: storyId, ...change });
      const before = await s.issue(storyId);
      const rowsBefore = (await s.feed(storyId)).length;

      await s.revert(await s.lastChange(storyId, `${field}_changed`));

      const after = await s.issue(storyId);
      const expected = restored === "member" ? s.memberId : restored;
      expect(after[read]).toBe(expected);
      expect(after.version).toBe(before.version! + 1);
      const rows = await s.feed(storyId);
      expect(rows).toHaveLength(rowsBefore + 1);
      expect(rows.at(-1)).toMatchObject({ type: "reverted", field, newValue: String(expected) });
    });
  }

  test("a non-admin member is refused", async () => {
    const s = await setup();
    const storyId = await s.story("Story");
    await s.asMember.mutation(api.issues.update, { issueId: storyId, status: "in_progress" });
    const activityId = await s.lastChange(storyId, "status_changed");

    await expect(s.asMember.mutation(api.issues.revertChange, { activityId })).rejects.toMatchObject({
      data: { code: "rule_refused", message: "Admin access required" },
    });
  });

  test("an unsupported field is refused", async () => {
    const s = await setup();
    const storyId = await s.story("Story");
    await s.asMember.mutation(api.issues.update, { issueId: storyId, estimate: 3 });

    await expect(s.revert(await s.lastChange(storyId, "estimate_changed"))).rejects.toThrow(
      /^.*Only status, assignee, priority and title changes can be reverted/
    );
  });

  test("a field that changed since is refused, naming the story", async () => {
    const s = await setup();
    const storyId = await s.story("Story");
    await s.asMember.mutation(api.issues.update, { issueId: storyId, priority: "low" });
    const earlier = await s.lastChange(storyId, "priority_changed");
    await s.asMember.mutation(api.issues.update, { issueId: storyId, priority: "high" });
    const before = await s.footprint(storyId);

    const error = await s.revert(earlier).catch(refusalOf);

    expect(error).toEqual({
      code: "rule_refused",
      message: "ENG-1 priority has changed since; revert the latest change instead",
    });
    expect((await s.issue(storyId)).priority).toBe("high");
    expect(await s.footprint(storyId)).toEqual(before);
  });

  test("a sub-task's field that changed since is refused, naming the sub-task by its key", async () => {
    const s = await setup();
    const storyId = await s.story("Story");
    const subtaskId = await s.asMember.mutation(api.issues.create, {
      teamId: s.teamId,
      kind: "subtask",
      parentIssueId: storyId,
      title: "Write API",
    });
    await s.asMember.mutation(api.issues.update, { issueId: subtaskId, priority: "low" });
    const earlier = await s.lastChange(subtaskId, "priority_changed");
    await s.asMember.mutation(api.issues.update, { issueId: subtaskId, priority: "high" });

    await expect(s.revert(earlier)).rejects.toThrow(
      /ENG-1\.2 priority has changed since; revert the latest change instead/
    );
  });

  test("a field that returned to the same value since is refused", async () => {
    const s = await setup();
    const storyId = await s.story("Story");
    await s.asMember.mutation(api.issues.update, { issueId: storyId, priority: "low" });
    const earlier = await s.lastChange(storyId, "priority_changed");
    await s.asMember.mutation(api.issues.update, { issueId: storyId, priority: "high" });
    await s.asMember.mutation(api.issues.update, { issueId: storyId, priority: "low" });
    const rowsBefore = (await s.feed(storyId)).length;

    await expect(s.revert(earlier)).rejects.toThrow(/ENG-1 priority has changed since/);
    expect((await s.issue(storyId)).priority).toBe("low");
    expect(await s.feed(storyId)).toHaveLength(rowsBefore);
  });

  test("reverting In Review to In Progress is refused by WIP when the assignee holds another", async () => {
    const s = await setup();
    const first = await s.story("First", s.memberId);
    await s.asMember.mutation(api.issues.update, { issueId: first, status: "in_progress" });
    await passDoneGate(s, first);
    await s.asMember.mutation(api.issues.update, { issueId: first, status: "in_review" });
    const toReview = await s.lastChange(first, "status_changed");
    const second = await s.story("Second", s.memberId);
    await s.asMember.mutation(api.issues.update, { issueId: second, status: "in_progress" });

    await expect(s.revert(toReview)).rejects.toThrow(/already has ENG-\d+ In Progress/);
    expect((await s.issue(first)).status).toBe("in_review");
  });

  test("reverting to Done without proof is refused by the Done gate", async () => {
    const s = await setup();
    const storyId = await s.story("Story", s.memberId);
    const testingId = await passDoneGate(s, storyId);
    await s.asMember.mutation(api.issues.update, { issueId: storyId, status: "done" });
    await s.asMember.mutation(api.issues.update, { issueId: storyId, status: "in_progress" });
    const reopened = await s.lastChange(storyId, "status_changed");
    await s.asMember.mutation(api.issues.update, { issueId: testingId, status: "todo" });

    await expect(s.revert(reopened)).rejects.toThrow(/Can.t move ENG-1 to Done: open/);
    expect((await s.issue(storyId)).status).toBe("in_progress");
  });

  test("a revert is not itself revertible", async () => {
    const s = await setup();
    const storyId = await s.story("Story");
    await s.asMember.mutation(api.issues.update, { issueId: storyId, priority: "low" });
    await s.revert(await s.lastChange(storyId, "priority_changed"));

    await expect(s.revert(await s.lastChange(storyId, "reverted"))).rejects.toThrow(
      /Only status, assignee, priority and title changes can be reverted/
    );
    expect((await s.issue(storyId)).priority).toBe("none");
  });

  test("reverting to an assignee who left the workspace is refused without naming them; the assignee stays", async () => {
    const s = await setup();
    const storyId = await s.story("Story", s.memberId);
    await s.asMember.mutation(api.issues.update, { issueId: storyId, assigneeId: s.ownerId });
    await s.t.run(async (ctx) => {
      const membership = await ctx.db
        .query("members")
        .withIndex("by_org_and_user", (q) => q.eq("orgId", s.orgId).eq("userId", s.memberId))
        .unique();
      await ctx.db.delete(membership!._id);
    });

    const error = await s.revert(await s.lastChange(storyId, "assignee_changed")).catch((thrown: unknown) => thrown);

    expect(error).toHaveProperty("data", { code: "not_found", message: "Assignee not found" });
    expect(String(error)).not.toContain("Member");
    expect((await s.issue(storyId)).assigneeId).toBe(s.ownerId);
  });

  test("an assignee id that can't be parsed is refused and the assignee is unchanged", async () => {
    const s = await setup();
    const storyId = await s.story("Story", s.memberId);
    const activityId = await s.t.run(async (ctx) => {
      return await ctx.db.insert("activity", {
        orgId: s.orgId,
        issueId: storyId,
        actorId: s.memberId,
        type: "assignee_changed",
        field: "assignee",
        oldValue: "not-a-user-id",
        newValue: s.memberId,
      });
    });

    await expect(s.revert(activityId)).rejects.toThrow(/Unknown value not-a-user-id/);
    expect((await s.issue(storyId)).assigneeId).toBe(s.memberId);
  });

  test("the feed's revertible flag matches what revertChange accepts", async () => {
    const s = await setup();
    const storyId = await s.story("Story");
    await s.asMember.mutation(api.issues.update, { issueId: storyId, priority: "low" });
    const earlier = await s.lastChange(storyId, "priority_changed");
    await s.asMember.mutation(api.issues.update, { issueId: storyId, priority: "high" });
    const latest = await s.lastChange(storyId, "priority_changed");
    await s.asMember.mutation(api.issues.update, { issueId: storyId, estimate: 3 });
    await s.asMember.mutation(api.issues.update, { issueId: storyId, title: "Renamed" });
    const renamed = await s.lastChange(storyId, "title_changed");
    await s.revert(renamed);

    expect(await s.revertible(storyId)).toEqual([latest]);
    await expect(s.revert(earlier)).rejects.toThrow(/has changed since/);
  });

  test("past the feed's first 500 rows, the newest change still offers Revert and reverts", async () => {
    const s = await setup();
    const storyId = await s.story("Story");
    await s.asMember.mutation(api.issues.update, { issueId: storyId, priority: "low" });
    const old = await s.lastChange(storyId, "priority_changed");
    await s.t.run(async (ctx) => {
      for (let i = 0; i < 520; i++) {
        await ctx.db.insert("activity", { orgId: s.orgId, issueId: storyId, actorId: s.memberId, type: "commented" });
      }
    });
    await s.asMember.mutation(api.issues.update, { issueId: storyId, priority: "high" });
    const newest = await s.lastChange(storyId, "priority_changed");

    const shown = await s.asOwner.query(api.activity.listByIssue, { issueId: storyId });
    expect(shown).toHaveLength(500);
    expect(shown.at(-1)).toMatchObject({ _id: newest, revertible: true });
    expect(shown.map((row) => row._id)).not.toContain(old);
    await s.revert(newest);
    expect((await s.issue(storyId)).priority).toBe("low");
  });

  test("reverting to a blank title stored before titles were checked is refused as validation; the title stays", async () => {
    const s = await setup();
    const storyId = await s.story("Story");
    await s.t.run((ctx) => ctx.db.patch(storyId, { title: "" }));
    await s.asMember.mutation(api.issues.update, { issueId: storyId, title: "Named" });

    const error = await s.revert(await s.lastChange(storyId, "title_changed")).catch((thrown: unknown) => thrown);

    expect(error).toHaveProperty("data.code", "validation");
    expect((await s.issue(storyId)).title).toBe("Named");
  });

  test("a change behind LIST_LIMIT newer rows is not in the feed, so it is refused and the field stays", async () => {
    const s = await setup();
    const storyId = await s.story("Story");
    await s.asMember.mutation(api.issues.update, { issueId: storyId, priority: "low" });
    const change = await s.lastChange(storyId, "priority_changed");
    await s.t.run(async (ctx) => {
      for (let i = 0; i < LIST_LIMIT; i++) {
        await ctx.db.insert("activity", { orgId: s.orgId, issueId: storyId, actorId: s.memberId, type: "commented" });
      }
    });

    const shown = await s.asOwner.query(api.activity.listByIssue, { issueId: storyId });
    expect(shown.map((row) => row._id)).not.toContain(change);
    const error = await s.revert(change).catch((thrown: unknown) => thrown);

    expect(error).toHaveProperty("data.code", "rule_refused");
    expect((await s.issue(storyId)).priority).toBe("low");
  });

  test("an agent can't reach it: no REST route and no MCP tool", () => {
    const paths = http.getRoutes().map(([path]) => path);
    expect(paths).toContain("/api/v1/issues");
    expect(paths.filter((path) => /revert/i.test(path))).toEqual([]);
    expect(() => parseIssuePath("/api/v1/issues/ENG-1/revert")).toThrow(/No route for/);
    expect(MCP_TOOL_NAMES.filter((name) => /revert/i.test(name))).toEqual([]);
  });

  // Catches a revert that lets a row with no field, such as the "created" row, through to `updateIssue`.
  test("revert of a row with no field refuses", async () => {
    const s = await setup();
    const storyId = await s.story("Story");
    const created = await s.lastChange(storyId, "created");

    const error = await s.revert(created).catch(refusalOf);

    expect(error).toEqual({
      code: "rule_refused",
      message: "Only status, assignee, priority and title changes can be reverted",
    });
  });

  // Catches a revert that can't turn a recorded "no assignee" back into a clear.
  test("revert of an assignee change back to unassigned", async () => {
    const s = await setup();
    const storyId = await s.story("Story");
    await s.asMember.mutation(api.issues.update, { issueId: storyId, assigneeId: s.memberId });
    const before = await s.issue(storyId);
    const rowsBefore = (await s.feed(storyId)).length;

    await s.revert(await s.lastChange(storyId, "assignee_changed"));

    const after = await s.issue(storyId);
    expect(after).not.toHaveProperty("assigneeId");
    expect(after.version).toBe(before.version! + 1);
    const rows = await s.feed(storyId);
    expect(rows).toHaveLength(rowsBefore + 1);
    expect(rows.at(-1)).toMatchObject({ type: "reverted", field: "assignee", oldValue: s.memberId });
    expect(rows.at(-1)!.newValue).toBeUndefined();
  });

  // Catches a revert that writes a recorded status or priority the schema doesn't know.
  test("revert of a literal field with an unknown value refuses", async () => {
    const s = await setup();
    const storyId = await s.story("Story");
    const activityId = await s.t.run(async (ctx) =>
      ctx.db.insert("activity", {
        orgId: s.orgId,
        issueId: storyId,
        actorId: s.memberId,
        type: "priority_changed",
        field: "priority",
        oldValue: "not-a-priority",
        newValue: "none",
      })
    );
    const before = await s.footprint(storyId);

    const error = await s.revert(activityId).catch(refusalOf);

    expect(error).toEqual({ code: "rule_refused", message: "Unknown value not-a-priority" });
    expect((await s.issue(storyId)).priority).toBe("none");
    expect(await s.footprint(storyId)).toEqual(before);
  });

  // Catches a revert that checks only "newest for its field" and overwrites a value changed without a logged row.
  test("revert of the newest row after the value changed underneath refuses", async () => {
    const s = await setup();
    const storyId = await s.story("Story");
    await s.asMember.mutation(api.issues.update, { issueId: storyId, priority: "low" });
    const newest = await s.lastChange(storyId, "priority_changed");
    await s.t.run((ctx) => ctx.db.patch(storyId, { priority: "high" }));
    const before = await s.footprint(storyId);

    const error = await s.revert(newest).catch(refusalOf);

    expect(error).toEqual({
      code: "rule_refused",
      message: "ENG-1 priority has changed since; revert the latest change instead",
    });
    expect((await s.issue(storyId)).priority).toBe("high");
    expect(await s.footprint(storyId)).toEqual(before);
  });
});
