/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { formatIssueKey } from "../lib/issue-key";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { insertOrgMember, MEMBER_IDENTITY } from "./lib/orgMember.fixture";
import { CASCADE_BUDGET } from "./lib/orgRows";
import schema from "./schema";

vi.mock("./lib/orgRows", async (importOriginal) => {
  const original = await importOriginal<typeof import("./lib/orgRows")>();
  return { ...original, CASCADE_BUDGET: { ...original.CASCADE_BUDGET } };
});

const modules = import.meta.glob("./**/*.*s");

const CASCADE_REFUSAL =
  "This change would move more than 5 issues to another project. Move a smaller part of the tree.";
const WALK_REFUSAL = "This tree is too large to move in one step. Move a smaller part of it.";

const TEAM_KEY = "HXT";

type Kind = "epic" | "feature" | "story" | "subtask";

async function setup(transactionLimits: { databaseQueries?: number; documentsRead?: number } | boolean = false) {
  const t = convexTest({ schema, modules, transactionLimits });
  const { teamId, projectId } = await t.run(async (ctx) => {
    const { orgId } = await insertOrgMember(ctx);
    const teamId = await ctx.db.insert("teams", {
      orgId,
      name: "Citadel",
      key: TEAM_KEY,
      nextIssueNumber: 12,
    });
    const projectId = await ctx.db.insert("projects", {
      orgId,
      name: "Phase 2",
      status: "planned",
    });
    return { teamId, projectId };
  });
  const asMember = t.withIdentity(MEMBER_IDENTITY);

  const create = (
    kind: Kind,
    placement: {
      parentIssueId?: Id<"issues">;
      projectId?: Id<"projects">;
      teamId?: Id<"teams">;
    } = {}
  ) =>
    asMember.mutation(api.issues.create, {
      teamId,
      title: `A ${kind}`,
      kind,
      ...placement,
    });

  const tree = async () => {
    const epic = await create("epic", { projectId });
    const feature = await create("feature", { parentIssueId: epic });
    const story = await create("story", { parentIssueId: feature });
    const subtask = await create("subtask", { parentIssueId: story });
    return { epic, feature, story, subtask };
  };

  const insertOtherProject = () =>
    t.run(async (ctx) => {
      const project = await ctx.db.get(projectId);
      return ctx.db.insert("projects", {
        orgId: project!.orgId,
        name: "Other",
        status: "planned",
      });
    });

  const insertForeignProject = () =>
    t.run(async (ctx) => {
      const orgId = await ctx.db.insert("organizations", {
        clerkOrgId: "org_other",
        name: "Other Org",
        slug: "other-org",
      });
      return ctx.db.insert("projects", { orgId, name: "Foreign", status: "planned" });
    });

  const insertOtherTeam = () =>
    t.run(async (ctx) => {
      const team = await ctx.db.get(teamId);
      return ctx.db.insert("teams", {
        orgId: team!.orgId,
        name: "Other",
        key: "OTH",
        nextIssueNumber: 1,
      });
    });

  return {
    t,
    asMember,
    teamId,
    projectId,
    create,
    tree,
    insertOtherProject,
    insertForeignProject,
    insertOtherTeam,
  };
}

