/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { insertOrgMember, MEMBER_IDENTITY } from "./lib/orgMember.fixture";
import schema from "./schema";
import { PROOF_URL, testingSubtasksOf } from "./test-helpers.fixture";

const modules = import.meta.glob("./**/*.*s");

type Kind = "epic" | "feature" | "story" | "subtask";
type Status = Doc<"issues">["status"];

async function setup() {
  const t = convexTest(schema, modules);
  const { orgId, teamId, projectId } = await t.run(async (ctx) => {
    const { orgId } = await insertOrgMember(ctx);
    const teamId = await ctx.db.insert("teams", {
      orgId,
      name: "Engineering",
      key: "ENG",
      nextIssueNumber: 1,
    });
    const projectId = await ctx.db.insert("projects", {
      orgId,
      name: "Phase 2",
      status: "planned",
    });
    return { orgId, teamId, projectId };
  });
  const asMember = t.withIdentity(MEMBER_IDENTITY);

  const create = (kind: Kind, title: string, parentIssueId?: Id<"issues">) =>
    asMember.mutation(api.issues.create, {
      teamId,
      title,
      kind,
      parentIssueId,
      projectId: kind === "epic" ? projectId : undefined,
    });
  const move = (issueId: Id<"issues">, status: Status) =>
    asMember.mutation(api.issues.update, { issueId, status });
  const testingOf = async (storyId: Id<"issues">) => (await testingSubtasksOf({ t, orgId }, storyId))[0]._id;
  const setProof = (issueId: Id<"issues">, proofUrl: string) =>
    asMember.mutation(api.issues.setProof, { issueId, proofUrl });

  /** A story with its testing sub-task and one more sub-task, "Write API". */
  const storyWithWork = async (parentIssueId?: Id<"issues">) => {
    const story = await create("story", "Login", parentIssueId);
    const work = await create("subtask", "Write API", story);
    return { story, work, testing: await testingOf(story) };
  };
  /** Marks a story's sub-tasks done, sets the proof, then the story itself. */
  const finishStory = async (ids: { story: Id<"issues">; work: Id<"issues">; testing: Id<"issues"> }) => {
    await move(ids.work, "done");
    await move(ids.testing, "done");
    await setProof(ids.testing, PROOF_URL);
    await move(ids.story, "done");
  };

  return { t, orgId, teamId, asMember, create, move, setProof, storyWithWork, finishStory };
}

const GATED = [
  ["In Review", "in_review"],
  ["Done", "done"],
] as const;

describe("Done gate: a story", () => {
  test("is not held by a row in another workspace that points at it", async () => {
    const { t, storyWithWork, finishStory } = await setup();
    const ids = await storyWithWork();
    await t.run(async (ctx) => {
      const { creatorId } = (await ctx.db.get(ids.story))!;
      const orgId = await ctx.db.insert("organizations", { clerkOrgId: "org_other", name: "Other", slug: "other" });
      const teamId = await ctx.db.insert("teams", { orgId, name: "Other", key: "OTH", nextIssueNumber: 1 });
      await ctx.db.insert("issues", {
        orgId, teamId, creatorId, kind: "subtask", subNumber: 9, parentIssueId: ids.story,
        title: "Foreign", status: "todo", priority: "none", sortOrder: 1,
      });
    });
    await finishStory(ids);
    expect((await t.run((ctx) => ctx.db.get(ids.story)))!.status).toBe("done");
  });

  test.each(GATED)("with an open sub-task can't go to %s and the refusal names it", async (label, status) => {
    const { move, storyWithWork } = await setup();
    const { story } = await storyWithWork();

    await expect(move(story, status)).rejects.toThrow(
      `Can't move ENG-1 to ${label}: open — ENG-1.1 Complete testing (no proof link), ENG-1.2 Write API`
    );
  });

  test.each(GATED)("with every sub-task done but no proof can't go to %s", async (label, status) => {
    const { move, storyWithWork } = await setup();
    const { story, work, testing } = await storyWithWork();
    await move(work, "done");
    await move(testing, "done");

    await expect(move(story, status)).rejects.toThrow(
      `Can't move ENG-1 to ${label}: open — ENG-1.1 Complete testing (no proof link)`
    );
  });

  test.each(GATED)("with proof and every sub-task done goes to %s", async (_label, status) => {
    const { move, setProof, storyWithWork } = await setup();
    const { story, work, testing } = await storyWithWork();
    await setProof(testing, PROOF_URL);
    await move(work, "done");
    await move(testing, "done");

    await expect(move(story, status)).resolves.toBeNull();
  });

  test("a canceled sub-task does not hold the story back", async () => {
    const { move, setProof, storyWithWork } = await setup();
    const { story, work, testing } = await storyWithWork();
    await move(work, "canceled");
    await move(testing, "done");
    await setProof(testing, PROOF_URL);

    await expect(move(story, "done")).resolves.toBeNull();
  });

  test.each(GATED)("a canceled Complete testing sub-task holds the story back from %s, even with proof", async (label, status) => {
    const { move, setProof, storyWithWork } = await setup();
    const { story, work, testing } = await storyWithWork();
    await move(work, "done");
    await setProof(testing, PROOF_URL);
    await move(testing, "canceled");

    await expect(move(story, status)).rejects.toThrow(
      `Can't move ENG-1 to ${label}: open — ENG-1.1 Complete testing`
    );
  });

  test.each(["backlog", "todo", "in_progress", "canceled"] as const)(
    "a move to %s is never gated",
    async (status) => {
      const { move, storyWithWork } = await setup();
      const { story } = await storyWithWork();

      await expect(move(story, status)).resolves.toBeNull();
    }
  );

  test.each(GATED)("a sub-task can always go to %s", async (_label, status) => {
    const { move, storyWithWork } = await setup();
    const { work, testing } = await storyWithWork();

    await expect(move(work, status)).resolves.toBeNull();
    await expect(move(testing, status)).resolves.toBeNull();
  });
});

