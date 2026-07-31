# Enterprise Groups — Session Handoff

Handoff for an agent continuing the **UX and design** work on the Enterprise
organization Groups feature. This captures what exists, why it is shaped the way
it is, and where to pick up. It is intentionally general — treat the code as the
source of truth and re-read the referenced files before changing them.

## TL;DR

- Branch: `feature/groups`. Open PR: **#4891** (`Kilo-Org/cloud`, base `main`).
- The feature (Enterprise-only member groups with composable, discriminated
  policies) is implemented end to end: DB schema + migration, domain layer,
  tRPC API, gateway/catalog enforcement, and a `DrawerStack`-based management
  UI. The first (and currently only) policy type is **model access**.
- Two prior work streams are done: the initial feature build, and a first UX
  polish pass (stacked drawers, density, direct "Add policy" flow).
- The most recent work resolved all 18 PR review threads (structure, hot-path
  performance, correctness, and a few UI robustness fixes). All threads are
  replied to and resolved.
- **Remaining work is primarily UX/design refinement**, not backend. See
  "Where to pick up".

## Product model (the mental model to hold)

- **Groups** are Enterprise-only, organization-local, flat (no nesting), and
  many-to-many with direct organization members.
- **Policies** are strict, Zod-discriminated variants stored as a
  `policies: OrganizationGroupPolicy[]` collection on each group, plus an
  organization-level set of **default policies** applied to every direct member.
- A group's effective access = organization ceiling ∩ (default policies +
  the member's group policies), combined additively for allow-list grants.
- **Model access** is the first policy type. Modes: `all`, `none`, `selected`
  (explicit model + provider allow-lists). Selection is an *additive grant* on
  top of the organization's existing restrictions (which remain a hard ceiling).
- Visibility/roles: **owners** manage groups and policies; **billing managers**
  have read-only visibility; ordinary **members** see only their own group
  names. Direct BYOK and custom LLMs stay organization-wide and are exempt from
  these restrictions.
- Model-access policies are always evaluated for Enterprise organizations. If no
  default or assigned group policy applies, organization-wide access is preserved.

Business-rule context, if needed, lives in `.plans/groups.md` (the original
product + implementation contract). It is long; skim it only when you need the
"why" behind a rule.

## Architecture: how policies are layered

Policies are deliberately split by runtime boundary so a new policy type
requires an explicit entry in each exhaustive registry (keyed by
`OrganizationGroupPolicyType`):

- **Persisted shape (DB):** `packages/db/src/schema-types.ts` owns only the
  structural `jsonb` column types (`OrganizationGroupPolicy`,
  `OrganizationGroupPolicies`, `OrganizationGroupPolicyType`,
  `OrganizationGroupModelAccessPolicy`). The DB package intentionally holds *no*
  runtime policy logic.
- **Runtime contracts (web):**
  `apps/web/src/lib/organizations/group-policies/organization-group-policies.ts`
  is the barrel that exports the Zod schemas, limits, defaults, `OrganizationGroupInputSchema`,
  and helpers, and re-exports the DB shape types so app code has a single import
  site. Per-policy schema lives in
  `group-policies/model-access/model-access.schema.ts` and asserts structural
  compatibility with the DB type.
- **Server behavior (web):** `group-policies/model-access/model-access.server.ts`
  holds normalization, the effective-policy evaluator, the per-model decision
  function, and the editor-data loader. `group-policies/registry.server.ts` is
  the exhaustive server registry. `effective-model-access.server.ts` re-exports
  the model-access server module (compat facade for existing importers).
- **Client behavior (web):** under
  `apps/web/src/components/organizations/groups/policies/`. `registry.client.ts`
  is the exhaustive client registry; each policy provides a
  `<policy>.definition.client.tsx` with `label`, `description`, `summarize`,
  `createInitialPolicy`, a `ListItem`, and an `Editor`.

Convention for a **new policy type**: add its DB shape variant, an app schema
module, server normalize/evaluate entry in the server registry, and a client
definition in the client registry. TypeScript's exhaustiveness will flag every
place you missed.

## Key files (UI-focused)

Page + drawers:
- `components/organizations/groups/OrganizationGroupsPage.tsx` — the page:
  header, "Group policies" card (default policies + "Manage defaults"), group list,
  create button, and delete flow.
