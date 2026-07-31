# Organization Groups and Model Access

## Status

Approved implementation proposal, created 2026-07-29.

This document describes the approved product contract and implementation plan. It is
not yet a normative business-rule spec.

## Goal

Add **groups** to Teams and Enterprise organizations. A group is an
organization-local, flat tag that can contain many members, and a member can belong
to many groups. Organization managers can use groups to grant different sets of
models and providers to different members without creating sub-organizations.

Examples:

- `Engineering` can use all organization-approved coding models.
- `Support` can use a small set of lower-cost models.
- `AI research` can use models offered by selected preview providers.
- One member can belong to both `Engineering` and `AI research` and receive the
  combined access of both groups.

## Product Decisions

The recommended v1 contract is:

1. Groups belong to exactly one organization and cannot be nested.
2. Group membership is many-to-many. A direct organization member may belong to
   zero or more groups in that organization.
3. Groups do not create billing, ownership, role, SSO, data, or credit boundaries.
4. Organization roles continue to control administration. Groups do not grant
   `owner`, `billing_manager`, or any other administrative role.
5. Groups and group-based model access are available only to Enterprise
   organizations, matching the current Enterprise-only model/provider policy.
6. Enterprise group policies are evaluated whenever they are configured. If no
   default or assigned group has a `model_access` policy, the member keeps the current
   organization-wide model access behavior.
7. Every member receives the organization's default `model_access` policy plus the
   union of model access granted by all of their groups.
8. Existing organization-wide model/provider restrictions are a hard ceiling. Group
   policy can narrow or grant within that ceiling, but cannot override an
   organization-denied model or provider.
9. Model/provider access is enforced on the server at request time. Catalog filtering
   is a usability feature, not the authorization boundary.
10. Membership and policy changes apply to subsequent requests. Existing API tokens
    do not need to be rotated because effective policy is loaded from authoritative
    primary-database state at the authorization boundary, not from token claims,
    read replicas, or process-local caches.
11. Group assignment does not affect seat counting. A user consumes at most one seat
    through organization membership regardless of their number of groups.
12. Group names are unique within an organization using PostgreSQL
    `lower(btrim(name))` comparison. The database expression is authoritative; the
    application must not persist a separately computed normalization.
13. An Enterprise to Teams downgrade suspends enforcement but preserves policies. A
    later Enterprise upgrade reactivates the saved configuration, matching existing
    Enterprise model-policy behavior. The Groups UI and API remain unavailable while
    the organization is on Teams.
14. A group stores a collection of independently discriminated policies. V1 supports
    `model_access`; adding a future policy type must not require changing the group or
    group-membership table shape.

## Terminology

- **Organization group**: A flat, organization-owned member tag. Use the full term in
  backend names where `group` would be ambiguous.
- **Group member**: A direct organization member assigned to an organization group.
- **Organization ceiling**: The existing effective Enterprise
  `provider_allow_list` and `model_deny_list`.
- **Group policy**: One strict discriminated-union member in an organization group's
  `policies` collection.
- **Model access policy**: The `GroupPolicy` variant with `type = 'model_access'`.
  Its `data` grants all models, no models, selected model IDs, and/or models available
  through selected providers.
- **Default member policy**: A policy applied to every direct member before policies
  from their groups are merged.
- **Effective member policy**: The organization ceiling intersected with the union of
  the default model access policy and model access policies from the member's groups.

The existing `OrganizationModeConfig.groups` field is unrelated. It identifies CLI
tool permission categories such as `read`, `edit`, and `command` and must not be
reused for organization groups.

## Groups Versus Sub-Organizations

Sub-organizations and groups solve different problems and should remain separate.

| Concern | Sub-organization | Group |
|---|---|---|
| Identity | Independent organization | Tag inside one organization |
| Shape | Root plus direct children | Flat, no nesting |
| Membership | Separate organization membership | Assignment of an existing direct member |
| Roles | Independent roles and owners | No roles |
| Billing and credits | Independent organization data, with parent workflows | Uses the containing organization |
| SSO | May inherit direct parent policy | Uses the containing organization's policy |
| Product data | Isolated | Shared with the containing organization |
| Model access | Organization-wide policy | Per-member grants within organization policy |
| Seat use | Determined by organization membership | No additional seats |