describe("issue levels", () => {
  test("accepts each valid parent pair", async () => {
    const { asMember, create, tree } = await setup();
    const ids = await tree();
    const loneStory = await create("story");

    for (const issueId of [...Object.values(ids), loneStory]) {
      expect(await asMember.query(api.issues.get, { issueId })).not.toBeNull();
    }
  });

  test.each<[Kind, keyof Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["tree"]>> | null, string]>([
    ["epic", "feature", "An epic cannot have a parent (got a feature)"],
    ["feature", null, "A feature needs an epic as its parent"],
    ["feature", "story", "A feature's parent must be an epic, not a story"],
    ["story", "epic", "A story's parent must be a feature, not an epic"],
    ["story", "subtask", "A story's parent must be a feature, not a subtask"],
    ["subtask", null, "A subtask needs a story as its parent"],
    ["subtask", "epic", "A subtask's parent must be a story, not an epic"],
    ["subtask", "feature", "A subtask's parent must be a story, not a feature"],
  ])("refuses a %s under %s", async (kind, parentKind, message) => {
    const { create, projectId, tree } = await setup();
    const ids = await tree();
    const parentIssueId = parentKind ? ids[parentKind] : undefined;

    await expect(create(kind, { parentIssueId, projectId })).rejects.toThrow(message);
  });

  test("refuses an epic without a project", async () => {
    const { create } = await setup();

    await expect(create("epic")).rejects.toThrow("An epic needs a project");
  });

  test("numbers a story's subtasks after its testing subtask, and the key helper shows KEY-n.2 and KEY-n.3", async () => {
    const { asMember, create } = await setup();
    const storyId = await create("story");
    const firstId = await create("subtask", { parentIssueId: storyId });
    const secondId = await create("subtask", { parentIssueId: storyId });

    const story = await asMember.query(api.issues.get, { issueId: storyId });
    const first = await asMember.query(api.issues.get, { issueId: firstId });
    const second = await asMember.query(api.issues.get, { issueId: secondId });

    expect(story?.number).toBe(12);
    expect([first?.subNumber, second?.subNumber]).toEqual([2, 3]);
    expect([first?.number, second?.number]).toEqual([undefined, undefined]);
    expect(formatIssueKey(TEAM_KEY, first!, story!.number)).toBe("HXT-12.2");
    expect(formatIssueKey(TEAM_KEY, second!, story!.number)).toBe("HXT-12.3");
  });

  test("does not spend a story number on epics, features or subtasks", async () => {
    const { asMember, create, tree } = await setup();
    await tree();
    const nextStory = await create("story");

    expect((await asMember.query(api.issues.get, { issueId: nextStory }))?.number).toBe(13);
  });

  test("refuses a reparent to a wrong parent", async () => {
    const { asMember, tree } = await setup();
    const { epic, subtask } = await tree();

    await expect(
      asMember.mutation(api.issueRelations.setParent, {
        issueId: subtask,
        parentIssueId: epic,
      })
    ).rejects.toThrow("A subtask's parent must be a story, not an epic");
  });

  test("refuses removing an epic's project", async () => {
    const { asMember, tree } = await setup();
    const { epic } = await tree();

    await expect(
      asMember.mutation(api.issues.update, { issueId: epic, projectId: null })
    ).rejects.toThrow("An epic needs a project");
  });

  test("renumbers a subtask moved to another story", async () => {
    const { asMember, create } = await setup();
    const storyA = await create("story");
    const storyB = await create("story");
    await create("subtask", { parentIssueId: storyB });
    const moving = await create("subtask", { parentIssueId: storyA });

    await asMember.mutation(api.issueRelations.setParent, {
      issueId: moving,
      parentIssueId: storyB,
    });

    expect((await asMember.query(api.issues.get, { issueId: moving }))?.subNumber).toBe(3);
  });

  test("never reuses the key of a subtask moved away from its story", async () => {
    const { asMember, create } = await setup();
    const storyA = await create("story");
    const storyB = await create("story");
    const moving = await create("subtask", { parentIssueId: storyA });

    await asMember.mutation(api.issueRelations.setParent, { issueId: moving, parentIssueId: storyB });
    const next = await create("subtask", { parentIssueId: storyA });

    expect((await asMember.query(api.issues.get, { issueId: next }))?.subNumber).toBe(3);
  });

  test.each([
    ["without a project", false],
    ["with a project", true],
  ])("allows a parentless story %s", async (_label, withProject) => {
    const { asMember, create, projectId } = await setup();
    const issueId = await create("story", withProject ? { projectId } : {});

    const story = await asMember.query(api.issues.get, { issueId });
    expect(story?.projectId).toBe(withProject ? projectId : undefined);
  });

  test("a feature, a story under it and its subtask inherit the epic's project", async () => {
    const { asMember, projectId, tree } = await setup();
    const { feature, story, subtask } = await tree();

    for (const issueId of [feature, story, subtask]) {
      expect((await asMember.query(api.issues.get, { issueId }))?.projectId).toBe(projectId);
    }
  });

  test("refuses a story under a feature with a different project", async () => {
    const { create, insertOtherProject, tree } = await setup();
    const { feature } = await tree();
    const otherProject = await insertOtherProject();

    await expect(
      create("story", { parentIssueId: feature, projectId: otherProject })
    ).rejects.toThrow("A story's project must match its feature's project");
  });

  test("a reparent moves a story and its subtask into the new feature's project in one step", async () => {
    const { asMember, create, insertOtherProject, projectId, tree } = await setup();
    const { feature } = await tree();
    const looseStory = await create("story", { projectId: await insertOtherProject() });
    const looseSubtask = await create("subtask", { parentIssueId: looseStory });

    await asMember.mutation(api.issueRelations.setParent, {
      issueId: looseStory,
      parentIssueId: feature,
    });

    for (const issueId of [looseStory, looseSubtask]) {
      expect((await asMember.query(api.issues.get, { issueId }))?.projectId).toBe(projectId);
    }
  });

  test.each<[Kind, "epic" | "feature" | "story", string]>([
    ["feature", "epic", "A feature's team must match its epic's team"],
    ["story", "feature", "A story's team must match its feature's team"],
    ["subtask", "story", "A subtask's team must match its story's team"],
  ])("refuses a %s in another team than its %s", async (kind, parentKind, message) => {
    const { create, insertOtherTeam, tree } = await setup();
    const ids = await tree();
    const otherTeam = await insertOtherTeam();

    await expect(
      create(kind, { parentIssueId: ids[parentKind], teamId: otherTeam })
    ).rejects.toThrow(message);
  });

  test("refuses a reparent under a parent in another team", async () => {
    const { asMember, create, insertOtherTeam } = await setup();
    const story = await create("story");
    const otherTeam = await insertOtherTeam();
    const otherStory = await create("story", { teamId: otherTeam });
    const subtask = await create("subtask", { parentIssueId: story });

    await expect(
      asMember.mutation(api.issueRelations.setParent, {
        issueId: subtask,
        parentIssueId: otherStory,
      })
    ).rejects.toThrow("A subtask's team must match its story's team");
  });

  test("an epic's project change reaches its feature, story and subtask", async () => {
    const { asMember, insertOtherProject, tree } = await setup();
    const { epic, feature, story, subtask } = await tree();
    const newProject = await insertOtherProject();

    await asMember.mutation(api.issues.update, { issueId: epic, projectId: newProject });

    for (const issueId of [epic, feature, story, subtask]) {
      expect((await asMember.query(api.issues.get, { issueId }))?.projectId).toBe(newProject);
    }
  });

  test("moves an epic's project across 402 descendants with 2 KB descriptions inside Convex's transaction limits", async () => {
    // Every Convex default limit is enforced, and index ranges are capped at 300, so a cascade that queries subtasks
    // for children or re-reads each descendant fails. Measured with ctx.meta.getTransactionMetrics() on this fixture
    // (an epic and 402 descendants, 2 KB descriptions): 209 index ranges, 812 documents and 1,949,097 bytes read
    // (convex-test counts each issue in its child query and again in its patch), 806 documents and 1,104,700 bytes
    // written. Convex's own limits are `TRANSACTION_LIMITS` in `./lib/transactionLimits`.
    const { t, asMember, tree, insertOtherProject } = await setup({ databaseQueries: 300 });
    const { epic, feature, story } = await tree();
    const description = "d".repeat(2048);
    await t.run(async (ctx) => {
      const shared = (await ctx.db.get(story))!;
      const fields = {
        orgId: shared.orgId,
        teamId: shared.teamId,
        title: "Bulk",
        status: shared.status,
        priority: shared.priority,
        creatorId: shared.creatorId,
        projectId: shared.projectId,
        sortOrder: 0,
      };
      for (let i = 0; i < 199; i++) {
        const bulkStory = await ctx.db.insert("issues", { ...fields, kind: "story", parentIssueId: feature });
        await ctx.db.insert("issues", { ...fields, kind: "subtask", parentIssueId: bulkStory });
      }
      for (const issue of await ctx.db.query("issues").collect()) {
        await ctx.db.patch(issue._id, { description });
      }
    });
    const newProject = await insertOtherProject();

    const metrics = await asMember.run(async (ctx) => {
      await ctx.runMutation(api.issues.update, { issueId: epic, projectId: newProject });
      return await ctx.meta.getTransactionMetrics();
    });

    expect((await asMember.query(api.issues.get, { issueId: story }))!.projectId).toBe(newProject);
    expect(metrics.bytesRead.used).toBeGreaterThan(402 * description.length);
  });

  test("refuses deleting a project that has an epic", async () => {
    const { asMember, projectId, tree } = await setup();
    await tree();

    await expect(
      asMember.mutation(api.projects.remove, { projectId })
    ).rejects.toThrow("This project still has 1 epic");
  });

  test("deletes a project without epics and detaches its issues", async () => {
    const { asMember, create, projectId } = await setup();
    const story = await create("story", { projectId });

    await asMember.mutation(api.projects.remove, { projectId });

    const kept = await asMember.query(api.issues.get, { issueId: story });
    expect(kept).not.toBeNull();
    expect(kept!.projectId).toBeUndefined();
    expect(await asMember.query(api.projects.get, { projectId })).toBeNull();
  });

  test("refuses an epic whose project belongs to another organization", async () => {
    const { create, insertForeignProject } = await setup();
    const foreignProject = await insertForeignProject();

    await expect(create("epic", { projectId: foreignProject })).rejects.toThrow("Project not found");
  });

  test("refuses an epic whose project was deleted", async () => {
    const { t, create, insertOtherProject } = await setup();
    const deleted = await insertOtherProject();
    await t.run((ctx) => ctx.db.delete(deleted));

    await expect(create("epic", { projectId: deleted })).rejects.toThrow("Project not found");
  });

  test("refuses moving an epic to another organization's project", async () => {
    const { asMember, tree, insertForeignProject } = await setup();
    const { epic } = await tree();
    const foreignProject = await insertForeignProject();

    await expect(
      asMember.mutation(api.issues.update, { issueId: epic, projectId: foreignProject })
    ).rejects.toThrow("Project not found");
  });

  test("getByNumber finds the story and ignores subtasks", async () => {
    const { t, asMember, teamId, create } = await setup();
    const storyId = await create("story");
    const subtaskId = await create("subtask", { parentIssueId: storyId });
    await t.run((ctx) => ctx.db.patch(subtaskId, { number: 99 }));

    const found = await asMember.query(api.issues.getByNumber, { teamId, number: 12 });
    const missing = await asMember.query(api.issues.getByNumber, { teamId, number: 99 });

    expect(found?._id).toBe(storyId);
    expect(missing).toBeNull();
  });

  test("a story defaults to kind story and type story", async () => {
    const { asMember, teamId } = await setup();
    const issueId = await asMember.mutation(api.issues.create, { teamId, title: "Quick capture" });

    expect(await asMember.query(api.issues.get, { issueId })).toMatchObject({
      kind: "story",
      type: "story",
    });
  });

  test("a related sub-task whose parent is in another workspace shows no foreign story number", async () => {
    const { t, asMember, create } = await setup();
    const storyId = await create("story");
    const subtaskId = await create("subtask", { parentIssueId: storyId });
    const otherStory = await create("story");
    await asMember.mutation(api.issueRelations.create, { issueId: otherStory, relatedIssueId: subtaskId, type: "related" });
    await t.run(async (ctx) => {
      const otherOrg = await ctx.db.insert("organizations", { clerkOrgId: "org_other", name: "Other", slug: "other" });
      const otherTeam = await ctx.db.insert("teams", { orgId: otherOrg, name: "Other", key: "OTH", nextIssueNumber: 8 });
      const { creatorId } = (await ctx.db.get(storyId))!;
      const foreign = { orgId: otherOrg, teamId: otherTeam, creatorId, kind: "story", number: 7, sortOrder: 1 } as const;
      const foreignId = await ctx.db.insert("issues", { ...foreign, title: "Foreign", status: "todo", priority: "none" });
      await ctx.db.patch(subtaskId, { parentIssueId: foreignId });
    });
    const { title } = (await asMember.query(api.issues.get, { issueId: subtaskId }))!;
    const related = await asMember.query(api.issueRelations.listForIssue, { issueId: otherStory });
    expect(related.map(({ issue }) => issue.identifier)).toEqual([title]);
  });

  test("a parent in another workspace lends the issue no project on update", async () => {
    const { t, asMember, teamId, create, insertForeignProject } = await setup();
    const storyId = await create("story");
    const foreignProject = await insertForeignProject();
    await t.run(async (ctx) => {
      const { orgId } = (await ctx.db.get(foreignProject))!;
      const { creatorId } = (await ctx.db.get(storyId))!;
      const parentId = await ctx.db.insert("issues", {
        orgId, teamId, creatorId, kind: "feature", projectId: foreignProject,
        title: "Foreign", status: "todo", priority: "none", sortOrder: 1,
      });
      await ctx.db.patch(storyId, { parentIssueId: parentId });
    });
    await expect(
      asMember.mutation(api.issues.update, { issueId: storyId, projectId: foreignProject })
    ).rejects.toThrow("Parent issue not found");
    expect((await t.run((ctx) => ctx.db.get(storyId)))!.projectId).toBeUndefined();
  });

  describe("a row in another workspace pointing at an epic", () => {
    const withForeignChild = async () => {
      const { t, asMember, projectId, create, insertForeignProject, insertOtherProject } = await setup();
      const epicId = await create("epic", { projectId });
      const foreignProject = await insertForeignProject();
      const foreignId = await t.run(async (ctx) => {
        const { orgId } = (await ctx.db.get(foreignProject))!;
        const teamId = await ctx.db.insert("teams", { orgId, name: "Other", key: "OTH", nextIssueNumber: 1 });
        const { creatorId } = (await ctx.db.get(epicId))!;
        return ctx.db.insert("issues", {
          orgId, teamId, creatorId, kind: "feature", parentIssueId: epicId, projectId: foreignProject,
          title: "Foreign", status: "todo", priority: "none", sortOrder: 1,
        });
      });
      return { t, asMember, epicId, foreignId, foreignProject, insertOtherProject };
    };

    test("does not follow the epic's project change", async () => {
      const { t, asMember, epicId, foreignId, foreignProject, insertOtherProject } = await withForeignChild();
      const otherProject = await insertOtherProject();
      await asMember.mutation(api.issues.update, { issueId: epicId, projectId: otherProject });
      expect((await t.run((ctx) => ctx.db.get(foreignId)))!.projectId).toBe(foreignProject);
    });
  });
});

