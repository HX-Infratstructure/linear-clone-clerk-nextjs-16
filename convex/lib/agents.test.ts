/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import { Id } from "../_generated/dataModel";
import schema from "../schema";
import { agentClerkId, ensureAgent, normalizeAgentName } from "./agents";
import { insertOrgMember, MEMBER_CLERK_ID, MEMBER_IDENTITY } from "./orgMember.fixture";

const modules = import.meta.glob("../**/*.*s");

describe("normalizeAgentName", () => {
  test.each([
    ["cc1", "cc1"],
    ["  CC1  ", "cc1"],
    ["Codex.Bot_2-x", "codex.bot_2-x"],
    ["system", "system"],
    ["a".repeat(64), "a".repeat(64)],
  ])("%j becomes %j", (raw, normalized) => {
    expect(normalizeAgentName(raw)).toBe(normalized);
  });

  test.each(["", "   ", "cc 1", "cc1!", "agent:cc1", "cc/1", "ü", "a".repeat(65), "me", " ME "])(
    "%j is refused",
    (raw) => {
      expect(() => normalizeAgentName(raw)).toThrow("invalid agent name");
    }
  );
});

describe("agentClerkId", () => {
  test("prefixes the normalized name", () => {
    expect(agentClerkId(" CC1 ")).toBe("agent:cc1");
  });
});

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const { memberId, orgId } = await insertOrgMember(ctx, { name: "cc1" });
    const teamId = await ctx.db.insert("teams", {
      orgId,
      name: "Engineering",
      key: "ENG",
      nextIssueNumber: 1,
    });
    return { memberId, orgId, teamId };
  });
  const ensure = (rawName: string) => t.run((ctx) => ensureAgent(ctx, ids.orgId, rawName));
  return { t, ensure, ...ids };
}

describe("ensureAgent", () => {
  test("creates an agent member once and returns the same user every time", async () => {
    const { t, ensure, orgId } = await setup();

    const first = await ensure("CC1");
    const second = await ensure(" cc1 ");

    expect(second).toBe(first);
    const rows = await t.run(async (ctx) => ({
      agent: await ctx.db.get(first),
      memberships: (await ctx.db.query("members").collect()).filter((m) => m.userId === first),
    }));
    expect(rows.agent).toMatchObject({
      clerkId: "agent:cc1",
      name: "cc1",
      email: "",
      kind: "agent",
    });
    expect(rows.memberships).toHaveLength(1);
    expect(rows.memberships[0]).toMatchObject({ orgId, role: "member" });
  });

  test("never matches a human with the same display name", async () => {
    const { t, ensure, memberId } = await setup();

    const agentId = await ensure("cc1");

    expect(agentId).not.toBe(memberId);
    const human = await t.run((ctx) => ctx.db.get(memberId));
    expect(human).toMatchObject({ clerkId: MEMBER_CLERK_ID, name: "cc1" });
    expect(human?.kind).toBeUndefined();
  });

  test("refuses an invalid name and writes nothing", async () => {
    const { t, ensure } = await setup();

    await expect(ensure("cc 1")).rejects.toThrow("invalid agent name");

    const users = await t.run((ctx) => ctx.db.query("users").collect());
    expect(users).toHaveLength(1);
  });
});

describe("one story In Progress per agent", () => {
  test("an agent holding an In Progress story is refused a second, by name", async () => {
    const { t, ensure, teamId } = await setup();
    const agentId = await ensure("cc1");
    const asMember = t.withIdentity(MEMBER_IDENTITY);
    const story = (title: string) =>
      asMember.mutation(api.issues.create, { teamId, title, assigneeId: agentId });
    const start = (issueId: Id<"issues">) =>
      asMember.mutation(api.issues.update, { issueId, status: "in_progress" });

    const first = await story("First");
    const second = await story("Second");
    await start(first);

    await expect(start(second)).rejects.toMatchObject({
      data: { code: "rule_refused", message: "cc1 already has ENG-1 In Progress; move it to In Review or Done first" },
    });
  });
});
