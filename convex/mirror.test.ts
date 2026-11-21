/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { ensureAgent } from "./lib/agents";
import schema from "./schema";
import { registerRealTimers } from "./test-helpers.fixture";

const modules = import.meta.glob("./**/*.*s");

registerRealTimers();

const TEST_KEY = "sk_test_mirror";
const USER_ID = "user_sync";
const ORG_ID = "org_sync";
const MEMBERSHIP_ID = "orgmem_sync";
const USER_URL = `https://api.clerk.com/v1/users/${USER_ID}`;
const MEMBERSHIPS_URL = `${USER_URL}/organization_memberships?limit=100&offset=0`;

const clerkUser = {
  id: USER_ID,
  first_name: "Ada",
  last_name: "Lovelace",
  image_url: "https://img.example/ada.png",
  primary_email_address_id: "idn_1",
  email_addresses: [{ id: "idn_1", email_address: "ada@example.com" }],
};

const clerkMemberships = {
  data: [
    {
      id: MEMBERSHIP_ID,
      role: "org:admin",
      organization: { id: ORG_ID, name: "Hana-X", slug: "hana-x", image_url: null },
      public_user_data: { user_id: USER_ID },
    },
  ],
  total_count: 1,
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stubClerk(
  statuses: { user?: number; memberships?: number } = {},
  memberships: unknown = clerkMemberships
) {
  const fetchMock = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url === USER_URL) {
      return jsonResponse(clerkUser, statuses.user ?? 200);
    }
    if (url === MEMBERSHIPS_URL) {
      return jsonResponse(memberships, statuses.memberships ?? 200);
    }
    return jsonResponse({ errors: [] }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function signedIn() {
  return convexTest(schema, modules).withIdentity({ subject: USER_ID });
}

async function mirrorRows(t: ReturnType<typeof signedIn>) {
  return await t.run(async (ctx) => ({
    users: await ctx.db.query("users").collect(),
    organizations: await ctx.db.query("organizations").collect(),
    members: await ctx.db.query("members").collect(),
  }));
}

beforeEach(() => {
  process.env.CLERK_SECRET_KEY = TEST_KEY;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.CLERK_SECRET_KEY;
});

describe("mirror.syncCurrent", () => {
  test("mirrors a new user, organization and membership", async () => {
    const fetchMock = stubClerk();
    const t = signedIn();

    const counts = await t.action(api.mirror.syncCurrent, {});

    expect(counts).toEqual({ users: 1, organizations: 1, memberships: 1 });
    const rows = await mirrorRows(t);
    expect(rows.users).toHaveLength(1);
    expect(rows.users[0]).toMatchObject({
      clerkId: USER_ID,
      name: "Ada Lovelace",
      email: "ada@example.com",
    });
    expect(rows.organizations).toHaveLength(1);
    expect(rows.organizations[0]).toMatchObject({
      clerkOrgId: ORG_ID,
      name: "Hana-X",
      slug: "hana-x",
    });
    expect(rows.members).toHaveLength(1);
    expect(rows.members[0]).toMatchObject({
      clerkMembershipId: MEMBERSHIP_ID,
      role: "admin",
      userId: rows.users[0]._id,
      orgId: rows.organizations[0]._id,
    });

    const calls = fetchMock.mock.calls.map(([input, init]) => ({
      url: String(input),
      authorization: new Headers(init?.headers).get("Authorization"),
    }));
    expect(calls).toEqual(
      expect.arrayContaining([
        { url: USER_URL, authorization: `Bearer ${TEST_KEY}` },
        { url: MEMBERSHIPS_URL, authorization: `Bearer ${TEST_KEY}` },
      ])
    );
    expect(calls).toHaveLength(2);
  });

  test("a second call leaves the same single rows", async () => {
    stubClerk();
    const t = signedIn();

    await t.action(api.mirror.syncCurrent, {});
    const first = await mirrorRows(t);
    await t.action(api.mirror.syncCurrent, {});
    const second = await mirrorRows(t);

    expect(second).toEqual(first);
    expect(second.users).toHaveLength(1);
    expect(second.organizations).toHaveLength(1);
    expect(second.members).toHaveLength(1);
  });

  test.each([
    { name: "user 404", statuses: { user: 404 }, status: 404 },
    { name: "user 500", statuses: { user: 500 }, status: 500 },
    { name: "memberships 404", statuses: { memberships: 404 }, status: 404 },
    { name: "memberships 500", statuses: { memberships: 500 }, status: 500 },
  ])("$name throws and writes nothing", async ({ statuses, status }) => {
    stubClerk(statuses);
    const t = signedIn();

    await expect(t.action(api.mirror.syncCurrent, {})).rejects.toThrow(
      `Clerk API ${status}`
    );
    const rows = await mirrorRows(t);
    expect(rows).toEqual({ users: [], organizations: [], members: [] });
  });

  test("mirrors memberships from every page", async () => {
    const memberships = Array.from({ length: 101 }, (_, i) => ({
      id: `orgmem_${i}`,
      role: "org:member",
      organization: { id: `org_${i}`, name: `Org ${i}`, slug: `org-${i}`, image_url: null },
      public_user_data: { user_id: USER_ID },
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/organization_memberships")) {
          return jsonResponse({ data: page(memberships, url), total_count: memberships.length });
        }
        return jsonResponse(clerkUser);
      })
    );
    const t = signedIn();

    const counts = await t.action(api.mirror.syncCurrent, {});

    expect(counts).toEqual({ users: 1, organizations: 101, memberships: 101 });
    const rows = await mirrorRows(t);
    expect(rows.members.map((m) => m.clerkMembershipId).sort()).toEqual(
      memberships.map((m) => m.id).sort()
    );
  });

  test("keeps the stored role when Clerk returns an older membership", async () => {
    const membershipAt = (role: string, updatedAt: number) => ({
      ...clerkMemberships,
      data: [{ ...clerkMemberships.data[0], role, updated_at: updatedAt }],
    });
    const t = signedIn();
    stubClerk({}, membershipAt("org:member", 2000));
    await t.action(api.mirror.syncCurrent, {});
    stubClerk({}, membershipAt("org:admin", 1000));

    await t.action(api.mirror.syncCurrent, {});

    const rows = await mirrorRows(t);
    expect(rows.members.map((m) => m.role)).toEqual(["member"]);
  });

  test("refuses a caller with no identity", async () => {
    const fetchMock = stubClerk();
    const t = convexTest(schema, modules);

    await expect(t.action(api.mirror.syncCurrent, {})).rejects.toThrow(
      "Not authenticated"
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("refuses when the Clerk secret is missing", async () => {
    const fetchMock = stubClerk();
    delete process.env.CLERK_SECRET_KEY;
    const t = signedIn();

    await expect(t.action(api.mirror.syncCurrent, {})).rejects.toThrow(
      "CLERK_SECRET_KEY is not set"
    );
    expect(fetchMock).not.toHaveBeenCalled();
    const rows = await mirrorRows(t);
    expect(rows).toEqual({ users: [], organizations: [], members: [] });
  });
});

type ClerkState = {
  users: { id: string; first_name: string }[];
  orgs: { id: string; name: string }[];
  memberships: Record<string, { id: string; role: string; user: string; updatedAt?: number }[]>;
};

const zeroCounts = {
  users: { added: 0, changed: 0, removed: 0 },
  organizations: { added: 0, changed: 0, removed: 0, keptWithContent: 0 },
  members: { added: 0, changed: 0, removed: 0 },
};

function baseState(): ClerkState {
  return {
    users: [
      { id: "user_a", first_name: "Ada" },
      { id: "user_b", first_name: "Bea" },
    ],
    orgs: [{ id: ORG_ID, name: "Hana-X" }],
    memberships: {
      [ORG_ID]: [
        { id: "mem_a", role: "org:admin", user: "user_a" },
        { id: "mem_b", role: "org:member", user: "user_b" },
      ],
    },
  };
}

function page<T>(items: T[], url: URL) {
  const offset = Number(url.searchParams.get("offset"));
  const limit = Number(url.searchParams.get("limit"));
  return items.slice(offset, offset + limit);
}

function clerkBody(state: ClerkState, url: URL) {
  const path = url.pathname.replace("/v1", "");
  if (path === "/users") {
    return page(state.users, url);
  }
  if (path === "/organizations") {
    return { data: page(state.orgs, url) };
  }
  const orgId = path.split("/")[2];
  const memberships = (state.memberships[orgId] ?? []).map((m) => ({
    id: m.id,
    role: m.role,
    organization: { id: orgId },
    public_user_data: { user_id: m.user },
    updated_at: m.updatedAt,
  }));
  return { data: page(memberships, url) };
}

function stubClerkState(state: ClerkState, failPath?: string) {
  const fetchMock = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    if (failPath && url.pathname.endsWith(failPath)) {
      return jsonResponse({ errors: [] }, 500);
    }
    return jsonResponse(clerkBody(state, url));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function reconcile(t: ReturnType<typeof convexTest>, state: ClerkState) {
  stubClerkState(state);
  return await t.action(internal.mirror.reconcileAll, {});
}

describe("mirror.reconcileAll", () => {
  test("mirrors Clerk and a second run reports zero changes", async () => {
    const t = convexTest(schema, modules);

    const first = await reconcile(t, baseState());
    expect(first).toEqual({
      users: { added: 2, changed: 0, removed: 0 },
      organizations: { added: 1, changed: 0, removed: 0, keptWithContent: 0 },
      members: { added: 2, changed: 0, removed: 0 },
    });
    const rows = await mirrorRows(t);
    const second = await reconcile(t, baseState());

    expect(second).toEqual(zeroCounts);
    expect(await mirrorRows(t)).toEqual(rows);
  });

  test("removes a membership gone from Clerk", async () => {
    const t = convexTest(schema, modules);
    await reconcile(t, baseState());
    const state = baseState();
    state.users.push({ id: "user_c", first_name: "Cy" });
    state.memberships[ORG_ID].push({ id: "mem_c", role: "org:member", user: "user_c" });
    await reconcile(t, state);
    state.memberships[ORG_ID].pop();

    const counts = await reconcile(t, state);

    expect(counts.members).toEqual({ added: 0, changed: 0, removed: 1 });
    expect(counts.users).toEqual({ added: 0, changed: 0, removed: 0 });
    const rows = await mirrorRows(t);
    expect(rows.members.map((m) => m.clerkMembershipId).sort()).toEqual(["mem_a", "mem_b"]);
    expect(rows.users).toHaveLength(3);
  });

  test("applies a role change", async () => {
    const t = convexTest(schema, modules);
    await reconcile(t, baseState());
    const state = baseState();
    state.memberships[ORG_ID][1].role = "org:admin";

    const counts = await reconcile(t, state);

    expect(counts.members).toEqual({ added: 0, changed: 1, removed: 0 });
    const rows = await mirrorRows(t);
    const bea = rows.members.find((m) => m.clerkMembershipId === "mem_b");
    expect(bea?.role).toBe("admin");
  });

  test.each([
    {
      name: "ignores a directory read older than the stored role",
      updatedAt: 1000,
      role: "member",
      changed: 0,
    },
    {
      name: "applies a directory read newer than the stored role",
      updatedAt: 3000,
      role: "admin",
      changed: 1,
    },
  ])("$name", async ({ updatedAt, role, changed }) => {
    const t = convexTest(schema, modules);
    const state = baseState();
    state.memberships[ORG_ID][1].updatedAt = 2000;
    await reconcile(t, state);
    Object.assign(state.memberships[ORG_ID][1], { role: "org:admin", updatedAt });

    const counts = await reconcile(t, state);

    expect(counts.members).toEqual({ added: 0, changed, removed: 0 });
    const rows = await mirrorRows(t);
    const bea = rows.members.find((m) => m.clerkMembershipId === "mem_b");
    expect(bea?.role).toBe(role);
  });

  test("keeps an organization gone from Clerk that still has a team", async () => {
    const t = convexTest(schema, modules);
    await reconcile(t, baseState());
    await t.run(async (ctx) => {
      const org = await ctx.db.query("organizations").first();
      await ctx.db.insert("teams", {
        orgId: org!._id,
        name: "Engineering",
        key: "ENG",
        nextIssueNumber: 1,
      });
    });
    const state = baseState();
    state.orgs = [];
    state.memberships = {};

    const counts = await reconcile(t, state);

    expect(counts.organizations).toEqual({
      added: 0,
      changed: 0,
      removed: 0,
      keptWithContent: 1,
    });
    expect(counts.members.removed).toBe(2);
    const rows = await mirrorRows(t);
    expect(rows.organizations).toHaveLength(1);
    expect(rows.members).toHaveLength(0);
  });

  test("removes an organization gone from Clerk with no content", async () => {
    const t = convexTest(schema, modules);
    await reconcile(t, baseState());
    const state = baseState();
    state.orgs = [];
    state.memberships = {};

    const counts = await reconcile(t, state);

    expect(counts.organizations).toEqual({
      added: 0,
      changed: 0,
      removed: 1,
      keptWithContent: 0,
    });
    const rows = await mirrorRows(t);
    expect(rows.organizations).toHaveLength(0);
    expect(rows.members).toHaveLength(0);
  });

  test("removes a user gone from Clerk with no membership left", async () => {
    const t = convexTest(schema, modules);
    await reconcile(t, baseState());
    const state = baseState();
    state.users = state.users.filter((u) => u.id !== "user_b");
    state.memberships[ORG_ID] = state.memberships[ORG_ID].filter((m) => m.user !== "user_b");

    const counts = await reconcile(t, state);

    expect(counts.users).toEqual({ added: 0, changed: 0, removed: 1 });
    expect(counts.members).toEqual({ added: 0, changed: 0, removed: 1 });
    const rows = await mirrorRows(t);
    expect(rows.users.map((u) => u.clerkId)).toEqual(["user_a"]);
  });

  test("keeps an agent and its membership that Clerk does not know, and does not count them", async () => {
    const t = convexTest(schema, modules);
    await reconcile(t, baseState());
    const agentId = await t.run(async (ctx) => {
      const org = await ctx.db.query("organizations").first();
      return await ensureAgent(ctx, org!._id, "cc1");
    });

    const counts = await reconcile(t, baseState());

    expect(counts).toEqual(zeroCounts);
    const rows = await mirrorRows(t);
    expect(rows.users.map((u) => u.clerkId).sort()).toEqual(["agent:cc1", "user_a", "user_b"]);
    expect(rows.members.filter((m) => m.userId === agentId)).toHaveLength(1);
  });

  test("keeps a user and membership created after the Clerk read", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000);
    const t = convexTest(schema, modules);
    await reconcile(t, baseState());
    const state = baseState();
    state.users = state.users.filter((u) => u.id !== "user_b");
    state.memberships[ORG_ID] = state.memberships[ORG_ID].filter((m) => m.user !== "user_b");
    vi.setSystemTime(2_000);
    let joined = false;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input) => {
        const url = new URL(String(input));
        const body = clerkBody(state, url);
        if (!joined) {
          joined = true;
          vi.setSystemTime(3_000);
          await t.mutation(internal.webhooks.handleClerkEvent, {
            eventType: "user.updated",
            data: { id: "user_late", first_name: "Lee" },
          });
          await t.mutation(internal.webhooks.handleClerkEvent, {
            eventType: "organizationMembership.updated",
            data: {
              id: "mem_late",
              role: "org:member",
              organization: { id: ORG_ID },
              public_user_data: { user_id: "user_late" },
            },
          });
        }
        return jsonResponse(body);
      })
    );

    await t.action(internal.mirror.reconcileAll, {});

    const rows = await mirrorRows(t);
    expect(rows.users.map((u) => u.clerkId).sort()).toEqual(["user_a", "user_late"]);
    expect(rows.members.map((m) => m.clerkMembershipId).sort()).toEqual(["mem_a", "mem_late"]);
  });

  test("keeps an organization created after the Clerk read and removes an older one", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000);
    const t = convexTest(schema, modules);
    await reconcile(t, baseState());
    const state = baseState();
    state.orgs = [];
    state.memberships = {};
    vi.setSystemTime(2_000);
    let joined = false;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input) => {
        const url = new URL(String(input));
        const body = clerkBody(state, url);
        if (!joined) {
          joined = true;
          vi.setSystemTime(3_000);
          await t.mutation(internal.webhooks.handleClerkEvent, {
            eventType: "organization.updated",
            data: { id: "org_late", name: "Late" },
          });
          await t.mutation(internal.webhooks.handleClerkEvent, {
            eventType: "organizationMembership.updated",
            data: {
              id: "mem_late",
              role: "org:admin",
              organization: { id: "org_late" },
              public_user_data: { user_id: "user_a" },
            },
          });
        }
        return jsonResponse(body);
      })
    );

    await t.action(internal.mirror.reconcileAll, {});

    const rows = await mirrorRows(t);
    expect(rows.organizations.map((o) => o.clerkOrgId)).toEqual(["org_late"]);
    expect(rows.members.map((m) => m.clerkMembershipId)).toEqual(["mem_late"]);
  });

  test.each(["/users", "/organizations", `/organizations/${ORG_ID}/memberships`])(
    "a 500 on %s throws and writes nothing",
    async (failPath) => {
      const t = convexTest(schema, modules);
      stubClerkState(baseState(), failPath);

      await expect(t.action(internal.mirror.reconcileAll, {})).rejects.toThrow(
        "Clerk API 500"
      );
      expect(await mirrorRows(t)).toEqual({ users: [], organizations: [], members: [] });
    }
  );

  test("follows paging past 100 users", async () => {
    const t = convexTest(schema, modules);
    const state = baseState();
    for (let i = 0; i < 99; i++) {
      state.users.push({ id: `user_extra_${i}`, first_name: `Extra ${i}` });
    }

    const counts = await reconcile(t, state);

    expect(counts.users.added).toBe(101);
    expect((await mirrorRows(t)).users).toHaveLength(101);
  });

  test("logs one line and never the secret", async () => {
    const t = convexTest(schema, modules);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const counts = await reconcile(t, baseState());

    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      "mirror reconcile: users +2 ~0 -0, orgs +1 ~0 -0 (kept 0 with content), members +2 ~0 -0"
    );
    expect(JSON.stringify(counts)).not.toContain(TEST_KEY);
    log.mockRestore();
  });
});
