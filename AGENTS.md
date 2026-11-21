# HX-Citadel agent guide

HX-Citadel is the HX team's work tracker for agentic and agile development, with one workspace for the HX team. It is built with Next.js 16 (App Router), Convex, Clerk, shadcn/ui, Tailwind 4 and pnpm.

## Architecture rules

- **Clerk is the source of truth** for users, organizations and memberships. Convex mirrors them in the `users`, `organizations` and `members` tables. Clerk webhooks do not arrive, so `mirror:syncCurrent` and a cron that runs `mirror:reconcileAll` keep the mirror current. The README's [Clerk sync](README.md#clerk-sync) section says when each one runs. Feature code never writes to those tables.
  - The one exception: `convex/lib/agents.ts` writes agent users and their HX workspace membership. `ensureAgent` creates them (owner and DSH approved, phase 3), and `removeAgentMembership` deletes a membership for the operator command `agentAdmin:removeAgent`.
- **Every Convex function uses a wrapper** from `convex/lib/customFunctions.ts`:
  - `orgQuery` and `orgMutation` resolve `ctx.user`, `ctx.org` and `ctx.membership` through `getAuthContext` in `convex/lib/auth.ts`. The JWT `subject` selects the user by `clerkId`, the `org_id` claim selects the organization, and the caller must have a `members` row in it.
  - `orgAdminMutation` does the same and also requires `ctx.membership.role === "admin"`.
  - `authedQuery` and `authedMutation` require a signed-in user but no organization. Use them rarely.
  - A public `query` or `mutation` without a wrapper is forbidden, except the existing `users.current` and `organizations.current`.
- **Scope everything by `ctx.org._id`.** Filter every query by it, and check that any document you load by ID belongs to it. `getOrgIssue`, beside `requireOrgRow` in `convex/lib/orgRows.ts`, shows the pattern for issues.
- **Validators on args and returns** of every public function. Import the shared validators (`issueStatusValidator`, `issuePriorityValidator`, `memberRoleValidator` and the others) from `convex/schema.ts`. Reuse a shape that already exists, such as `issueShape` in `convex/lib/issues/shape.ts`.
- **Activity logging.** Every mutation that changes an issue calls `logActivity` from `convex/lib/activity.ts`.

## UI conventions

- Use the shadcn/ui components in `components/ui/` and lucide icons.
- Keep Linear-style density: small text and `h-7` or `h-9` rows.
- Dark theme is the default. `next-themes` provides light mode.
- Shared primitives live in `components/shared/`: `StatusIcon`, `PriorityIcon`, `UserAvatar`, `LabelChip` and the constants in `issue-meta.ts`.
- Register command-palette commands and single-key shortcuts in `components/commands/registry.ts`. Register issue detail panels in `components/issue-detail/slots.tsx`.

## Routes

- Workspace routes live under `app/(app)/[orgSlug]/`: the home page, `team/[teamId]` and its `board`, `issue/[issueId]`, `projects` and `projects/[projectId]`, `cycles` and `cycles/[cycleId]`, `search` and `settings` with `members`.
- Read the slug with `useParams<{ orgSlug: string }>()`.
- `components/shell/workspace-shell.tsx` makes sure the user and organization are synced before a workspace page renders.
- Sign-in, sign-up and onboarding live under `app/sign-in`, `app/sign-up` and `app/onboarding`.
- There is one workspace, pinned by `NEXT_PUBLIC_HX_WORKSPACE_ORG_ID` (read in `lib/workspace.ts`). Onboarding only routes members into it or explains how to get an invitation.

## Code standards

The owner set rules 1 to 7 on 2026-11-17.