Parent organization owners and billing managers currently receive some effective
administrative access to direct children without child membership. They may manage a
child's groups when the corresponding organization authorization procedure allows
it, but they are not group members and do not receive a child group policy unless
they also have a direct child membership. This preserves the membership isolation
required by `.specs/organization-sso.md`.

## Access Policy

### Policy Shape

Each group stores an array of policies. Every policy is a member of one centrally
owned, Zod-backed discriminated union. Model access is the first policy type, not a
special-purpose field on the group:

```ts
const ModelAccessPolicyDataSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('all') }).strict(),
  z.object({ mode: z.literal('none') }).strict(),
  z
    .object({
      mode: z.literal('selected'),
      model_allow_list: z.array(z.string()),
      provider_allow_list: z.array(z.string()),
    })
    .strict(),
]);

const GroupPolicySchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('model_access'),
      data: ModelAccessPolicyDataSchema,
    })
    .strict(),
  // Add future policy variants here.
]);

const GroupPoliciesSchema = z
  .array(GroupPolicySchema)
  .max(MAX_POLICIES_PER_GROUP)
  .superRefine(rejectDuplicatePolicyTypes);

const OrganizationGroupInputSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().max(500).nullable().optional(),
    policies: GroupPoliciesSchema,
  })
  .strict();

type GroupPolicy = z.infer<typeof GroupPolicySchema>;
type OrganizationGroupInput = z.infer<typeof OrganizationGroupInputSchema>;
```

The schema registry is the source of truth for persisted data, API inputs, and
inferred TypeScript types. Do not maintain a parallel handwritten `GroupPolicy`
union. Each group and default-member configuration may contain at most one policy of
each `type`; duplicate discriminators are invalid rather than order-dependent.

For `model_access`, the explicit data mode avoids ambiguous empty arrays:

- `all` grants the full catalog permitted by the organization ceiling.
- `none` grants nothing by itself. This is also the default for a newly created
  group, making ordinary tagging safe.
- `selected` grants a model when its normalized model ID is listed, or when at least
  one of its available providers is listed.

A group with no `model_access` policy contributes no model grant. Keeping absence
distinct in storage allows a group to contain only unrelated future policies without
synthetic model-access data. If no default or assigned group has a `model_access`
policy, the member retains unrestricted access within the organization ceiling.
Granting no models requires an explicit policy with mode `none`; absence of
configuration must not introduce a restriction. The behavior-preserving `all` default
is still created canonically for existing organizations.

An explicitly granted model may route through any provider still permitted by the
organization ceiling. A provider grant makes models available only through that
provider. This distinction makes routing model-dependent rather than reducible to one
global member provider list.

Adding a future policy requires adding a new strict variant to `GroupPolicySchema`, a
type-specific merge/evaluation function, authorization rules, limits, audit
serialization, tests, and UI. Unknown policy types and malformed known policies fail
closed. During a rolling deployment, readers that recognize a new discriminator must
be deployed before any writer can persist it.

### Effective Policy Algorithm

For an `organizationId` and trusted policy subject:

1. For a `member` subject, validate current direct organization membership from the
   primary database. For trusted `defaultAccess`, do not load group assignments. Load
   the organization, plan, group policy settings, and applicable policies as one
   consistent authorization-boundary read. Reject a missing or soft-deleted
   organization before balance, policy, BYOK, or routing resolution.
2. Do not use a read replica or cached value for membership, soft-delete, plan, group
   assignment, or policy decisions. Non-authoritative provider/catalog metadata may
   retain its existing cache, but authorization state must come from the primary on
   every request.
3. Resolve the organization ceiling with the existing Enterprise rules.
4. If the organization is not Enterprise, return the current organization-wide model
   policy unchanged.
