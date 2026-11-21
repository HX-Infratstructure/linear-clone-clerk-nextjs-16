/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { insertOrgMember, MEMBER_IDENTITY } from "./lib/orgMember.fixture";
import schema from "./schema";
import { testingSubtasksOf } from "./test-helpers.fixture";

const modules = import.meta.glob("./**/*.*s");

type Row = { type: string; field?: string; oldValue?: string; newValue?: string; actorId: string };

async function setup() {
  const t = convexTest(schema, modules);
  const { orgId, ...ids } = await t.run(async (ctx) => {
    const { memberId, orgId } = await insertOrgMember(ctx);
    const teamId = await ctx.db.insert("teams", { orgId, name: "Citadel", key: "HXT", nextIssueNumber: 1 });
    const projectA = await ctx.db.insert("projects", { orgId, name: "A", status: "planned" });
    const projectB = await ctx.db.insert("projects", { orgId, name: "B", status: "planned" });
    const cycleId = await ctx.db.insert("cycles", {
      orgId,
      teamId,
      number: 1,
      startDate: 0,
      endDate: 1,
    });
    const labelId = await ctx.db.insert("labels", { orgId, name: "backend", color: "#000000" });
    return { orgId, memberId, teamId, projectA, projectB, cycleId, labelId };
  });
  const asMember = t.withIdentity(MEMBER_IDENTITY);

  const create = (
    kind: "epic" | "feature" | "story" | "subtask",
    extra: { parentIssueId?: Id<"issues">; projectId?: Id<"projects"> } = {}
  ) => asMember.mutation(api.issues.create, { teamId: ids.teamId, title: `A ${kind}`, kind, ...extra });

  const rows = (issueId: Id<"issues">): Promise<Row[]> =>
    t.run(async (ctx) => {
      const entries = await ctx.db
        .query("activity")
        .withIndex("by_issue", (q) => q.eq("issueId", issueId))
        .collect();
      return entries.map(({ type, field, oldValue, newValue, actorId }) => ({
        type,
        field,
        oldValue,
        newValue,
        actorId,
      }));
    });

  const testingSubtask = async (storyId: Id<"issues">) => (await testingSubtasksOf({ t, orgId }, storyId))[0];

  return { t, asMember, ids, create, rows, testingSubtask };
}

const row = (actorId: string, type: string, change: Omit<Row, "actorId" | "type"> = {}): Row => ({
  type,
  field: change.field,
  oldValue: change.oldValue,
  newValue: change.newValue,
  actorId,
});

