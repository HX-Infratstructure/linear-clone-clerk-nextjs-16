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

describe("projects.create on a free organization", () => {
  test("creates a 3rd project", async () => {
    const t = convexTest(schema, modules);
    const orgId = await t.run(async (ctx) => (await insertOrgMember(ctx)).orgId);
    const asMember = t.withIdentity(MEMBER_IDENTITY);
    await asMember.mutation(api.projects.create, { name: "One" });
    await asMember.mutation(api.projects.create, { name: "Two" });

    await asMember.mutation(api.projects.create, { name: "Three" });

    const projects = await t.run((ctx) =>
      ctx.db
        .query("projects")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .collect()
    );
    expect(projects.map((project) => project.name)).toEqual([
      "One",
      "Two",
      "Three",
    ]);
  });
});

describe("projects.remove", () => {
  test("deletes a project that another organization's epic points at", async () => {
    const t = convexTest(schema, modules);
    const projectId = await t.run(async (ctx) => {
      const { orgId, memberId: userId } = await insertOrgMember(ctx);
      const projectId = await ctx.db.insert("projects", {
        orgId,
        name: "Phase 2",
        status: "planned",
      });
      const otherOrgId = await ctx.db.insert("organizations", {
        clerkOrgId: "org_other",
        name: "Other Org",
        slug: "other-org",
      });
      const otherTeamId = await ctx.db.insert("teams", {
        orgId: otherOrgId,
        name: "Other",
        key: "OTH",
        nextIssueNumber: 1,
      });
      await ctx.db.insert("issues", {
        orgId: otherOrgId,
        teamId: otherTeamId,
        kind: "epic",
        title: "Foreign epic",
        status: "todo",
        priority: "none",
        creatorId: userId,
        projectId,
        sortOrder: 0,
      });
      return projectId;
    });
    const asMember = t.withIdentity(MEMBER_IDENTITY);

    await asMember.mutation(api.projects.remove, { projectId });

    expect(await t.run((ctx) => ctx.db.get(projectId))).toBeNull();
  });
});

/** A member, a project, and a user who is not in the workspace. */
async function setupProject(transactionLimits?: { documentsRead: number }) {
  const t = convexTest({ schema, modules, transactionLimits });
  const ids = await t.run(async (ctx) => {
    const { orgId, memberId: userId } = await insertOrgMember(ctx);
    const outsiderId = await ctx.db.insert("users", { clerkId: "user_outsider", name: "Outsider", email: "out@example.com" });
    const teamId = await ctx.db.insert("teams", { orgId, name: "Engineering", key: "ENG", nextIssueNumber: 1 });
    const projectId = await ctx.db.insert("projects", { orgId, name: "Phase 2", status: "planned" });
    return { orgId, userId, outsiderId, teamId, projectId };
  });
  return { t, member: t.withIdentity(MEMBER_IDENTITY), ...ids };
}

type ProjectSetup = Awaited<ReturnType<typeof setupProject>>;

describe("project input is a typed refusal", () => {
  test.each([
    ["create", (s: ProjectSetup) => s.member.mutation(api.projects.create, { name: "  " })],
    ["update", (s: ProjectSetup) => s.member.mutation(api.projects.update, { projectId: s.projectId, name: "  " })],
  ])("%s with an empty name is validation", async (_name, write) => {
    await expect(write(await setupProject())).rejects.toMatchObject({
      data: { code: "validation", message: "Project name is required" },
    });
  });

  test.each([
    ["create", (s: ProjectSetup) => s.member.mutation(api.projects.create, { name: "Led", leadId: s.outsiderId })],
    ["update", (s: ProjectSetup) => s.member.mutation(api.projects.update, { projectId: s.projectId, leadId: s.outsiderId })],
  ])("%s with a lead outside the workspace is not_found", async (_name, write) => {
    await expect(write(await setupProject())).rejects.toMatchObject({
      data: { code: "not_found", message: "Project lead must be a member of this organization" },
    });
  });
});