5. Select the default `model_access` policy. For a `member` subject, also select the
   `model_access` policy, when present, from every group assigned to that member.
   `defaultAccess` receives no group policies.
6. Merge only the selected policies' `data`. If any has `mode = 'all'`, the combined
   model grant is all organization-permitted models. Otherwise union every normalized
   model ID and provider slug from `selected` data. `none` and an absent group-level
   `model_access` policy contribute nothing.
7. Intersect each requested model and route with the organization ceiling:
   - an organization-denied model remains denied;
   - `all` allows any route permitted by the organization ceiling;
   - an explicitly listed model allows any of that model's routes permitted by the
     organization ceiling;
   - a model admitted only through a provider grant may route only through providers
     present in both the member's provider grants and the organization ceiling;
   - a group cannot restore a model that has no remaining eligible route.
8. Apply organization-wide data-collection policy independently. Groups do not
   override it.
9. After Auto or Organization Auto resolves to a concrete model, check the concrete
   model against the same effective policy before sending the upstream request.

Model access is additive across groups. There is no group-level model deny list in
v1. Combining allow and deny rules across many groups is difficult for administrators
to reason about, and a deny in one group unexpectedly overriding a grant in another
would make membership composition unsafe. The organization-level deny list remains
the final deny mechanism.

Provider metadata must fail closed for provider-derived grants: if the system cannot
prove that a model is offered by a granted provider, that provider grant does not
admit the model. An explicit model grant may still admit that exact normalized model
ID when provider metadata is unavailable, but runtime routing must remain within the
organization ceiling. `all` preserves the current organization-wide metadata
behavior.

### Examples

Assume the organization ceiling allows providers `anthropic` and `openai`, and
denies `openai/o3`.

| Default access | Group memberships | Effective result |
|---|---|---|
| `all` | None | All organization-permitted models |
| `none` | `Support` grants `openai/gpt-4.1-mini` | Only that model |
| `none` | `Engineering` grants provider `anthropic` | Organization-permitted models available through Anthropic |
| `none` | `Engineering` grants `anthropic`; `Research` grants `openai/o3` | Anthropic models; `openai/o3` remains denied by the organization |
| Selected low-cost models | `Research` grants provider `openai` | Union of the defaults and OpenAI models, excluding `openai/o3` |

### Defaults and Empty Access

The organization default model and Organization Auto routes remain
organization-owned settings. When serving a member:

1. Use the configured organization default only if it is permitted by that member's
   effective policy.
2. Otherwise fall back to the first current global default/catalog model allowed for
   that member.
3. Validate both `defaultModel` and `defaultFreeModel` against member-effective
   policy. A free model is not an access-control bypass, including after its Auto
   route resolves to a concrete model.
4. If no model is allowed, return the existing no-available-models response and show
   a clear UI empty state directing the member to an organization owner.

### BYOK, Custom LLMs, and Experiments

The current AI Gateway intentionally exempts direct BYOK models and custom LLMs from
organization model/provider restrictions after explicit administrator enablement.
V1 should preserve that invariant:

- Ordinary catalog models routed through organization BYOK remain subject to group
  access.
- Direct BYOK model IDs remain organization-wide once enabled.
- Custom LLMs remain organization-wide once assigned to the organization.
- Experimental models remain unavailable to Enterprise organizations under current
  behavior.

The groups UI must label direct BYOK and custom LLM access as organization-wide and
not imply that a group can restrict it. Making those resources group-scoped is a
separate feature because it changes the explicit-admin authorization boundary in
`apps/web/src/lib/ai-gateway/AGENTS.md`.

## Data Model

Use dedicated normalized tables rather than `organizations.parent_organization_id`
or the `organizations.settings` JSON object.

### `organization_groups`

Suggested fields:

- `id uuid` primary key
- `organization_id uuid` not null
- `name text` not null
- `description text` nullable
- `policies jsonb` not null, default `[]`
- `created_by_kilo_user_id text` nullable
- `created_at timestamptz` not null
- `updated_at timestamptz` not null

