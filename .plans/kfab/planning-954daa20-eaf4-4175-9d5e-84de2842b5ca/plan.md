<!-- kfab-plan schema=1 -->
# Implementation plan

## Change title

Persist enterprise feature-adoption completion and collapse the Usage page to AI usage once all five checks pass

## Problem

On the enterprise Usage page (`/organizations/[id]/usage-details`), the Overview and Feature adoption tabs always appear. Feature adoption is calculated live from integration, agent-config and session tables (`getFeatureAdoptionState`), and every one of those inputs can turn false again. Nothing records that an organization has finished adoption. So the tabs can't be hidden once all five features are adopted, and a checklist hidden that way would come back if a feature were later disconnected. Issue #9079 asks that both tabs disappear for good after all five checks pass, and that `?view=overview` / `?view=feature-adoption` open AI usage instead.

## Evidence

- UsageViewNavigation.tsx renders a fixed VIEW_LABELS list (overview, feature-adoption, ai-usage). It only filters that list by `isSalesDemo`.
- useUsageDashboardState.ts accepts 'overview' and 'feature-adoption' as valid `view` values on first load and on popstate. When the param is missing it falls back to `defaultState?.usageView ?? 'overview'` (first load) or a hard-coded 'overview' (popstate). The URL-sync effect removes `view` from the URL when the view is 'overview'.
- UsageAnalyticsDashboard.tsx shows the enterprise views only when `organizationPlan === 'enterprise'`. It branches on usageView: 'overview' renders FeatureAdoptionView (compact) and AIAdoptionSummaryCard; 'feature-adoption' renders FeatureAdoptionView and RecommendationsView; any other value renders the detailed AI usage panels. Sales-demo orgs already pass `salesDemoDefaults` with `usageView: 'ai-usage'`, which is the pattern to follow.
- feature-adoption.ts `getFeatureAdoptionState` builds the five booleans from EXISTS subqueries over live tables. All of them can revert. A repository search for 'feature_adoption' finds no persisted completion state.
- OrganizationSettingsSchema (packages/db/src/schema-types.ts) is a JSONB object that already holds per-org flags (`is_sales_demo`, `recommendations_digest_enabled`). `setOrganizationRecommendationsDigestEnabled` in packages/web-shared organizations.ts uses an atomic single-key `jsonb_set` update, which can be reused for a new key without a SQL migration.
- page.tsx passes `organization.settings.is_sales_demo` into UsageAnalyticsDashboard through OrganizationByPageLayout's render callback, so the organization's settings are already available server-side on this page.
- The recommendations list (RecommendationsView) appears only in the Feature adoption view. It covers more than the five features (SSO, unused seats, merge gates, broken integrations, and so on). The weekly digest email links to `usage-details?view=feature-adoption` (packages/web-shared/src/lib/email.ts) and is sent whenever open recommendations exist, even for fully adopted orgs.
- Related PRs: PR #4162 added the three-view layout; PR #5505 added hiding views for sales-demo orgs. Sentry (kilocode-web, 30d): no matching issues for this area.

## Desired outcome

An enterprise organization whose five adoption checks have all passed at least once is marked complete, and the mark is kept. From then on its Usage page shows only AI usage: the Overview and Feature adoption tabs are gone, and any `view=overview` / `view=feature-adoption` URL (direct link, bookmark, email link, back/forward) renders AI usage. This holds even after a feature is later disconnected or disabled. Organizations that are not complete see the same page as today.

## Scope