describe("cascade budget on an epic's project change", () => {
  const real = { ...CASCADE_BUDGET };
  beforeEach(() => {
    Object.assign(CASCADE_BUDGET, { rows: 5, queries: 4 });
  });
  afterEach(() => {
    Object.assign(CASCADE_BUDGET, real);
  });

  test("refuses moving 6 descendants past a row cap of 5, and moves none", async () => {
    const { t, asMember, create, projectId, tree, insertOtherProject } = await setup();
    const { epic, story } = await tree();
    await create("subtask", { parentIssueId: story });
    await create("subtask", { parentIssueId: story });
    const newProject = await insertOtherProject();

    await expect(
      asMember.mutation(api.issues.update, { issueId: epic, projectId: newProject })
    ).rejects.toThrow(CASCADE_REFUSAL);

    const issues = await t.run((ctx) => ctx.db.query("issues").collect());
    expect(issues.map((issue) => issue.projectId)).toEqual(Array(7).fill(projectId));
  });

  test("refuses a walk that needs 5 child queries past a query cap of 4", async () => {
    const { asMember, create, projectId, insertOtherProject } = await setup();
    const epic = await create("epic", { projectId });
    for (let i = 0; i < 4; i++) {
      await create("feature", { parentIssueId: epic });
    }

    await expect(
      asMember.mutation(api.issues.update, { issueId: epic, projectId: await insertOtherProject() })
    ).rejects.toThrow(WALK_REFUSAL);
  });

  test("moves 5 descendants in 4 child queries, at both caps", async () => {
    const { t, asMember, create, projectId, insertOtherProject } = await setup();
    const epic = await create("epic", { projectId });
    const feature = await create("feature", { parentIssueId: epic });
    await create("story", { parentIssueId: feature });
    await create("story", { parentIssueId: feature });
    const newProject = await insertOtherProject();

    await asMember.mutation(api.issues.update, { issueId: epic, projectId: newProject });

    const issues = await t.run((ctx) => ctx.db.query("issues").collect());
    expect(issues.map((issue) => issue.projectId)).toEqual(Array(6).fill(newProject));
  });
});