describe("a project with more than LIST_LIMIT issues", () => {
  test("lists LIST_LIMIT of them, and the index row's progress counts every one", async () => {
    const s = await setupProject();
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
          projectId: s.projectId,
          sortOrder: number,
        });
      }
    });

    const issues = await s.member.query(api.projects.listIssues, { projectId: s.projectId });
    const [project] = await s.member.query(api.projects.list, {});
    const row = await s.member.query(api.projects.progress, { projectId: project._id });

    const expected = { total: LIST_LIMIT + 1, done: LIST_LIMIT, todo: 1 };
    expect(issues).toHaveLength(LIST_LIMIT);
    expect(row).toMatchObject(expected);
  });
});

describe("projects.list", () => {
  test("lists every project within 10 document reads, so it reads no issues", async () => {
    const s = await setupProject({ documentsRead: 10 });
    await s.t.run(async (ctx) => {
      const projectIds = [
        s.projectId,
        await ctx.db.insert("projects", { orgId: s.orgId, name: "Phase 3", status: "planned" }),
        await ctx.db.insert("projects", { orgId: s.orgId, name: "Phase 4", status: "planned" }),
      ];
      let number = 0;
      for (const projectId of projectIds) {
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
            projectId,
            sortOrder: number,
          });
        }
      }
    });

    const projects = await s.member.query(api.projects.list, {});

    expect(projects.map((project) => project.name).sort()).toEqual(["Phase 2", "Phase 3", "Phase 4"]);
  });
});

describe("projects.progress for the index rows", () => {
  test("each row's progress reads within 30 documents", async () => {
    const s = await setupProject({ documentsRead: 30 });
    await s.t.run(async (ctx) => {
      const projectIds = [
        s.projectId,
        await ctx.db.insert("projects", { orgId: s.orgId, name: "Phase 3", status: "planned" }),
        await ctx.db.insert("projects", { orgId: s.orgId, name: "Phase 4", status: "planned" }),
      ];
      let number = 0;
      for (const projectId of projectIds) {
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
            projectId,
            sortOrder: number,
          });
        }
      }
    });

    const projects = await s.member.query(api.projects.list, {});

    for (const project of projects) {
      expect(await s.member.query(api.projects.progress, { projectId: project._id })).toMatchObject({
        total: 20,
        todo: 20,
      });
    }
  });
});

describe("projects.remove past the cascade budget", () => {
  const TOO_MANY_ISSUES = "This project has more than 5 issues. Move some to another project before deleting it.";
  const real = { ...CASCADE_BUDGET };
  beforeEach(() => {
    Object.assign(CASCADE_BUDGET, { rows: 5, queries: 4 });
  });
  afterEach(() => {
    Object.assign(CASCADE_BUDGET, real);
  });

  const withStories = async (count: number, transactionLimits?: Parameters<typeof setupProject>[0]) => {
    const s = await setupProject(transactionLimits);
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
          projectId: s.projectId,
          sortOrder: number,
        });
      }
    });
    return s;
  };
  const projectsOf = async (s: ProjectSetup) =>
    (await s.t.run((ctx) => ctx.db.query("issues").collect())).map((issue) => issue.projectId);

  test("refuses a project with 6 issues past a cap of 5, and detaches none", async () => {
    const s = await withStories(6);

    await expect(s.member.mutation(api.projects.remove, { projectId: s.projectId })).rejects.toThrow(TOO_MANY_ISSUES);

    expect(await projectsOf(s)).toEqual(Array(6).fill(s.projectId));
  });

  test("deletes a project with 5 issues at the cap, and detaches them all", async () => {
    const s = await withStories(5);

    await s.member.mutation(api.projects.remove, { projectId: s.projectId });

    expect(await projectsOf(s)).toEqual(Array(5).fill(undefined));
    expect(await s.t.run((ctx) => ctx.db.get(s.projectId))).toBeNull();
  });

  test("refuses a project with 30 issues within 20 document reads, so it never reads all 30", async () => {
    const s = await withStories(30, { documentsRead: 20 });

    await expect(s.member.mutation(api.projects.remove, { projectId: s.projectId })).rejects.toThrow(TOO_MANY_ISSUES);
  });
});