- Add an optional `feature_adoption_completed_at` (ISO string) key to OrganizationSettingsSchema, plus an atomic single-key `jsonb_set` helper that writes it only if it's not already set.
- Add a server-side `resolveFeatureAdoptionCompletion(organizationId, settings)` helper in feature-adoption.ts. It returns true right away if the flag exists. Otherwise, for enterprise orgs it runs `getFeatureAdoptionState`, and if all five checks are true it saves the flag and returns true.
- Call the helper from the usage-details page on the server, and also from the `getFeatureAdoption` / `getRecommendations` procedures, so completion is recorded wherever adoption is evaluated. Pass a new `featureAdoptionComplete` prop to UsageAnalyticsDashboard.
- UsageViewNavigation: hide the overview and feature-adoption entries when adoption is complete. Since only one entry would remain, don't render the nav at all in that case (same result for sales-demo orgs).
- useUsageDashboardState: accept a set of allowed views and a default view. When adoption is complete, both first load and popstate map any disallowed or missing `view` to 'ai-usage'. URL sync must not remove `view=ai-usage` in a way that later falls back to overview.
- UsageAnalyticsDashboard: for complete orgs, always render the AI usage branch, update the header subtitle so it no longer mentions feature adoption, and render RecommendationsView below the AI usage content so recommendations stay reachable.
- Tests: unit tests for the completion helper (incomplete, just completed, already flagged with a regressed live check, non-enterprise) and for view clamping in the state hook / navigation.

## Exclusions

- No new database column or SQL migration. The flag is stored in the existing settings JSONB.
- No scheduled backfill job. Already-complete orgs are marked lazily the next time their Usage page or adoption endpoints are used, which meets the visible requirement.
- No admin or user control to reset or un-hide the checklist.
- No changes to which checks make up adoption or how they are computed.
- Non-enterprise and sales-demo behaviour stays the same (sales-demo already shows AI usage only).
- No change to the recommendations digest's send rules or content. Its `?view=feature-adoption` link is kept and is clamped to AI usage (where recommendations now appear) for complete orgs.

## Approach

- Persistence: add `feature_adoption_completed_at: z.string().optional()` to OrganizationSettingsSchema with a comment saying it is sticky. Add `markOrganizationFeatureAdoptionCompleted(organizationId, now)` next to `setOrganizationRecommendationsDigestEnabled`. It runs a single UPDATE with `jsonb_set(COALESCE(settings,'{}'), '{feature_adoption_completed_at}', to_jsonb(now))` and a WHERE clause `settings->>'feature_adoption_completed_at' IS NULL`, so concurrent writers stay idempotent and other keys are never overwritten.
- Detection: in apps/web/src/lib/organizations/feature-adoption.ts add `isFeatureAdoptionComplete(state)` (all five true) and `resolveFeatureAdoptionCompletion({ organizationId, plan, settings })`. Return false for non-enterprise orgs. Return true without querying if the flag is already set. Otherwise compute the state, write the flag if complete, and return the result. Have `getOrganizationFeatureAdoption` and `getOrganizationRecommendations` call the write path after computing state, so opening the Feature adoption tab or running the digest cron also records completion with no extra query.
- Page wiring: OrganizationByPageLayout's render callback is synchronous, so add a small async server component (e.g. `OrganizationUsageDashboardServer`) that awaits `resolveFeatureAdoptionCompletion` and renders UsageAnalyticsDashboard with `featureAdoptionComplete`. Server-side resolution means the first paint is already correct, with no flash of the old tabs and no client redirect.
- Client state: change `useUsageDashboardState(defaultState, options?: { allowedViews })`. Use `allowedViews` in both the initializer and the popstate handler. If the URL value isn't allowed, use `defaultState.usageView`, and use the same default when `view` is missing on popstate (fixes the hard-coded 'overview'). In the URL-sync effect, only delete `view` when it equals the effective default. In the dashboard, complete orgs pass `{ usageView: 'ai-usage' }` and `allowedViews: ['ai-usage']`, merged with any existing scope defaults.
- UI: UsageViewNavigation takes `views` (or `featureAdoptionComplete`) and the dashboard skips rendering it when only one view is left. Gate the overview and feature-adoption branches on `!featureAdoptionComplete` as well. In the AI usage branch for complete enterprise orgs, render `<RecommendationsView organizationId canDismiss={canManageOrganization(callerRole)} />` after the usage panels. Change the subtitle to 'Track AI assisted work across {name}.' Follow the kilo-design-cloud skill for spacing and placement.
- Tests: Jest DB tests for the helper and `markOrganizationFeatureAdoptionCompleted` (key written once, other settings untouched, a second call keeps the original timestamp). A router test where all five checks pass, one integration is then disabled, and the org is still resolved as complete. Hook/component tests for clamping on first load and popstate, and for the nav entries.