describe("R6: one activity row per change", () => {
  test("creating a story logs created on the story and on its testing sub-task", async () => {
    const { ids, create, rows, testingSubtask } = await setup();
    const storyId = await create("story");
    const subtask = await testingSubtask(storyId);
    expect(await rows(storyId)).toEqual([row(ids.memberId, "created")]);
    expect(await rows(subtask._id)).toEqual([row(ids.memberId, "created")]);
  });

  type UpdateCase = {
    name: string;
    args: (ids: Awaited<ReturnType<typeof setup>>["ids"]) => Record<string, unknown>;
    expected: (ids: Awaited<ReturnType<typeof setup>>["ids"]) => Omit<Row, "actorId">;
  };
  const updateCases: UpdateCase[] = [
    { name: "status", args: () => ({ status: "in_progress" }), expected: () => ({ type: "status_changed", field: "status", oldValue: "todo", newValue: "in_progress" }) },
    { name: "priority", args: () => ({ priority: "high" }), expected: () => ({ type: "priority_changed", field: "priority", oldValue: "none", newValue: "high" }) },
    { name: "title", args: () => ({ title: "Renamed" }), expected: () => ({ type: "title_changed", field: "title", oldValue: "A story", newValue: "Renamed" }) },
    { name: "description", args: () => ({ description: "Body" }), expected: () => ({ type: "description_changed", field: "description", oldValue: undefined, newValue: "Body" }) },
    { name: "estimate", args: () => ({ estimate: 3 }), expected: () => ({ type: "estimate_changed", field: "estimate", oldValue: undefined, newValue: "3" }) },
    { name: "due date", args: () => ({ dueDate: 1700000000000 }), expected: () => ({ type: "dueDate_changed", field: "dueDate", oldValue: undefined, newValue: "1700000000000" }) },
    { name: "assignee", args: (ids) => ({ assigneeId: ids.memberId }), expected: (ids) => ({ type: "assignee_changed", field: "assignee", oldValue: undefined, newValue: ids.memberId }) },
    { name: "project", args: (ids) => ({ projectId: ids.projectA }), expected: (ids) => ({ type: "project_changed", field: "project", oldValue: undefined, newValue: ids.projectA }) },
    { name: "cycle", args: (ids) => ({ cycleId: ids.cycleId }), expected: (ids) => ({ type: "cycle_changed", field: "cycle", oldValue: undefined, newValue: ids.cycleId }) },
  ];

  test.each(updateCases)("update $name logs exactly one row", async ({ args, expected }) => {
    const { asMember, ids, create, rows } = await setup();
    const storyId = await create("story");
    await asMember.mutation(api.issues.update, { issueId: storyId, ...args(ids) });
    const logged = (await rows(storyId)).slice(1);
    expect(logged).toEqual([{ ...expected(ids), actorId: ids.memberId }]);
  });

  test("an update that changes nothing logs nothing", async () => {
    const { asMember, create, rows } = await setup();
    const storyId = await create("story");
    await asMember.mutation(api.issues.update, { issueId: storyId, status: "todo", assigneeId: null });
    expect((await rows(storyId)).slice(1)).toEqual([]);
  });

  test("a project cascade logs one project_changed row per patched descendant", async () => {
    const { asMember, ids, create, rows, testingSubtask } = await setup();
    const epicId = await create("epic", { projectId: ids.projectA });
    const featureId = await create("feature", { parentIssueId: epicId });
    const storyId = await create("story", { parentIssueId: featureId });
    const subtask = await testingSubtask(storyId);
    await asMember.mutation(api.issues.update, { issueId: epicId, projectId: ids.projectB });
    const change = row(ids.memberId, "project_changed", {
      field: "project",
      oldValue: ids.projectA,
      newValue: ids.projectB,
    });
    for (const issueId of [epicId, featureId, storyId, subtask._id]) {
      expect((await rows(issueId)).slice(1)).toEqual([change]);
    }
  });

  test("setParent logs parent_changed and the inherited project on the moved issue and its sub-tasks", async () => {
    const { asMember, ids, create, rows, testingSubtask } = await setup();
    const epicId = await create("epic", { projectId: ids.projectA });
    const featureId = await create("feature", { parentIssueId: epicId });
    const storyId = await create("story");
    const subtask = await testingSubtask(storyId);
    await asMember.mutation(api.issueRelations.setParent, { issueId: storyId, parentIssueId: featureId });
    const project = { field: "project", oldValue: undefined, newValue: ids.projectA };
    expect((await rows(storyId)).slice(1)).toEqual([
      row(ids.memberId, "project_changed", project),
      row(ids.memberId, "parent_changed", { field: "parent", oldValue: undefined, newValue: "A feature" }),
    ]);
    expect((await rows(subtask._id)).slice(1)).toEqual([row(ids.memberId, "project_changed", project)]);
  });

  test("setParent logs the sub-task renumber", async () => {
    const { asMember, ids, create, rows } = await setup();
    const storyA = await create("story");
    const storyB = await create("story");
    await create("subtask", { parentIssueId: storyB });
    const movedId = await create("subtask", { parentIssueId: storyA });
    await asMember.mutation(api.issueRelations.setParent, { issueId: movedId, parentIssueId: storyB });
    expect((await rows(movedId)).slice(1)).toEqual([
      row(ids.memberId, "subNumber_changed", { field: "subNumber", oldValue: "2", newValue: "3" }),
      row(ids.memberId, "parent_changed", { field: "parent", oldValue: "HXT-1", newValue: "HXT-2" }),
    ]);
  });

  test("setProof logs proof_set with the URL and proof_cleared with the old URL", async () => {
    const { asMember, ids, create, rows, testingSubtask } = await setup();
    const subtask = await testingSubtask(await create("story"));
    const url = "https://example.com/proof";
    await asMember.mutation(api.issues.setProof, { issueId: subtask._id, proofUrl: url });
    await asMember.mutation(api.issues.setProof, { issueId: subtask._id, proofUrl: "" });
    expect((await rows(subtask._id)).slice(1)).toEqual([
      row(ids.memberId, "proof_set", { field: "proof", oldValue: undefined, newValue: url }),
      row(ids.memberId, "proof_cleared", { field: "proof", oldValue: url, newValue: undefined }),
    ]);
  });

  test("toggling a label on and off logs label_added then label_removed with its name", async () => {
    const { asMember, ids, create, rows } = await setup();
    const storyId = await create("story");
    await asMember.mutation(api.labels.toggleOnIssue, { issueId: storyId, labelId: ids.labelId });
    await asMember.mutation(api.labels.toggleOnIssue, { issueId: storyId, labelId: ids.labelId });
    expect((await rows(storyId)).slice(1)).toEqual([
      row(ids.memberId, "label_added", { field: "label", oldValue: undefined, newValue: "backend" }),
      row(ids.memberId, "label_removed", { field: "label", oldValue: "backend", newValue: undefined }),
    ]);
  });

  test("listByIssue shows names for assignee, project and cycle, and the stored value for a missing reference", async () => {
    const { t, asMember, ids, create } = await setup();
    const storyId = await create("story");
    for (const change of [
      { assigneeId: ids.memberId },
      { projectId: ids.projectA },
      { cycleId: ids.cycleId },
      { projectId: ids.projectB },
    ]) {
      await asMember.mutation(api.issues.update, { issueId: storyId, ...change });
    }
    await t.run((ctx) => ctx.db.delete(ids.projectB));
    const shown = await asMember.query(api.activity.listByIssue, { issueId: storyId });
    expect(shown.slice(1).map(({ field, oldValue, newValue }) => ({ field, oldValue, newValue }))).toEqual([
      { field: "assignee", oldValue: undefined, newValue: "Member" },
      { field: "project", oldValue: undefined, newValue: "A" },
      { field: "cycle", oldValue: undefined, newValue: "Cycle 1" },
      { field: "project", oldValue: "A", newValue: ids.projectB },
    ]);
  });
});