Constraints and indexes:

- foreign key `organization_id -> organizations.id` with `ON DELETE CASCADE`
- unique `(organization_id, id)` to support composite references
- unique expression index `(organization_id, lower(btrim(name)))`
- check that trimmed `name` is nonempty and at most 80 characters
- check that `description` is at most 500 characters
- index `organization_id`

Parse `policies` through `GroupPoliciesSchema` at every read/write boundary. Normalize
and deduplicate model IDs and provider slugs inside the `model_access` variant before
persistence. Limit an organization to 100 groups, each group to 20 policy variants,
and each selected model-access policy to 500 model IDs and 500 provider slugs.
Malformed, unknown, or duplicate persisted policies must fail closed, emit an
operational alert without sensitive data, and never fall back to unrestricted access.

Store the trimmed display name, but let PostgreSQL enforce canonical uniqueness with
the exact `lower(btrim(name))` expression under the database's configured collation.
Use the same SQL expression for case-insensitive search rather than duplicating it in
JavaScript. Add migration tests for whitespace, ASCII case, and representative
non-ASCII case behavior so a collation change cannot silently alter the contract.

### `organization_group_memberships`

Suggested fields:

- `organization_id uuid` not null
- `group_id uuid` not null
- `kilo_user_id text` not null
- `assigned_by_kilo_user_id text` nullable
- `created_at timestamptz` not null

Constraints and indexes:

- composite primary key or unique key `(organization_id, group_id, kilo_user_id)`
- composite foreign key `(organization_id, group_id) ->
  organization_groups(organization_id, id)` with `ON DELETE CASCADE`
- composite foreign key `(organization_id, kilo_user_id) ->
  organization_memberships(organization_id, kilo_user_id)` with `ON DELETE CASCADE`
- index `(organization_id, kilo_user_id)` for request-time policy resolution

The composite references make cross-organization assignments impossible at the
database layer and ensure group assignments disappear when either the group or the
direct organization membership is removed.

The existing membership table's unique `(organization_id, kilo_user_id)` key can be
the target of the new composite foreign key. The group-membership foreign key must
ship with `ON DELETE CASCADE`; application-only cleanup is not sufficient. If adding
or validating the constraint is operationally risky, use a staged generated
migration rather than weakening the invariant.

### `organization_group_policy_settings`

Suggested fields:

- `organization_id uuid` primary key and foreign key to `organizations.id` with
  `ON DELETE CASCADE`
- `default_policies jsonb` not null, default
  `[{ "type": "model_access", "data": { "mode": "all" } }]`
- `policy_revision integer` not null, default `1`
- `updated_by_kilo_user_id text` nullable
- `created_at timestamptz` not null
- `updated_at timestamptz` not null

`default_policies` uses the same `GroupPoliciesSchema` and one-policy-per-type
invariant as groups. Defaulting to a `model_access: all` policy makes the migration
behavior-preserving. Policies survive an Enterprise to Teams downgrade, matching the
existing persistence behavior for Enterprise-only settings.

Every group policy, default policy, assignment, organization ceiling, or plan mutation
must acquire one stable organization-scoped PostgreSQL advisory
transaction lock, upsert the settings row, and increment `policy_revision` in the
same transaction. The advisory lock remains available even when the settings row does
not yet exist.

Existing organizations do not need a backfill. A missing settings row has canonical
read semantics `default_policies = [{ type: 'model_access', data: { mode: 'all' } }]`
and `policy_revision = 0`. The first policy-relevant mutation atomically inserts the
row under the organization advisory lock before applying the mutation and incrementing
the revision.

### Invitations

Do not assign pending invitations to groups in v1. Group membership must reference a
current direct organization membership, and administrators can assign groups after
the invitation is accepted. Preassignment can be added later with a separate
invitation/group join table and an atomic transfer during invitation acceptance; it
must not use email as durable membership identity.

## Authorization

