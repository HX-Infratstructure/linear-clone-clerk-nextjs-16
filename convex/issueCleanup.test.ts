/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { deleteIssuesWithOwnedRows } from "./lib/issueCleanup";
import { insertOrgMember, MEMBER_IDENTITY } from "./lib/orgMember.fixture";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");

type Kind = "feature" | "story" | "subtask";

async function setup() {
  const t = convexTest({ schema, modules, transactionLimits: true });
  const { orgId, teamId, memberId, labelId } = await t.run(async (ctx) => {
    const { memberId, orgId } = await insertOrgMember(ctx);
    const teamId = await ctx.db.insert("teams", {
      orgId,
      name: "Citadel",
      key: "HXT",
      nextIssueNumber: 7,
    });
    const labelId = await ctx.db.insert("labels", { orgId, name: "backend", color: "#000000" });
    return { orgId, teamId, memberId, labelId };
  });
  const asMember = t.withIdentity(MEMBER_IDENTITY);

  const create = (kind: Kind, parentIssueId?: Id<"issues">) =>
    asMember.mutation(api.issues.create, { teamId, title: `A ${kind}`, kind, parentIssueId });

  /** One cleanup run over the issues still there, in order, as an admin clear runs it. */
  const cleanupRun = (...issueIds: Id<"issues">[]) =>
    t.run(async (ctx) => {
      const issues = await Promise.all(issueIds.map((issueId) => ctx.db.get(issueId)));
      return await deleteIssuesWithOwnedRows(ctx, issues.filter((issue) => issue !== null));
    });

  const attachmentRow = (issueId: Id<"issues">, storageId: Id<"_storage">) => ({
    orgId,
    issueId,
    storageId,
    fileName: "proof.txt",
    fileType: "text/plain",
    fileSize: 5,
    uploadedBy: memberId,
  });

  const addOwnedRows = (issueId: Id<"issues">) =>
    t.run(async (ctx) => {
      const storageId = await ctx.storage.store(new Blob(["proof"]));
      await ctx.db.insert("comments", { orgId, issueId, authorId: memberId, body: "a comment" });
      await ctx.db.insert("decisions", { orgId, issueId, askedBy: memberId, question: "Ship?", status: "open" });
      await ctx.db.insert("activity", { orgId, issueId, actorId: memberId, type: "commented" });
      await ctx.db.insert("attachments", attachmentRow(issueId, storageId));
      await ctx.db.insert("issueLabels", { issueId, labelId });
      return storageId;
    });

  const addAttachments = (issueId: Id<"issues">, count: number) =>
    t.run(async (ctx) => {
      for (let i = 0; i < count; i++) {
        await ctx.db.insert("attachments", attachmentRow(issueId, await ctx.storage.store(new Blob(["proof"]))));
      }
    });

  const relate = (issueId: Id<"issues">, relatedIssueId: Id<"issues">) =>
    t.run((ctx) =>
      ctx.db.insert("issueRelations", { issueId, relatedIssueId, type: "related" })
    );

  const ownedRowCounts = (issueId: Id<"issues">) =>
    t.run(async (ctx) => {
      const count = async <T>(rows: Promise<T[]>) => (await rows).length;
      return {
        comments: await count(
          ctx.db.query("comments").withIndex("by_issue", (q) => q.eq("issueId", issueId)).collect()
        ),
        activity: await count(
          ctx.db.query("activity").withIndex("by_issue", (q) => q.eq("issueId", issueId)).collect()
        ),
        attachments: await count(
          ctx.db.query("attachments").withIndex("by_issue", (q) => q.eq("issueId", issueId)).collect()
        ),
        decisions: await count(
          ctx.db.query("decisions").withIndex("by_issue", (q) => q.eq("issueId", issueId)).collect()
        ),
        issueLabels: await count(
          ctx.db.query("issueLabels").withIndex("by_issue", (q) => q.eq("issueId", issueId)).collect()
        ),
        relationsAsSource: await count(
          ctx.db.query("issueRelations").withIndex("by_issue", (q) => q.eq("issueId", issueId)).collect()
        ),
        relationsAsTarget: await count(
          ctx.db
            .query("issueRelations")
            .withIndex("by_related", (q) => q.eq("relatedIssueId", issueId))
            .collect()
        ),
      };
    });

  const storedFile = (storageId: Id<"_storage">) => t.run((ctx) => ctx.db.system.get(storageId));

  const storedFileCount = () => t.run(async (ctx) => (await ctx.db.system.query("_storage").collect()).length);

  const issueDoc = (issueId: Id<"issues">) => t.run((ctx) => ctx.db.get(issueId));

  const addComments = (issueId: Id<"issues">, count: number, body: string) =>
    t.run(async (ctx) => {
      for (let i = 0; i < count; i++) {
        await ctx.db.insert("comments", { orgId, issueId, authorId: memberId, body });
      }
    });

  return {
    create,
    addComments,
    cleanupRun,
    addOwnedRows,
    addAttachments,
    relate,
    ownedRowCounts,
    storedFile,
    storedFileCount,
    issueDoc,
  };
}