describe("cascade budget on a reparent", () => {
  const real = { ...CASCADE_BUDGET };
  beforeEach(() => {
    Object.assign(CASCADE_BUDGET, { rows: 5, queries: 4 });
  });
  afterEach(() => {
    Object.assign(CASCADE_BUDGET, real);
  });

  test("refuses moving a story with 6 sub-tasks under another project's feature, and writes nothing", async () => {
    const { t, asMember, create, projectId, insertOtherProject } = await setup();
    const story = await create("story", { projectId });
    for (let i = 0; i < 5; i++) {
      await create("subtask", { parentIssueId: story });
    }
    const feature = await create("feature", {
      parentIssueId: await create("epic", { projectId: await insertOtherProject() }),
    });
    const state = () =>
      t.run(async (ctx) => {
        const row = (await ctx.db.get(story))!;
        const activity = await ctx.db.query("activity").withIndex("by_issue", (q) => q.eq("issueId", story)).collect();
        const subtasks = await ctx.db
          .query("issues")
          .withIndex("by_org_and_parent", (q) => q.eq("orgId", row.orgId).eq("parentIssueId", story))
          .collect();
        const { parentIssueId, projectId, version } = row;
        return { parentIssueId, projectId, version, activity, subtasks: subtasks.map((s) => s.projectId) };
      });
    const before = await state();

    await expect(
      asMember.mutation(api.issueRelations.setParent, { issueId: story, parentIssueId: feature })
    ).rejects.toThrow(CASCADE_REFUSAL);

    expect(before.subtasks).toEqual(Array(6).fill(projectId));
    expect(await state()).toEqual(before);
  });
});