- Read group names and one's own assignments: any effective organization member.
- List all group members and access policies: owner and billing manager.
- Create, rename, update policies, assign members, or delete: owner only in v1. A
  future policy variant may define stricter authorization but may not weaken this
  baseline without an explicit product decision.
- Kilo platform admins retain existing audited owner-equivalent access.
- Parent owners may administer direct child groups through existing effective-owner
  authorization, but only direct child members can be assigned.
- Billing managers do not receive model access solely from their role. If they are a
  direct member, the same default/group policy applies to their model requests.

All writes must verify organization ownership for every referenced group and member
inside the transaction. Group policy and membership changes should write sanitized
organization audit-log entries with IDs/names and before/after summaries, never
credentials or request content.

## Backend Design

### Shared Resolver

Separate loading/validation of the generic policy collection from type-specific
evaluation. Introduce one server-only context resolver with an explicit policy
subject, then pass its parsed policies to the model-access evaluator:

```ts
type OrganizationPolicySubject =
  | { type: 'member'; kiloUserId: string }
  | { type: 'defaultAccess' };

const context = await getOrganizationGroupPolicyContext({
  organizationId,
  subject,
  tx,
});

const modelPolicy = evaluateEffectiveModelAccessPolicy(context);
```

The public gateway accepts only `member` subjects derived from its authenticated user
and continues to require direct membership. `defaultAccess` is available only to
trusted server-side automation entry points that have no acting identity; it cannot
be selected by a request header, token claim, or client input.

The generic context contains parsed `defaultPolicies`, parsed member-group policy
collections, plan, organization ceiling inputs, and `policyRevision`. Future
evaluators reuse this context instead of changing the group query or persistence
model.

The model evaluator returns a canonical object suitable for both catalog filtering
and gateway routing:

```ts
type EffectiveOrganizationModelPolicy = {
  organizationModelDenyList: string[];
  organizationProviderCeiling?: string[];
  memberGrant:
    | { mode: 'unrestricted' }
    | {
        mode: 'selected';
        modelAllowList: string[];
        providerAllowList: string[];
      };
  dataCollection?: 'allow' | 'deny' | null;
  policyRevision: number;
};
```

The model evaluator must expose a model-aware predicate that returns both admission and the
eligible provider routes for that model. A flat intersection of the two provider
lists is incorrect because an explicit model grant may use any route within the
organization ceiling, while a provider-derived grant may use only its granted
providers.

The model evaluator should replace organization-only calls to
`getEffectiveModelRestrictions` where an acting user exists. Avoid embedding policy
in tokens or any cache. Membership, soft-delete, plan, group assignment, and policy
state must be loaded from the primary database for every authorization decision.

### tRPC Surface

Add an `organizations.groups` router with narrow procedures:

- `list`: groups with member counts; include access summaries only for managers
- `get`: one group and its direct member assignments
- `create`: metadata plus an optional validated initial `policies` array
- `updateMetadata`: name and description only
- `setPolicy`: upsert one validated `GroupPolicy` by its discriminator
- `removePolicy`: remove one known policy type without changing other variants
- `delete`
- `setMembers`: replace assignments transactionally
- `setMemberGroups`: replace one direct member's assignments transactionally
- `getPolicySettings`
- `setDefaultPolicy`: upsert one validated default policy by its discriminator
- `removeDefaultPolicy`: remove one known default policy type when that policy's
  evaluator defines safe missing-default semantics

Do not expose generic whole-array replacement for updates. Type-targeted mutations
must preserve unrelated variants so adding a future policy cannot cause an older UI
to erase it while editing `model_access`.

Prefer set-based replace operations over one request per checkbox. Use conflict-safe
inserts and delete only assignments in the submitted organization/group scope. Cap a
single assignment mutation at 1,000 member/group pairs.

The existing `organizations.withMembers` response can include compact group IDs and
names for member badges, but full policy configuration should remain in the groups
router to avoid making the dashboard query large and permission-dependent.

### Catalog and Defaults

