/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { api } from "./_generated/api";
import { LIST_LIMIT, MAX_ATTACHMENT_BYTES } from "../lib/api-contract";
import { Id } from "./_generated/dataModel";
import { insertOrgMember, MEMBER_IDENTITY, ORG_CLAIM } from "./lib/orgMember.fixture";
import schema from "./schema";
import { refusalOf } from "./test-helpers.fixture";

const modules = import.meta.glob("./**/*.*s");

async function setup() {
  const t = convexTest(schema, modules);
  const { orgId, teamId, memberId } = await t.run(async (ctx) => {
    const { memberId, orgId } = await insertOrgMember(ctx);
    const teamId = await ctx.db.insert("teams", {
      orgId,
      name: "Citadel",
      key: "HXT",
      nextIssueNumber: 7,
    });
    return { orgId, teamId, memberId };
  });
  const asMember = t.withIdentity(MEMBER_IDENTITY);

  const createIssue = () =>
    asMember.mutation(api.issues.create, { teamId, title: "A story", kind: "story" });

  const storeFile = () => t.run((ctx) => ctx.storage.store(new Blob(["proof"])));

  const attach = (issueId: Id<"issues">, storageId: Id<"_storage">) =>
    asMember.mutation(api.attachments.create, {
      issueId,
      storageId,
      fileName: "proof.txt",
      fileType: "text/plain",
      fileSize: 5,
    });

  const removeAttachment = (attachmentId: Id<"attachments">) =>
    asMember.mutation(api.attachments.remove, { attachmentId });

  const storedFile = (storageId: Id<"_storage">) => t.run((ctx) => ctx.db.system.get(storageId));

  const asOtherMember = async () => {
    await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { clerkId: "user_other", name: "Other", email: "other@example.com" });
      await ctx.db.insert("members", { orgId, userId, role: "member", clerkMembershipId: "mem_other" });
    });
    return t.withIdentity({ subject: "user_other", org_id: ORG_CLAIM });
  };

  return { t, orgId, memberId, asMember, createIssue, storeFile, attach, removeAttachment, storedFile, asOtherMember };
}

describe("attachments keep one owner per stored file", () => {
  test("create refuses a file another attachment already uses", async () => {
    const { createIssue, storeFile, attach } = await setup();
    const firstId = await createIssue();
    const secondId = await createIssue();
    const file = await storeFile();
    await attach(firstId, file);

    await expect(attach(secondId, file)).rejects.toThrow("This file is already attached");
    await expect(attach(firstId, file)).rejects.toThrow("This file is already attached");
  });

  test("create accepts a file no attachment uses", async () => {
    const { createIssue, storeFile, attach } = await setup();
    const issueId = await createIssue();

    await attach(issueId, await storeFile());
    await attach(issueId, await storeFile());
  });
});

describe("attachments.remove", () => {
  test("a member who neither uploaded the file nor is an admin gets a typed rule refusal, and the file stays", async () => {
    const { createIssue, storeFile, attach, storedFile, asOtherMember } = await setup();
    const file = await storeFile();
    const attachmentId = await attach(await createIssue(), file);
    const other = await asOtherMember();

    const refusal = await other.mutation(api.attachments.remove, { attachmentId }).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ConvexError);
    expect((refusal as ConvexError<{ code: string; message: string }>).data).toEqual({
      code: "rule_refused",
      message: "Only the uploader or an admin can delete an attachment",
    });
    expect(await storedFile(file)).not.toBeNull();
  });
});