describe("cascade budget on a tree too large to read", () => {
  const real = { ...CASCADE_BUDGET };
  beforeEach(() => {
    Object.assign(CASCADE_BUDGET, { rows: 5, queries: 4 });
  });
  afterEach(() => {
    Object.assign(CASCADE_BUDGET, real);
  });

  test("refuses moving an epic whose feature has 5 stories of 30 sub-tasks within 20 document reads", async () => {
    const { asMember, t, teamId, projectId, insertOtherProject } = await setup({ documentsRead: 20 });
    const epic = await t.run(async (ctx) => {
      const { orgId } = (await ctx.db.get(projectId))!;
      const creatorId = (await ctx.db.query("users").first())!._id;
      const fields = { orgId, teamId, status: "todo", priority: "none", creatorId, projectId, sortOrder: 0 } as const;
      const epic = await ctx.db.insert("issues", { ...fields, kind: "epic", title: "Epic" });
      const feature = await ctx.db.insert("issues", { ...fields, kind: "feature", title: "Feature", parentIssueId: epic });
      for (let s = 0; s < 5; s++) {
        const story = await ctx.db.insert("issues", { ...fields, kind: "story", title: `Story ${s}`, parentIssueId: feature });
        for (let i = 0; i < 30; i++) {
          await ctx.db.insert("issues", { ...fields, kind: "subtask", title: `Sub-task ${i}`, parentIssueId: story });
        }
      }
      return epic;
    });

    await expect(
      asMember.mutation(api.issues.update, { issueId: epic, projectId: await insertOtherProject() })
    ).rejects.toThrow(CASCADE_REFUSAL);
  });
});