## Affected areas

- packages/db/src/schema-types.ts (OrganizationSettingsSchema)
- packages/web-shared/src/lib/organizations/organizations.ts (atomic completion setter)
- apps/web/src/lib/organizations/feature-adoption.ts and recommendations.ts
- apps/web/src/routers/organizations/organization-usage-details-router.ts (+ test)
- apps/web/src/app/(app)/organizations/[id]/usage-details/page.tsx
- apps/web/src/components/usage-analytics/UsageAnalyticsDashboard.tsx, UsageViewNavigation.tsx, useUsageDashboardState.ts

## Acceptance criteria

### ac-1: When an enterprise organization's five feature-adoption checks first all evaluate true (on the usage-details page, or in the getFeatureAdoption/getRecommendations procedures), `settings.feature_adoption_completed_at` is written once. The write uses a single-key atomic update that leaves other settings keys alone, and a later evaluation never overwrites the original timestamp. Non-enterprise orgs and orgs with any check false are never marked. Covered by Jest DB tests.

**Verification:** Code review

### ac-2: Completion is sticky: after an org is marked, disabling or disconnecting one of the five features (e.g. turning off the Code Reviewer agent config) still resolves the org as complete. A test reproduces this regression scenario.

**Verification:** Code review

### ac-3: For a complete enterprise org, the Usage page renders no Overview or Feature adoption navigation entry and shows the AI usage content on first server render. For an incomplete enterprise org, all three tabs and the current default (Overview) are unchanged.

**Verification:** Manual: Load /organizations/<id>/usage-details for a complete and an incomplete enterprise org and confirm the tabs shown and the initial view

### ac-4: For a complete org, opening `usage-details?view=overview`, `?view=feature-adoption`, or no `view` param renders AI usage. The same holds after browser back/forward between URLs carrying those values: the popstate handler clamps to ai-usage instead of falling back to overview. Covered by hook/component tests.

**Verification:** Code review

### ac-5: For complete orgs, recommendations stay reachable: RecommendationsView renders on the AI usage view with dismiss/restore for org admins, so the digest email's `?view=feature-adoption` link lands on a page that shows them.

**Verification:** Manual: Follow the digest dashboard link for a complete org with open recommendations and confirm recommendations appear on the AI usage view

## Risks

- Lazy marking means an org that is already complete but never opens the page or adoption endpoints stays unmarked until it does. This is invisible to users because the tabs are only seen on that page.
- A brief state where all five checks are true (e.g. a source-control integration connected for a moment) marks the org permanently. That is what the issue asks for, but it can't be undone without a manual settings edit.
- Changing the `view` default and popstate handling in useUsageDashboardState could affect personal-context and non-enterprise usage pages. Defaults must stay 'overview' when no options are passed.
- Showing recommendations on the AI usage view is a product/design choice. Reviewers may prefer to retire them for complete orgs instead.

## Assumptions

- 'All 5 features adopted' means the five FEATURE_ADOPTION_KEYS checks in feature-adoption.ts all return true at the same time.
- Completion is per organization and applies to every member who views the page, not per user.
- The issue's hidden body/comments don't add requirements beyond the title and the triage summary (permanent hiding, survives later disconnection, view deep links go to AI usage).

## Decisions

### d-1: Where should durable completion state live?

**Answer:** As `feature_adoption_completed_at` in the existing organizations.settings JSONB, written by an atomic set-if-absent update. This needs no SQL migration and follows the `is_sales_demo` / `recommendations_digest_enabled` precedent.

**Blocking:** no

### d-2: How are organizations that are already fully adopted at rollout handled?

**Answer:** Lazily. Completion is checked and saved when the usage-details page or the adoption/recommendations code paths run, so no separate backfill job is needed.

**Blocking:** no

### d-3: What happens to recommendations and the digest email link for complete orgs?

**Answer:** RecommendationsView moves below the AI usage content for complete orgs. The email link is unchanged and is clamped to AI usage, where the recommendations now appear.

**Blocking:** no