Change organization model reads from organization-only to member-effective:

- `getAvailableModelsForOrganization(organizationId, kiloUserId)`
- `organizations.settings.listAvailableModels` passes `ctx.user.id`
- `/api/organizations/[id]/models` uses the authenticated user
- `/api/organizations/[id]/defaults` resolves and validates the member-effective
  fallback
- model preferences must not return a favorite or last-selected model that is no
  longer available to the member
- `/api/openrouter/models` and its `/api/gateway/models` and versioned aliases use the
  authenticated organization member's effective policy
- organization-aware `models-by-provider`, embedding-model, and transcription-model
  catalogs and aliases use the same policy; if an endpoint intentionally exposes
  global metadata, document that it is non-authoritative and cannot imply access

Catalog output and server enforcement must use the same allow predicate and provider
metadata lookup to avoid contradictory UI and runtime results.

### AI Gateway Enforcement

The gateway is the security boundary. For every organization request:

1. Resolve the organization from the authenticated bearer token and
   `X-KiloCode-OrganizationId` using the existing direct-membership validation.
2. Resolve the effective member policy using the authenticated `user.id`; never
   accept group IDs or policy claims from request headers.
3. Resolve Auto/Organization Auto to the concrete model.
4. Reject a model outside the member's effective policy with the current not-allowed
   response, without revealing policies from another organization.
5. Apply the model-aware eligible provider routes after every provider
   transformation and before upstream selection.
6. Apply the same check to chat/messages/responses, FIM, edit, embeddings, and audio
   transcription routes.
7. Preserve the documented direct BYOK/custom LLM bypass for v1.

`checkOrganizationModelRestrictions` currently accepts only organization settings and
plan. Refactor it to accept the already-resolved canonical effective policy so every
route cannot independently reimplement group merging.

The Vercel BYOK transformation currently replaces/deletes an existing OpenRouter
provider configuration. Before groups ship, provider selection must explicitly
intersect compatible BYOK providers with the model-aware eligible routes; otherwise
BYOK can route around both organization and group provider policy.

### Integrations and Service Accounts

Slack, Discord, Linear, GitHub, bots, and other organization automations need an
explicit actor policy:

- If a request is initiated by a current direct human member, use that member's
  effective policy.
- If an automation uses a direct bot/service-account organization membership, allow
  that identity to be assigned to groups through an explicit bot path and use its
  effective policy.
- If no acting membership identity exists, use only default policies. Never silently
  union every group or use an owner's access. This uses the resolver's
  trusted-server-only `defaultAccess` subject and is never valid at a public gateway
  boundary.

Inventory all organization model entry points before enabling enforcement. A service
that cannot supply an actor must have documented default-access semantics rather than
continuing to call the organization-only resolver accidentally.

The implementation inventory must include an actor matrix for Slack, Discord,
Linear, GitHub Apps, Kilo Bot, Code Reviewer/background jobs, model selection,
default resolution, webhook execution, and gateway token creation. Each row must name
the exact policy subject (`human membership`, `bot membership`, or `default access`)
at configuration time and execution time; those identities must agree or the action
must fail closed.

## User Experience

### Navigation and List

Add **Groups** under the organization sidebar's Account section near Model Access.
The groups page should show:

- group name and optional description
- member count
- access summary such as `All models`, `No model access`, `3 models`, or
  `2 providers`
- search by group name or member
- a primary `Create group` action for owners

Groups should also appear as compact badges on organization member rows. Reuse the
existing child-team assignment popover interaction for editing one member's groups,
but label it **Groups** to avoid conflating groups and child teams.

### Group Detail

An owner can edit:

- name and description
- member assignments with searchable checkboxes
- a Model access policy section with mode: all, none, or selected
- selected models and providers using the current Model Access search/table patterns

The UI edits typed policy sections rather than exposing raw JSON. Future policy
variants add their own section keyed by the discriminator and preserve unrelated
policy objects when one section is saved.

Billing managers receive a read-only view. Ordinary members can see their own group
names and effective model access but not the complete membership roster or policy
configuration.