describe("listByIssue name resolution", () => {
  test("shows another organization's cycle and project by raw id, never by name", async () => {
    const { t, asMember, ids, create } = await setup();
    const storyId = await create("story");
    const foreign = await t.run(async (ctx) => {
      const orgId = await ctx.db.insert("organizations", { clerkOrgId: "org_other", name: "Other", slug: "other" });
      const teamId = await ctx.db.insert("teams", { orgId, name: "Other", key: "OTH", nextIssueNumber: 1 });
      const cycleId = await ctx.db.insert("cycles", { orgId, teamId, name: "Secret cycle", number: 7, startDate: 0, endDate: 1 });
      const projectId = await ctx.db.insert("projects", { orgId, name: "Secret project", status: "planned" });
      const story = (await ctx.db.get(storyId))!;
      const entries = [
        { field: "cycle", newValue: cycleId },
        { field: "cycle", newValue: ids.cycleId },
        { field: "project", newValue: projectId },
        { field: "project", newValue: ids.projectA },
      ];
      for (const entry of entries) {
        await ctx.db.insert("activity", {
          orgId: story.orgId,
          issueId: storyId,
          actorId: ids.memberId,
          type: `${entry.field}_changed`,
          ...entry,
        });
      }
      return { cycleId, projectId };
    });

    const feed = await asMember.query(api.activity.listByIssue, { issueId: storyId });

    expect(feed.slice(1).map(({ field, newValue }) => ({ field, newValue }))).toEqual([
      { field: "cycle", newValue: foreign.cycleId },
      { field: "cycle", newValue: "Cycle 1" },
      { field: "project", newValue: foreign.projectId },
      { field: "project", newValue: "A" },
    ]);
  });
});
