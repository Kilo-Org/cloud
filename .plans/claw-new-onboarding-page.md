# Move KiloClaw onboarding to `/claw/new`

## Context

- Read `.specs/kiloclaw-controller.md` and `.specs/kiloclaw-billing.md` because this touches KiloClaw setup/provisioning and personal billing gates.
- Current personal `/claw` owns billing gating and an `isNewSetup` flag, while `ClawDashboard.tsx` owns the onboarding state machine and renders `CreateInstanceCard` when no instance exists.
- Current org `/organizations/[id]/claw` always polls org status; the org router returns a `status: null` sentinel when no org instance exists.
- User clarified that `/claw/new` for users with an existing instance should start after provisioning, not at the bot identity/configuration steps.

## Implementation Plan

1. Extract onboarding-only UI from `ClawDashboard.tsx`.
   - Create a new client component under `apps/web/src/app/(app)/claw/components/`, e.g. `ClawOnboardingFlow.tsx`.
   - Move the wizard state, PostHog events, mutation selection, gateway status polling, degraded-service alert, `CreateInstanceCard`, `ProvisioningStep`, optional `ChannelPairingStep`, and final ready card into that component.
   - Extract the current final ready card into a small reusable component, e.g. `ClawSetupCompleteStep`, so existing-instance `/claw/new` can render the post-provisioning step without running identity/permission/channel config mutations.
   - Replace the final card's `Close Wizard` state toggle with scoped navigation back to `/claw` or `/organizations/${organizationId}/claw`.

2. Add explicit initial modes for the new flow.
   - `create-first`: users without an instance see `CreateInstanceCard`; after provisioning starts, continue through the existing identity -> permissions -> channels -> provisioning -> pairing/done flow.
   - `post-provisioning`: users with an existing instance render the extracted completion step immediately, matching the clarified "start after provisioning" behavior.
   - Keep the flow state in the route-level client layer so billing/status query transitions after `provision` do not reset the wizard back to the initial mode.

3. Preserve personal billing behavior on `/claw/new`.
   - Add `apps/web/src/app/(app)/claw/new/page.tsx` as a client route, or a server shell plus client component.
   - Reuse the current `/claw` billing loading/error handling and `WelcomePage` branch for brand-new users who are not trial-eligible.
   - For trial-eligible/no-instance users, render `ClawOnboardingFlow` in `create-first` mode with `status={undefined}`.
   - For users with an instance, load personal KiloClaw status and render `ClawOnboardingFlow` in `post-provisioning` mode.
   - Keep `BillingWrapper` around personal setup content with banners hidden, so locked/expired users remain gated the same way the dashboard currently gates setup.

4. Add organization-scoped `/claw/new`.
   - Add `apps/web/src/app/(app)/organizations/[id]/claw/new/page.tsx` using `OrganizationByPageLayout`.
   - Add a small org client component that calls `useOrgKiloClawStatus(organizationId)` and renders the new flow with `organizationId` in context.
   - Use the org status sentinel (`status: null`) to choose `create-first`; use populated status to choose `post-provisioning`.
   - Do not add personal billing checks to org setup; keep relying on org membership/subscription procedures and the existing `skip` behavior for org billing wrappers.

5. Simplify `ClawDashboard.tsx` to dashboard-only.
   - Remove `isNewSetup`, `onNewSetupChange`, onboarding imports, onboarding state/effects, and setup-specific PostHog handling from the dashboard.
   - Keep the header, degraded-service alert, config-service nudge, billing wrapper, instance controls, and dashboard tabs.
   - Replace the no-instance branch with a lightweight empty state linking to the scoped setup route (`/claw/new` or `/organizations/${organizationId}/claw/new`) instead of rendering `CreateInstanceCard`.

6. Update route clients and helper types.
   - Remove `isNewSetup` props from `ClawPage`, `OrgClawDashboardClient`, and `withStatusQueryBoundary`.
   - Update `withStatusQueryBoundary.test.ts` to reflect the simplified wrapped-component props.
   - Update exports in `components/index.ts` if the new onboarding component or completion step should be reused by routes/storybook.
   - Update `CreditsNudge.actions.ts` and any cancel/return paths that currently hard-code `/claw?model=...&payment=success` so payment returns land on `/claw/new` and can auto-provision from the setup page.

7. Verification.
   - Run `pnpm typecheck`.
   - Run the focused test `pnpm test -- apps/web/src/app/(app)/claw/components/withStatusQueryBoundary.test.ts` if the test command supports that path, or `pnpm test` if not.
   - Use the dev server port from `.dev-port` and test in Chrome DevTools MCP in isolated sessions:
     - Personal no-instance/trial-eligible user: `/claw/new` renders create-first flow and `/claw` no longer embeds setup.
     - Personal existing-instance user: `/claw/new` renders the post-provisioning completion step.
     - Org no-instance route: `/organizations/<id>/claw/new` renders create-first flow.
     - Org existing-instance route: `/organizations/<id>/claw/new` renders post-provisioning completion step.