describe("Done gate: features and epics", () => {
  test.each(GATED)("a feature with an open story can't go to %s; with it done, it can", async (label, status) => {
    const { create, move, storyWithWork, finishStory } = await setup();
    const epic = await create("epic", "Accounts");
    const feature = await create("feature", "Sign-in", epic);
    const ids = await storyWithWork(feature);

    await expect(move(feature, status)).rejects.toThrow(
      `Can't move Sign-in to ${label}: open — ENG-1 Login`
    );
    await finishStory(ids);
    await expect(move(feature, status)).resolves.toBeNull();
  });

  test.each(GATED)("an epic with an open feature can't go to %s; with it done, it can", async (label, status) => {
    const { create, move } = await setup();
    const epic = await create("epic", "Accounts");
    const feature = await create("feature", "Sign-in", epic);

    await expect(move(epic, status)).rejects.toThrow(
      `Can't move Accounts to ${label}: open — Sign-in`
    );
    await move(feature, "done");
    await expect(move(epic, status)).resolves.toBeNull();
  });
});

describe("Done gate: every status write path", () => {
  test.each([
    ["update (board drag and issue properties)", "update"],
    ["create with a gated status", "create"],
  ] as const)("%s refuses", async (_label, path) => {
    const { teamId, asMember, move, storyWithWork } = await setup();
    if (path === "update") {
      const { story } = await storyWithWork();
      await expect(move(story, "done")).rejects.toMatchObject({
        data: { code: "rule_refused", message: expect.stringMatching(/^Can't move ENG-1 to Done: open — /) },
      });
      return;
    }
    await expect(
      asMember.mutation(api.issues.create, { teamId, title: "Login", status: "done" })
    ).rejects.toThrow("Can't move ENG-1 to Done: open — ENG-1.1 Complete testing (no proof link)");
  });
});

describe("Done gate: no new child under a gated parent", () => {
  test.each(GATED)("a story can't be created under a feature in %s", async (label, status) => {
    const { create, move } = await setup();
    const epic = await create("epic", "Accounts");
    const feature = await create("feature", "Sign-in", epic);
    await move(feature, status);

    await expect(create("story", "Login", feature)).rejects.toThrow(
      `Sign-in is ${label}; reopen it before adding a story`
    );
  });

  test.each(GATED)("a sub-task can't be created under a story in %s", async (label, status) => {
    const { create, move, storyWithWork, finishStory } = await setup();
    const ids = await storyWithWork();
    await finishStory(ids);
    await move(ids.story, status);

    await expect(create("subtask", "Write docs", ids.story)).rejects.toThrow(
      `ENG-1 is ${label}; reopen it before adding a subtask`
    );
  });

  test.each(GATED)("a story can't be moved under a feature in %s", async (label, status) => {
    const { asMember, create, move } = await setup();
    const epic = await create("epic", "Accounts");
    const feature = await create("feature", "Sign-in", epic);
    await move(feature, status);
    const story = await create("story", "Login");

    await expect(
      asMember.mutation(api.issueRelations.setParent, { issueId: story, parentIssueId: feature })
    ).rejects.toThrow(`Sign-in is ${label}; reopen it before adding a story`);
  });

  test.each(["todo", "in_progress"] as const)("a child can be created and moved under a parent in %s", async (status) => {
    const { asMember, create, move } = await setup();
    const epic = await create("epic", "Accounts");
    const feature = await create("feature", "Sign-in", epic);
    await move(feature, status);
    const story = await create("story", "Login");

    await expect(create("story", "Logout", feature)).resolves.toBeDefined();
    await expect(
      asMember.mutation(api.issueRelations.setParent, { issueId: story, parentIssueId: feature })
    ).resolves.toBeNull();
  });

  test("a new story still gets its Complete testing sub-task", async () => {
    const { t, orgId, create } = await setup();
    const epic = await create("epic", "Accounts");
    const feature = await create("feature", "Sign-in", epic);
    const story = await create("story", "Login", feature);

    const children = await t.run((ctx) =>
      ctx.db
        .query("issues")
        .withIndex("by_org_and_parent", (q) => q.eq("orgId", orgId).eq("parentIssueId", story))
        .collect()
    );
    expect(children.map((child) => [child.title, child.testing])).toEqual([["Complete testing", true]]);
  });

  test("a wrong-kind parent gets the level message, not reopen, even when gated", async () => {
    const { create, move } = await setup();
    const epic = await create("epic", "Accounts");
    await move(epic, "done");

    await expect(create("story", "Login", epic)).rejects.toThrow(
      "A story's parent must be a feature, not an epic"
    );
  });

  test("reopening the gated parent lets the child in", async () => {
    const { create, move } = await setup();
    const epic = await create("epic", "Accounts");
    await move(epic, "done");
    await expect(create("feature", "Sign-in", epic)).rejects.toThrow(
      "Accounts is Done; reopen it before adding a feature"
    );

    await move(epic, "in_progress");
    await expect(create("feature", "Sign-in", epic)).resolves.toBeDefined();
  });
});