## Lifecycle Rules

- Removing a direct organization membership removes all of that member's group
  assignments in the same transaction or through database cascade.
- Deleting a group removes its assignments but never removes organization members.
- Deleting a group immediately removes its model access contribution from affected
  members. Future policy evaluators define their own deletion effects.
- Renaming a group does not affect policy evaluation because assignments reference
  the immutable group ID.
- Soft-deleted organizations are rejected at the organization authorization boundary;
  they must not fall back to organization-wide or unrestricted policy.
- Downgrading Enterprise to Teams logically disables `model_access` enforcement but
  preserves rows. Future policy types define their plan gating independently.
- Upgrading back to Enterprise automatically restores the saved `model_access`
  policies.
- Group changes do not alter seats, credits, usage ownership, or per-user daily
  limits.

## Release Plan

Ship groups as one normal product release without a feature flag, restricted audience,
shadow mode, announcement campaign, or staged general-availability process.

The release includes:

- the three tables, generated PostgreSQL migration, and shared discriminated policy
  schemas
- groups CRUD, assignments, organization audit logs, and member badges
- the Groups UI with default and per-group `model_access` policies
- the effective-policy resolver threaded through catalogs, defaults, gateway routes,
  and integrations
- server-side enforcement on every gateway surface
- the Vercel BYOK provider-policy intersection fix
- the complete database, policy, authorization, gateway, and UI test coverage below

The migration remains behavior-preserving: every organization starts with a default
`model_access: all` policy, so deploying the schema does not restrict access. The
Groups UI and policy enforcement become available to all eligible organizations when
the application release is deployed.

Invitation preassignment, SCIM group sync, group-scoped direct BYOK/custom LLMs,
group-based usage reporting, and bulk CSV assignment remain possible follow-up
features, not launch dependencies.

## Test Plan

### Database and Domain Tests

- reject duplicate canonical names in one organization
- allow the same name in different organizations
- reject cross-organization group/member assignments
- reject assignment of a non-member
- allow one member in multiple groups
- make duplicate assignment idempotent
- cascade assignments on group or membership deletion
- parse and reject malformed, unknown, or duplicate policy variants
- enforce group, policy-collection, type-specific data, name, description, and
  mutation-size limits
- treat a missing policy-settings row as default-model-all/revision-zero and create it
  atomically on first mutation
- verify whitespace, ASCII case, and representative non-ASCII behavior for the
  database's `lower(btrim(name))` uniqueness expression

### Policy Tests

- Teams ignores but preserves group policy
- default `all`, `none`, and `selected`
- groups without `model_access` contribute no model grant
- reject duplicate `model_access` policies within one collection
- preserve unrelated policy variants when updating `model_access`
- deploy readers before writers when adding a new policy discriminator
- union selected models across multiple groups
- union provider grants across multiple groups
- `all` in any grant expands only to the organization ceiling
- organization deny list overrides a group model grant
- organization provider allow list intersects group provider grants
- models with multiple providers remain available only when an eligible route remains
- explicit model grants use only organization-permitted providers
- provider-derived grants fail closed when provider metadata is unavailable
- data-collection policy remains organization-wide
- ungrouped and zero-access members
- direct BYOK/custom LLM documented bypass behavior

### Authorization Tests

- owners can manage groups and policy
- billing managers and members cannot mutate groups
- parent effective owners can manage a direct child's groups but cannot be assigned
  without direct child membership
- forged organization/group IDs fail without leaking data
- primary-database membership/group revocation affects the next request
- API tokens cannot preserve stale group access
- soft-deleted organizations fail closed
- audited platform-admin operations retain attribution

### End-to-End Gateway Tests

- every organization-aware model/provider/embedding/transcription catalog alias
  matches runtime access
- both `defaultModel` and `defaultFreeModel` match runtime access
- configured default falls back when disallowed for one member
- Auto and Organization Auto concrete targets are rechecked
- chat/messages/responses, FIM, edit, embeddings, and transcription all enforce the
  same policy