describe("setParent within one project", () => {
  test("moves a feature with 40 stories to another epic within 30 document reads", async () => {
    const { t, asMember, teamId, projectId } = await setup({ documentsRead: 30 });
    const { feature, epicB } = await t.run(async (ctx) => {
      const { orgId } = (await ctx.db.get(projectId))!;
      const creatorId = (await ctx.db.query("users").first())!._id;
      const fields = { orgId, teamId, status: "todo", priority: "none", creatorId, projectId, sortOrder: 0 } as const;
      const epicA = await ctx.db.insert("issues", { ...fields, kind: "epic", title: "Epic A" });
      const epicB = await ctx.db.insert("issues", { ...fields, kind: "epic", title: "Epic B" });
      const feature = await ctx.db.insert("issues", { ...fields, kind: "feature", title: "Feature", parentIssueId: epicA });
      for (let i = 0; i < 40; i++) {
        await ctx.db.insert("issues", { ...fields, kind: "story", title: `Story ${i}`, parentIssueId: feature });
      }
      return { feature, epicB };
    });

    await asMember.mutation(api.issueRelations.setParent, { issueId: feature, parentIssueId: epicB });

    expect((await t.run((ctx) => ctx.db.get(feature)))!.parentIssueId).toBe(epicB);
  });
});