1. **Reuse before you write.** Search for an existing validator, constant, helper or rule, and use it.
2. **One home per rule.** Define each rule or constant in one place. Docs link to it and do not restate it.
3. **Refuse bad input with a clear error, never a crash.** In Convex, validate with `v.*` validators.
4. **Follow a changed value to every consumer.**
5. **Keep code flat.** No nested ternaries. Do not change arguments in place.
6. **Prove it end to end before every push.**
7. **Report against this list.** Each hand-back says how the diff meets each rule.
8. **Follow the object-oriented design rules.** The owner set them on 2026-11-19.
   - **Small units with one job.** Keep each file, class and function small, with one reason to change. If one unit both fetches data and applies business logic, split it. `eslint.config.mjs` sets the size and complexity limits.
   - **Composition over inheritance.** Keep inheritance at most two levels deep. To reuse code, pass a dependency in through the constructor instead of subclassing.
   - **Interfaces for external services.** Code that uses a database, an API or the file system depends on an interface, not on a concrete client.
   - **Encapsulated state.** Keep instance fields private or protected. Change an object's state only through its own methods, never from outside it.
   - **Plan before coding.** Before you add or change a class, list its responsibilities and interfaces, or draw a short class diagram. Get the owner's approval before you write the code.

   The limits work like this:

   - `eslint-suppressions.json` holds, for each file and limit rule, the count of violations the code had when the limits were added. `pnpm lint` fails when a file's count for a rule goes above its listed count.
   - Never add to `eslint-suppressions.json`. Don't use `--suppress-all` or `--suppress-rule`, or an inline `eslint-disable` comment, for the limit rules in `eslint.config.mjs`. Fix the code instead.
   - **Known gap:** a listed file or function can grow, or a listed violation can be swapped for another of the same rule in the same file, without failing `pnpm lint`. The planned refactor PRs remove the listed violations.
   - The README's [Commands](README.md#commands) section says when and how to prune `eslint-suppressions.json`.

## HX operations

- Convex is self-hosted on HX-18 as `hx-convex`. The API is `http://192.168.50.218:3210`, HTTP actions are on port `3211`, and the data is in HX-9 PostgreSQL.
- Clerk is the development instance `intent-anemone-3074`, with the JWT template `convex`. The template adds the `org_id`, `org_slug` and `org_role` claims.
- Keys live in `~/.config/hx-citadel/*.env`. Never print them. Always source them with output suppressed.
- Never start Next on the literal `127.0.0.1`. Use `localhost` or the LAN address.
- pnpm is pinned by `packageManager` in `package.json`. Add no pnpm release-age exclusions.
- Demo data is dev-only. Seed an empty development workspace with `pnpm seed:demo '{"clerkOrgId":"…","clerkUserId":"…"}'` (`convex/seed.ts`). Never seed from the UI or from a build or deploy.

### Clear test data