- Vercel BYOK cannot select a provider outside the model-aware eligible routes
- two users in the same organization receive different catalogs and runtime outcomes
- integration/service-account requests use the documented actor/default policy
- public requests cannot select the trusted `defaultAccess` subject

### UI Tests

- create, rename, delete, search, and assign groups
- read-only behavior by role
- member badges and multi-group assignment
- Teams plan-gated policy controls
- no-model empty state and accessible error messaging
- responsive behavior for member and model/provider selectors

## Observability and Operations

Record structured, non-sensitive fields for denied requests:

- organization ID
- actor user ID
- requested normalized model ID
- denial source: organization model, organization provider, group model, group
  provider, or no grant
- request surface

Do not log API keys, auth headers, prompts, cookies, or raw provider credentials.

Track:

- organizations with configured policy types
- members and requests by access cohort
- denied request rate by surface and reason
- members with zero effective models
- catalog/default fallback failures
- effective-policy resolver latency and database query count

Group and policy mutations should be visible in the existing organization audit log.

## Risks and Mitigations

### Inconsistent Enforcement

Risk: UI, default selection, gateway routes, and integrations calculate different
policies.

Mitigation: one canonical resolver and allow predicate, an entry-point inventory, and
cross-surface contract tests before release.

### Accidental Lockout

Risk: setting the default policy to `none` leaves ungrouped members without models.

Mitigation: default model-access policy `all`, explicit `none` semantics, clear policy
summaries, and owner-visible audit history.

### Provider Routing Bypass

Risk: provider transformations or BYOK routing overwrite the model-aware eligible
routes.

Mitigation: enforce the intersection after all policy resolution and before upstream
selection; add regression tests for Vercel BYOK. Keep only the explicitly documented
direct BYOK/custom LLM bypass.

### Request Latency

Risk: loading group assignments on every model request adds database latency.

Mitigation: use one indexed primary-database query and return a compact policy. Cache
only non-authoritative provider/catalog metadata; do not cache membership or policy
authorization state.

### Terminology Collision

Risk: organization groups are confused with organization mode tool groups or child
teams.

Mitigation: use `organization_groups` and `OrganizationGroup` in backend code, and
reserve **Groups** for the member-tagging UI.

## Resolved Product Decisions

- The entire groups feature is Enterprise-only.
- Ordinary members see only their own group names.
- Direct BYOK and custom LLM access remains organization-wide in v1.
- Owners do not receive a runtime bypass. They can change policy or disable
  `model_access` enforcement.

## Primary Existing Integration Points

- Organization and membership schema: `packages/db/src/schema.ts`
- Organization settings schema: `packages/db/src/schema-types.ts`
- Current effective organization restrictions:
  `apps/web/src/lib/organizations/model-restrictions.ts`
- Organization catalog filtering:
  `apps/web/src/lib/organizations/organization-models.ts`
- Shared model/provider predicate: `apps/web/src/lib/model-allow.server.ts`
- Organization settings router:
  `apps/web/src/routers/organizations/organization-settings-router.ts`
- Membership and child assignment router:
  `apps/web/src/routers/organizations/organization-members-router.ts`
- Organization authorization procedures:
  `apps/web/src/routers/organizations/utils.ts`
- Gateway restriction helper:
  `apps/web/src/lib/ai-gateway/llm-proxy-helpers.ts`
- Main gateway route: `apps/web/src/app/api/openrouter/[...path]/route.ts`
- Organization models/defaults routes:
  `apps/web/src/app/api/organizations/[id]/models/route.ts` and
  `apps/web/src/app/api/organizations/[id]/defaults/route.ts`
- Organization members UI:
  `apps/web/src/components/organizations/OrganizationMembersCard.tsx`
- Existing model access UI:
  `apps/web/src/components/organizations/providers-and-models/`
- Organization navigation:
  `apps/web/src/app/(app)/components/OrganizationAppSidebar.tsx`