describe("attachments.create", () => {
  test("a file over the limit is a typed validation refusal", async () => {
    const { asMember, createIssue, storeFile } = await setup();
    const issueId = await createIssue();
    const args = { issueId, fileName: "big.bin", fileType: "application/octet-stream" };

    const error = await asMember
      .mutation(api.attachments.create, { ...args, storageId: await storeFile(), fileSize: MAX_ATTACHMENT_BYTES + 1 })
      .catch(refusalOf);
    expect(error).toEqual({ code: "validation", message: "Attachments are limited to 25 MB" });

    await asMember.mutation(api.attachments.create, { ...args, storageId: await storeFile(), fileSize: MAX_ATTACHMENT_BYTES });
  });

  test("refuses a file another workspace has attached, so its download URL never reaches us", async () => {
    const { t, createIssue, storeFile, attach, asMember } = await setup();
    const issueId = await createIssue();
    const file = await storeFile();
    await t.run(async (ctx) => {
      const otherOrgId = await ctx.db.insert("organizations", { clerkOrgId: "org_other", name: "Other", slug: "other" });
      const otherUser = await ctx.db.insert("users", { clerkId: "user_foreign", name: "Foreign", email: "f@example.com" });
      const otherTeam = await ctx.db.insert("teams", { orgId: otherOrgId, name: "Other", key: "OTH", nextIssueNumber: 1 });
      const otherIssue = await ctx.db.insert("issues", {
        orgId: otherOrgId,
        teamId: otherTeam,
        kind: "story",
        title: "Theirs",
        status: "todo",
        priority: "none",
        creatorId: otherUser,
        sortOrder: 1,
      });
      await ctx.db.insert("attachments", {
        orgId: otherOrgId,
        issueId: otherIssue,
        storageId: file,
        fileName: "theirs.txt",
        fileType: "text/plain",
        fileSize: 5,
        uploadedBy: otherUser,
      });
    });

    await expect(attach(issueId, file)).rejects.toThrow("This file is already attached");
    const listed = await asMember.query(api.attachments.listByIssue, {
      issueId,
      paginationOpts: { cursor: null, numItems: 50 },
    });
    expect(listed.page).toEqual([]);
  });
});

describe("attachments.listByIssue", () => {
  const PAGE_SIZE = 50;
  const COUNT = LIST_LIMIT + 1;
  /** Newest first: file-500 down to file-0. */
  const allNames = Array.from({ length: COUNT }, (_, index) => `file-${COUNT - 1 - index}`);

  /** An issue with file-0 (oldest) to file-500, each with its own file, and another workspace's row pointing at it. */
  async function crowdedIssue() {
    const context = await setup();
    const { t, orgId, memberId, asMember, createIssue } = context;
    const issueId = await createIssue();
    await t.run(async (ctx) => {
      const foreignOrgId = await ctx.db.insert("organizations", { clerkOrgId: "org_other", name: "Other", slug: "other" });
      const insert = async (rowOrgId: Id<"organizations">, fileName: string) =>
        ctx.db.insert("attachments", {
          orgId: rowOrgId,
          issueId,
          storageId: await ctx.storage.store(new Blob([fileName])),
          fileName,
          fileType: "text/plain",
          fileSize: 5,
          uploadedBy: memberId,
        });
      for (let index = 0; index < COUNT; index += 1) {
        await insert(orgId, `file-${index}`);
        if (index === LIST_LIMIT / 2) {
          await insert(foreignOrgId, "foreign.txt");
        }
      }
    });

    const page = (cursor: string | null, numItems = PAGE_SIZE) =>
      asMember.query(api.attachments.listByIssue, { issueId, paginationOpts: { cursor, numItems } });
    const loadAll = async () => {
      let result = await page(null);
      const listed = [...result.page];
      while (!result.isDone) {
        result = await page(result.continueCursor);
        listed.push(...result.page);
      }
      return listed;
    };
    return { ...context, page, loadAll };
  }

  test("the first page and load-more pages reach all LIST_LIMIT + 1 attachments, newest first, and no foreign row", async () => {
    const { page, loadAll } = await crowdedIssue();

    const first = await page(null);
    expect(first.page.map((row) => row.fileName)).toEqual(allNames.slice(0, PAGE_SIZE));
    expect(first.isDone).toBe(false);

    expect((await loadAll()).map((row) => row.fileName)).toEqual(allNames);
  });

  test("a page holds at most LIST_LIMIT attachments, whatever size the client asks for", async () => {
    const { page } = await crowdedIssue();

    const asked = await page(null, COUNT);
    expect(asked.page.map((row) => row.fileName)).toEqual(allNames.slice(0, LIST_LIMIT));
    expect(asked.isDone).toBe(false);
  });

  test("an attachment from a later page can be deleted, with its file", async () => {
    const { t, page, loadAll, removeAttachment, storedFile } = await crowdedIssue();
    const second = await page((await page(null)).continueCursor);
    const target = second.page[0];
    expect(target.fileName).toBe(allNames[PAGE_SIZE]);
    const { storageId } = (await t.run((ctx) => ctx.db.get(target._id)))!;

    await removeAttachment(target._id);

    expect(await storedFile(storageId)).toBeNull();
    expect((await loadAll()).map((row) => row.fileName)).toEqual(allNames.filter((name) => name !== target.fileName));
  });
});