- After a live gate, clear test data one team at a time with `admin:clearTeamContent` (`convex/admin.ts`), with `convex-admin.env` loaded: `npx convex run admin:clearTeamContent '{"clerkOrgId":"…","teamKey":"…"}'`. It deletes the whole team: every issue with the rows it owns, such as comments and decisions (`deleteIssuesWithOwnedRows` in `convex/lib/issueCleanup.ts`), every cycle, every saved view that opens the team, and then the team itself.
- Run `admin:clearTeamContent` only on a team that holds nothing but test data. If a team holds both test and real work, cancel the test stories one by one instead, in the app or through the Agent API. The live check's tidy-up cancels each of its stories, and the story's testing sub-task first, through the Agent API (`scripts/live-check/steps.ts`).
- A clear runs in pages (`PAGE_SIZE` in `convex/admin.ts`). Each run deletes one page, and every run except the last schedules the next one. The command prints only what its first run deleted, and the scheduled runs finish the clear. The runs delete in the order above and scan the saved views one page per run.
- Each scheduled run carries the team's id, not its key, and stops quietly if that team is gone. So a queued run never touches a new team that reuses the key. If a scheduled run fails, run the command again: it starts from the rows that are left, and its view scan starts again from the first view (`convex/admin.test.ts`, "a rerun after a scheduled run failed finishes the clear" and "a rerun after a scheduled run failed in the saved-view scan finishes the clear").
- A page limits the issues, the cycles and the saved views that one run reads. The rows those issues own have their own limit. A run stays within `CLEANUP_BUDGET`, sized to stay inside Convex's per-transaction limits (`convex/lib/issueCleanup.ts`). An issue that owns more than one budget loses a share of its rows in each run, and its own row goes only after the last of them, so a heavy issue clears over several runs. Relations are read and charged like the other owned rows.
- If you create the team again with the same key, `convex/teams.ts` starts the team's issue numbers again at `FIRST_ISSUE_NUMBER` (`convex/lib/rules/numbering.ts`). So an old key can name a new issue. Don't reuse an issue key or an [`If-Match`](docs/AGENT-API.md#send-the-three-headers) version you held from before the clear. Read the issue again.
- Never run `admin:clearOrgContent` once real work exists. It deletes the content of the whole workspace.
- Keep the `LCK` team. `pnpm live-check -- --team LCK` uses it (`docs/AGENT-API.md`). Clearing `LCK` deletes it, so create it again before the next check.
- Remove a mistyped or retired agent from the workspace with `npx convex run agentAdmin:removeAgent '{"clerkOrgId":"…","agentName":"…"}'`. It refuses while the agent is still an issue's assignee or a project's lead and names them, keeps the agent's user row so its comments and activity still show its name, and the agent's next successful write makes it a member again (`removeAgentMembership` and `ensureAgent` in `convex/lib/agents.ts`). A read, or a write that is refused, leaves it out.

## Verifying your work

Run the checks in the order the README's [Commands](README.md#commands) section lists them.

### Where tests and their helpers live

- A Convex test sits at `convex/` top level and is named after the module or the feature it tests. `convex/issues.test.ts` tests `convex/issues.ts`, and `convex/boardDrop.test.ts` tests board and backlog drops.
- A test of a `convex/lib` helper can sit next to the helper, as `convex/lib/mirror.test.ts` does. Zone 1 of `import/no-restricted-paths` in `eslint.config.mjs` limits what a `convex/lib` file can import from top-level `convex/`. A helper test that imports a top-level file that zone 1 forbids, such as `convex/workspace.fixture.ts`, sits at `convex/` top level, as `convex/idempotency.test.ts` does.
- These shared helper files hold test helpers for more than one test file:
  - `convex/workspace.fixture.ts`, the HX workspace that every new agent-API test takes;
  - `convex/lib/orgMember.fixture.ts`, the test organization and its one member (`insertOrgMember`, `MEMBER_IDENTITY`). Top-level and `convex/lib` tests both use it. It sits in `convex/lib` because zone 1 forbids a `convex/lib` test from importing a top-level fixture;
  - `convex/test-helpers.fixture.ts`, the helpers that top-level Convex tests share: the readers (`issueReaders`, `footprint`, `refusalOf`), the reader of a story's testing sub-task, the helper that passes a story's done gate (`passDoneGate`), the switch back to real timers after each test (`registerRealTimers`) and the `Test` type;
  - `lib/seeded-random.fixture.ts`, the seeded random generator for property tests;
  - `components/fake-local-store.ts`, a test double of Convex's `OptimisticLocalStore`.
- A helper that a second test file needs goes into a shared helper file that every test that uses it can import. Don't copy it.
- Under `convex/`, name a new shared helper file `<name>.fixture.ts`, so Convex doesn't deploy it as a function module.
- `convex/teams.test.ts` keeps its own admin identity, and `convex/revert.test.ts` keeps its own seed rows. Other tests still copy the organization and member setup, such as `convex/lib/customFunctions.test.ts`, `convex/issueVersion.test.ts` and `components/views/filters.test.ts`. Moving those copies into a shared helper file is a known follow-up. `components/views/filters.test.ts` can't use `convex/lib/orgMember.fixture.ts`, because zone 2 of `import/no-restricted-paths` in `eslint.config.mjs` forbids a `components/` file from importing `convex/lib`. Moving its copy needs a fixture outside `convex/lib`.

## Reference

- Design doc: `docs/specs/2026-06-12-linear-clone-design.md`.
