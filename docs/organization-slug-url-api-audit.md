# Organization Slug URL/API Audit

## Invariant

Slugs are route aliases only. A slug may appear in `/organizations/:identifier` URLs, but data/backend operations must receive a resolved organization UUID. Fields named `organizationId` or `organization_id` are UUID contracts and must reject slug values rather than treating them as first-class identifiers. URL generation should prefer `slug ?? id`.

## Route-Boundary Slug Support

| Surface | Files | Status |
|---|---|---|
| Canonical route identifier helpers | `apps/web/src/lib/organizations/organization-route-utils.ts`, `apps/web/src/lib/organizations/organization-route-utils.server.ts` | Verified. `getOrganizationRouteIdentifier` emits `slug ?? id`; server resolver accepts UUID or slug and returns UUID details. |
| Authorized organization page context | `apps/web/src/lib/organizations/organization-auth.ts`, `apps/web/src/lib/organizations/organization-page-context.server.ts`, `apps/web/src/components/organizations/OrganizationByPageLayout.tsx` | Verified. Slug route params are resolved to UUID before authorization; UUID URLs redirect to slug when a slug exists. |
| App Router organization pages | `apps/web/src/app/(app)/organizations/[id]/**` | Verified by shared layout/context pattern. Existing `[id]` segment now means route identifier, not backend ID. Major covered subtrees: dashboard, welcome, payment details, subscriptions, usage details, providers/models, custom modes, audit logs, integrations, cloud, KiloClaw, app-builder, deploy, security-agent, auto-fix, auto-triage, code-indexing, code-reviews, Gastown, Wasteland. |
| Organization API route params | `apps/web/src/app/api/organizations/[id]/route.ts`, `defaults/route.ts`, `modes/route.ts`, `models/route.ts`, `models/validate/route.ts`, `user-tokens/route.ts` | Verified/fixed tests. Route param accepts slug or UUID; handler resolves before tRPC/backend calls. |
| Reinstall routes under org pages | `apps/web/src/app/(app)/organizations/[id]/integrations/slack/reinstall/route.ts`, `linear/reinstall/route.ts` | Verified. Route params resolve through `resolveOrganizationRouteParams` before access checks. |

## Backend/API Organization ID Contracts

| Surface | Files | Status |
|---|---|---|
| Organization tRPC routers | `apps/web/src/routers/organizations/**`, especially `utils.ts` | Verified. `OrganizationIdInputSchema` is `z.uuid()` and backend procedures remain UUID-only. |
| Cross-feature tRPC org inputs | `agent-profiles`, `app-builder`, `byok`, `cli/unified sessions`, `code-indexing`, `code-reviews`, `deployments`, `discord`, `dolthub`, `github-apps`, `gitlab`, `linear`, `mcp-gateway`, `slack`, `usage-analytics`, `webhook-triggers` routers | Verified by schema scan. Inputs named `organizationId` are UUID schemas. |
| OAuth connect query/body contracts | `apps/web/src/lib/integrations/oauth/common.ts`, `platforms/gitlab-connect.ts`, `platforms/bitbucket-connect.ts` | Fixed. Optional `organizationId` is parsed as UUID before access checks and before OAuth state owner creation. |
| Auto-routing API | `apps/web/src/app/api/auto-routing/mode/route.ts` | Fixed. Query `organizationId` rejects slugs before org access, entitlement, or worker calls. |
| Code indexing APIs | `apps/web/src/app/api/code-indexing/enabled/route.ts`, `manifest/route.ts`, `upsert-by-file/route.ts` | Fixed. Query/form `organizationId` rejects slugs before tRPC/storage/backend calls. |
| Internal APIs | `apps/web/src/app/api/internal/auto-routing-benchmark/token/route.ts`, `apps/web/src/app/api/internal/integrations/dolthub/token/route.ts`, `apps/web/src/app/api/internal/kiloclaw/billing-side-effects/route.ts` | Fixed. Internal `organizationId` payloads are UUID contracts. |
| Signed/state payloads and event schemas | `apps/web/src/lib/bot/linear-link-state.ts`, `apps/web/src/lib/cloud-agent-sdk/schemas.ts` | Fixed. Organization IDs inside state/events are UUID-or-null contracts. |
| Stripe seat metadata | `apps/web/src/lib/organizations/organization-seats.ts` | Fixed. Subscription metadata `organizationId` parses as UUID. |
| Admin/analytics owner schemas | `apps/web/src/routers/auto-triage/auto-triage-router.ts`, `apps/web/src/routers/usage-analytics-router.ts` | Fixed. Organization owner/output IDs are UUID schemas. |

## URL Generation Findings

| Pattern | Files | Status |
|---|---|---|
| Slug-aware generated organization links | `OrganizationSwitcher.tsx`, `OrganizationAppSidebar.tsx`, `OrganizationMembersCard.tsx`, `OrganizationChildOrganizationsCard.tsx`, `OrganizationInfoCard.tsx`, payment top-up success and cancel paths | Verified/fixed. These use `getOrganizationRouteIdentifier` or resolved route identifier. |
| Existing UUID-based but compatible organization links | App-builder, cloud-agent, deploy, integrations, security-agent, usage detail links, feature adoption links, webhook routes, MCP gateway routes, bot reinstall links, code-review action links | Documented. These continue to work because UUID URLs are accepted and canonicalized on page routes, but they do not yet prefer slug at generation time. |
| Email/service generated organization links | `services/kiloclaw-billing/src/lifecycle.ts`, `apps/web/src/lib/organizations/organization-auto-top-up.ts`, some email/admin test helpers | Documented. These still build UUID organization URLs because the generating context only has organization UUID. They are compatible via canonical redirect, but should be upgraded when slug data is available at generation time. |
| External provider URLs containing `organizations` | GitHub organization repository creation URLs | Not applicable. These are provider URLs, not Kilo organization route identifiers. |
| Admin organization URLs | `apps/web/src/app/admin/**`, admin components/hooks | Not part of slug migration. Admin routes intentionally remain UUID-keyed. |

## Fixes Applied In This Pass

| Area | Change |
|---|---|
| Payment top-up | Slug/UUID query route identifier is resolved with `getAuthorizedOrgContext`; Stripe customer lookup, metadata, and checkout use UUID; cancel/success returns prefer slug route identifier. |
| Organization models validate API test | Added slug-to-UUID resolver mocking and 404 resolver coverage. |
| API/query hardening | Query/form/body fields named `organizationId` now reject slugs in OAuth connect, auto-routing, code-indexing, selected internal APIs, bot-link state, Cloud Agent events, Stripe metadata, admin triage, and usage analytics. |

## Verification

| Check | Result |
|---|---|
| Slug route helper/router tests | Passed: `organization-route-utils`, `useUrlOrganizationId`, organization router/admin router, organization lib tests. |
| Organization API `[id]` tests | Passed: defaults, modes, models validate. |
| Auto-routing/internal/bot/billing focused tests | Passed: 7 suites, 43 tests. |
| Typecheck | Passed: `scripts/typecheck-all.sh --changes-only` and `pnpm --filter web typecheck`. |