- `components/organizations/groups/drawer/OrganizationGroupsDrawerStack.tsx` —
  feature-owned `createDrawerStack<OrganizationGroupsDrawerRef>()` wrapper.
- `.../drawer/types.ts` — the `OrganizationGroupsDrawerRef` discriminated union
  (`group-details` | `policy-list` | `policy-type-picker` | `policy-editor`).
- `.../drawer/renderOrganizationGroupsDrawerContent.tsx` — render dispatch;
  contributes each drawer's header.
- `.../drawer/GroupDetailsPanel.tsx` — create/edit group: name, description,
  inline **policy collection** (rows navigate straight to the editor; "Add
  policy" jumps straight to the type picker), and members.
- `.../drawer/GroupPoliciesPanel.tsx` — standalone policy list (used for the
  organization **default** policies target from the page).
- `.../drawer/PolicyTypePickerPanel.tsx` — "Add policy" type chooser.
- `.../drawer/PolicyEditorPanel.tsx` — resolves the concrete policy + editor
  from the client registry and owns save/error handling.

Model-access policy UI:
- `policies/model-access/ModelAccessPolicyEditor.tsx` — mode select + reuse of
  the existing org model/provider selector (`ModelsTab`/`ProvidersTab`) with
  group-specific "grant" semantics/copy; loads catalog + org ceiling via the
  `organizations.groups.getPolicyEditorData` tRPC query.
- `policies/model-access/ModelAccessPolicyListItem.tsx` — list summary.
- `policies/model-access/model-access.definition.client.tsx` — registry entry.

Shared drawer primitive:
- `components/drawer/DrawerStack.tsx` — generic stacked-drawer primitive
  (backdrop, layered panels, back/close, focus handling, `push`/`replace`/`pop`/
  `open`/`closeAll`). Shared across features; change with care.

Reused selector (do not duplicate):
- `components/organizations/providers-and-models/{ModelsTab,ProvidersTab}.tsx`
  now take a `scope` prop (`organization` | `group`) that switches copy between
  deny/enable wording and positive "grant/selected" wording. There are also
  `unavailableReason` affordances for rows outside the org ceiling.

Design system:
- Root `DESIGN.md` is the canonical token/typography/spacing/radius contract.
- Load the `kilo-design` skill for any visual work; it points at `DESIGN.md`
  and concern-specific references. Product UI is dark-first, compact, one
  primary CTA per surface, Radix/shadcn primitives.

## Drawer UX flow (as implemented)

1. Group list row (whole row clickable, `cursor-pointer`, hover-revealed delete)
   → opens `group-details` (edit).
2. In group details, "Add policy" pushes `policy-type-picker` directly (single
   hop). Picking a type `replace`s it with `policy-editor`, so Back returns to
   the group.
3. Existing policy rows in group details navigate directly to `policy-editor`.
4. Organization defaults use the same picker/editor via the `policy-list`
   drawer opened from the page's "Manage defaults".
5. Create flow: entering a name and pressing "Add policy" persists the group
   first, then continues into the type picker.

Density/interaction decisions already made (keep consistent): compact `p-5`
drawer padding, eyebrow-style `POLICIES`/`MEMBERS` section labels, member
"N selected" count, hover/focus-revealed destructive actions, and `cursor-pointer`
on all custom clickable rows (bare `<button>`/`<label>` do not inherit it).

## Enforcement surfaces (so UI changes stay consistent with reality)

The effective model-access policy is enforced in the gateway and reflected in
catalogs, so the UI should always agree with runtime behavior:

- Main gateway: `app/api/openrouter/[...path]/route.ts` (group policy context is
  started right after auth and consumed at routing time).
- Catalog endpoints filter to the caller's own effective access:
  `app/api/openrouter/models-by-provider/route.ts`, `models/route.ts`,
  `app/api/gateway/{embedding,transcription}-models/route.ts`.
- Org defaults endpoint: `app/api/organizations/[id]/defaults/route.ts`
  (`defaultFreeModel` is `string | null`; `null` means no free model permitted —
  clients must not fall back to a paid default).
- Integration default-model updates: `lib/integrations/{discord,slack,linear,github-apps}-service.ts`
  via `isOrganizationModelUpdateAllowed`.
- The **policy editor** deliberately uses a dedicated
  `organizations.groups.getPolicyEditorData` query (full catalog + org ceiling),
  separate from the member-filtered catalog endpoints.

## tRPC surface

Router: `apps/web/src/routers/organizations/organization-groups-router.ts`
(`organizations.groups.*`). Notable procedures: `list`, `get`, `create`,
`updateMetadata`, `updateDetails`, `setPolicy`, `removePolicy`, `setMembers`,
`setMemberGroups`, `delete`, `getPolicySettings`, `getPolicyEditorData`,
`setDefaultPolicy`, `removeDefaultPolicy`. All owner mutations are subscription/trial
gated; `get`, `getPolicySettings`, and `getPolicyEditorData` allow billing managers
(read).

## Data model

Tables in `packages/db/src/schema.ts`: `organization_groups`,
`organization_group_memberships`, `organization_group_policy_settings`.
Migration `packages/db/src/migrations/0200_slow_scourge.sql` (generated; do not
hand-edit generated SQL/snapshots/journal — change `schema.ts` and regenerate).
A unique constraint enforces case/whitespace-insensitive group names per org.

## Conventions & guardrails to respect

- Follow the nearest `AGENTS.md`. Notably `apps/web/AGENTS.md` (use the
  `kilo-design` skill for `.tsx`/`.css`; use tRPC + React Query for client
  server state), `packages/db/AGENTS.md` (schema-first migrations; don't edit
  generated artifacts), and `apps/web/src/lib/ai-gateway/AGENTS.md` (direct BYOK
  / custom LLMs are exempt from org model/provider restrictions).
- Reuse the shared `DrawerStack` and `ModelsTab`/`ProvidersTab` rather than
  cloning. If you extend the selector, drive copy off the `scope` prop.
- Keep the exhaustive registries authoritative; don't special-case
  `model_access` in generic drawer/render code.
- Direct BYOK and custom LLM access remain organization-wide in v1.

## Verification workflow

- `pnpm --filter web typecheck` and `pnpm --filter @kilocode/db typecheck`.
- `pnpm --filter web lint` and `pnpm --filter @kilocode/db lint`.
- Format with `oxfmt` (repo formatter); `pnpm format:check` and
  `git diff --check` before committing.
- Focused tests live next to the code: `organization-groups.test.ts`,
  `effective-model-access.server.test.ts`, integration service `*.test.ts`,
  and the openrouter route tests. Run with the web jest runner
  (`pnpm --filter web test -- --runTestsByPath <paths> --runInBand`).
- Note: `packages/db/src/schema-types.test.ts` is executed by the web jest
  config's testMatch (it globs the db package too), but invoking that single
  file by path from the `apps/web` cwd is finicky — prefer the root test run in
  CI to exercise it.
- Local browser testing: load the `local-development` skill for service status,
  ports, and fake-user login. The Groups page lives at
  `/organizations/:id/groups` and requires an Enterprise org + owner/fake-admin.
  The model/provider catalog must be synced for the editor to show models.

## Where to pick up (UX/design)

The backend and data contracts are stable. Focus on refining the Groups UX and
visual design against `DESIGN.md` and the `kilo-design` skill. Good candidates
to evaluate (verify current state in the browser first; some may already be
partially addressed):

- Overall visual polish and hierarchy of the Groups page and each drawer against
  the token contract (surfaces, borders, spacing rhythm, typography roles).
- Empty states, loading skeletons, and error copy across the drawers.
- The model-access editor: selection ergonomics at catalog scale (search,
  filters, "selected only", provider/data-policy filters), and how out-of-ceiling
  ("unavailable") rows are communicated.
- Responsive behavior (test ~375px, ~768–1024px, ~1440px) and touch targets.
- Keyboard/focus/screen-reader behavior for the stacked drawers and dialogs.
- Copy/voice consistency (Kilo voice: concrete verbs, sentence case,
  action-named buttons).
- Default-policies presentation on the page vs. the group editor.

Before editing UI: load `kilo-design`, read `DESIGN.md`, and open the specific
component. When done, run typecheck/lint/format, browser-test the affected
flows, and keep changes consistent with the density/interaction decisions above.

## Git / PR workflow notes

- Push target is `origin` (`Kilo-Org/cloud`); PR #4891 is open against `main`.
- Only commit/push when asked. Prefer small, compiling commits. When addressing
  a Kilobot review remark: verify it, fix + commit, reply in the thread, then
  **resolve the thread** (not just the base comment), and push.