/** About 20 MiB of comments on one issue: more than a mutation may read (`TRANSACTION_LIMITS.bytesRead` in `./lib/transactionLimits`). */
const HEAVY_COMMENTS = 4_000;
const COMMENT_BYTES = 5 * 1024;
/** Comments one test transaction writes, well inside the limits. */
const SEED_BATCH = 1_000;
/** Attachments on one issue, each with its own file: more rows than one run deletes. */
const MANY_ATTACHMENTS = 4_100;
/** More runs than the heavy issue needs, so a cleanup that never finishes fails instead of looping. */
const MAX_RUNS = 10;

const NONE = {
  comments: 0,
  activity: 0,
  attachments: 0,
  decisions: 0,
  issueLabels: 0,
  relationsAsSource: 0,
  relationsAsTarget: 0,
};

describe("deleting issues with their owned rows leaves nothing behind", () => {
  test("a story and its sub-task lose every owned row and stored file", async () => {
    const { create, cleanupRun, addOwnedRows, relate, ownedRowCounts, storedFile, issueDoc } =
      await setup();
    const storyId = await create("story");
    const subtaskId = await create("subtask", storyId);
    const otherId = await create("story");
    const storyFile = await addOwnedRows(storyId);
    const subtaskFile = await addOwnedRows(subtaskId);
    await relate(storyId, otherId);
    await relate(subtaskId, otherId);

    await cleanupRun(subtaskId, storyId);

    expect(await ownedRowCounts(storyId)).toEqual(NONE);
    expect(await ownedRowCounts(subtaskId)).toEqual(NONE);
    expect(await storedFile(storyFile)).toBeNull();
    expect(await storedFile(subtaskFile)).toBeNull();
    expect(await issueDoc(storyId)).toBeNull();
    expect(await issueDoc(subtaskId)).toBeNull();
  });

  test("a relation where the deleted issue is the target goes too", async () => {
    const { create, cleanupRun, relate, ownedRowCounts } = await setup();
    const sourceId = await create("story");
    const targetId = await create("story");
    await relate(sourceId, targetId);

    await cleanupRun(targetId);

    expect((await ownedRowCounts(sourceId)).relationsAsSource).toBe(0);
  });

  test("another issue's comments, labels and relations are untouched", async () => {
    const { create, cleanupRun, addOwnedRows, relate, ownedRowCounts, storedFile } = await setup();
    const deletedId = await create("story");
    const keptId = await create("story");
    const thirdId = await create("story");
    await addOwnedRows(deletedId);
    const keptFile = await addOwnedRows(keptId);
    await relate(keptId, thirdId);
    await relate(thirdId, keptId);
    const before = await ownedRowCounts(keptId);

    await cleanupRun(deletedId);

    expect(await ownedRowCounts(keptId)).toEqual(before);
    expect(before.comments).toBe(1);
    expect(before.issueLabels).toBe(1);
    expect(before.relationsAsSource).toBe(1);
    expect(before.relationsAsTarget).toBe(1);
    expect(await storedFile(keptFile)).not.toBeNull();
  });

  test("an issue that owns more than one mutation can read goes over several runs, each within the limits", async () => {
    const { create, cleanupRun, addOwnedRows, addComments, ownedRowCounts, issueDoc } = await setup();
    const storyId = await create("story");
    const subtaskId = await create("subtask", storyId);
    await addOwnedRows(subtaskId);
    for (let seeded = 0; seeded < HEAVY_COMMENTS; seeded += SEED_BATCH) {
      await addComments(storyId, SEED_BATCH, "x".repeat(COMMENT_BYTES));
    }

    const finishedRuns: boolean[] = [];
    while (finishedRuns.length < MAX_RUNS && finishedRuns.at(-1) !== true) {
      finishedRuns.push((await cleanupRun(subtaskId, storyId)).finished);
    }

    expect(finishedRuns.length).toBeGreaterThan(1);
    expect(finishedRuns.at(-1)).toBe(true);
    expect(await issueDoc(storyId)).toBeNull();
    expect(await issueDoc(subtaskId)).toBeNull();
    expect(await ownedRowCounts(storyId)).toEqual(NONE);
    expect(await ownedRowCounts(subtaskId)).toEqual(NONE);
  });

  test("an issue with more attachments than one run deletes goes in a few runs, with every file", async () => {
    const { create, cleanupRun, addAttachments, ownedRowCounts, storedFileCount, issueDoc } = await setup();
    const storyId = await create("story");
    for (let seeded = 0; seeded < MANY_ATTACHMENTS; seeded += SEED_BATCH) {
      await addAttachments(storyId, Math.min(SEED_BATCH, MANY_ATTACHMENTS - seeded));
    }

    const finishedRuns: boolean[] = [];
    while (finishedRuns.length < MAX_RUNS && finishedRuns.at(-1) !== true) {
      finishedRuns.push((await cleanupRun(storyId)).finished);
    }

    expect(finishedRuns.length).toBeGreaterThan(1);
    expect(finishedRuns.at(-1)).toBe(true);
    expect(await issueDoc(storyId)).toBeNull();
    expect(await ownedRowCounts(storyId)).toEqual(NONE);
    expect(await storedFileCount()).toBe(0);
  }, 60_000);
});
