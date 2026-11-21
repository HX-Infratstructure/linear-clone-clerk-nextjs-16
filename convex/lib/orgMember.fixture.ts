import type { MutationCtx } from "../_generated/server";

/** The `org_id` claim of the test member's identity, and the Clerk id of its org. */
export const ORG_CLAIM = "org_test";
/** The Clerk id of the user that `insertOrgMember` inserts. */
export const MEMBER_CLERK_ID = "user_member";
/** Pass to `t.withIdentity` to call functions as the member that `insertOrgMember` inserts. */
export const MEMBER_IDENTITY = { subject: MEMBER_CLERK_ID, org_id: ORG_CLAIM } as const;

/**
 * Inserts the user, the org ("Test Org", slug "test-org") and the user's `member` membership, in that order,
 * and returns `{ orgId, memberId }`. Insert any other users, orgs or members after this call, so each table
 * keeps its row order.
 */
export async function insertOrgMember(ctx: Pick<MutationCtx, "db">, { name = "Member" }: { name?: string } = {}) {
  const memberId = await ctx.db.insert("users", { clerkId: MEMBER_CLERK_ID, name, email: "member@example.com" });
  const orgId = await ctx.db.insert("organizations", { clerkOrgId: ORG_CLAIM, name: "Test Org", slug: "test-org" });
  await ctx.db.insert("members", { orgId, userId: memberId, role: "member", clerkMembershipId: "mem_member" });
  return { orgId, memberId };
}
