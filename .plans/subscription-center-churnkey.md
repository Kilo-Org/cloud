# Subscription Center Churnkey Integration Plan

## Context

- Relevant spec: `.specs/subscription-center.md`.
- PR #2113 added Churnkey for Kilo Pass cancellation in the profile settings modal.
- The Subscription Center Kilo Pass detail page still has a direct cancellation confirmation path, so users can bypass Churnkey from `/subscriptions/kilo-pass`.

Existing Churnkey pieces:

- `apps/web/src/lib/churnkey/auth.ts` computes the server-side HMAC using `CHURNKEY_API_SECRET`.
- `apps/web/src/lib/churnkey/loader.ts` loads the Churnkey SDK and exposes `showCancelFlow()`.
- `apps/web/src/routers/kilo-pass-router.ts` exposes `kiloPass.getChurnkeyAuthHash`.
- `apps/web/src/components/profile/kilo-pass/KiloPassSubscriptionSettingsModal.tsx` fetches the hash, opens Churnkey, cancels through `kiloPass.cancelSubscription`, invalidates Kilo Pass queries, and falls back to `window.confirm` plus direct cancellation when Churnkey fails.

## Implementation Steps

1. Add a shared client flow for Kilo Pass Churnkey cancellation.

   - Create `apps/web/src/components/profile/kilo-pass/useKiloPassChurnkeyCancelFlow.ts`.
   - Extract a dependency-injected coordinator in a sibling node-testable file, for example `apps/web/src/components/profile/kilo-pass/kiloPassChurnkeyCancelFlow.ts`. Keep tests in the repo's existing node-only `*.test.ts` setup; do not add jsdom/client test infrastructure for this narrow change.
   - The hook accepts:
     - `stripeSubscriptionId: string`
     - `fallbackCancelSubscription: () => void`
     - optional `onBeforeOpen?: () => void`
   - The hook returns:
     - `openCancelFlow: () => Promise<void>`
     - `isOpeningCancelFlow: boolean`
   - The coordinator/hook must match the existing profile modal behavior while making the fallback boundary explicit:
     - use a synchronous `inFlightRef` or equivalent coordinator-level in-flight flag, set before the first `await`, rather than relying only on React state;
     - ignore duplicate `openCancelFlow` calls while the ref/flag is set;
     - fetch `{ hash, customerId }` from `trpcClient.kiloPass.getChurnkeyAuthHash.query()`;
     - call `onBeforeOpen` after auth succeeds and before opening Churnkey;
     - call `showCancelFlow({ authHash, customerId, stripeSubscriptionId, ... })`;
     - keep the in-flight ref/flag set after `showCancelFlow()` returns, because `showCancelFlow()` returns immediately after `window.churnkey.init(...)`; clear it from the wrapped Churnkey `onClose` callback, and clear it on any pre-open failure;
     - in Churnkey `onCancel`, call `trpcClient.kiloPass.cancelSubscription.mutate()`, show `Cancellation scheduled`, and invalidate `trpc.kiloPass.getState` plus `trpc.kiloPass.getScheduledChange`;
     - in Churnkey `onClose`, invalidate the same queries to catch accepted offers or state changes;
     - on any failure before the user is inside Churnkey, show the error toast and use `window.confirm('Are you sure you want to cancel your Kilo Pass subscription?')` before calling `fallbackCancelSubscription()`.
   - The fallback catch must wrap the whole pre-Churnkey flow, not just SDK loading/opening. This includes failures from `getChurnkeyAuthHash` such as missing `CHURNKEY_API_SECRET`, auth-query failures, and SDK load/init failures. If the direct fallback cancellation also fails, the existing direct cancellation action should surface its error to satisfy the Subscription Center management-action error handling rules.
   - Keep `useKiloPassSubscriptionInfo.actions.cancelSubscription` as the direct mutation/fallback path; do not replace it globally with Churnkey.

2. Refactor the profile Kilo Pass settings modal to use the shared hook.

   - Update `apps/web/src/components/profile/kilo-pass/KiloPassSubscriptionSettingsModal.tsx`.
   - Remove duplicated Churnkey flow code and the direct `showCancelFlow` import.
   - Instantiate the new hook with:
     - `stripeSubscriptionId: subscription.stripeSubscriptionId`
     - `fallbackCancelSubscription: actions.cancelSubscription`
     - `onBeforeOpen: onClose`
   - Wire `MainPanel.onOpenCancelSubscription` to `openCancelFlow`.
   - Include `isOpeningCancelFlow` in the modal's `isMutating` calculation so modal-level actions are disabled while auth/script loading is in progress.
   - Update `apps/web/src/components/profile/kilo-pass/KiloPassSubscriptionSettingsMainPanel.tsx` so the cancel button also knows about the Churnkey-opening state:
     - add an `isOpeningCancelFlow` or `isOpeningCancelSubscriptionFlow` prop;
     - pass it from `KiloPassSubscriptionSettingsModal.tsx`;
     - disable the destructive cancel button when either Churnkey is opening or direct cancellation is pending;
     - render a distinct loading label/icon such as `Opening cancellation flow` while Churnkey auth/script loading is in progress.

3. Wire Subscription Center Kilo Pass inline cancellation through Churnkey.

   - Update `apps/web/src/components/subscriptions/kilo-pass/KiloPassDetail.tsx`.
   - In `KiloPassInlineActions`, get `subscription` from `useKiloPassSubscriptionInfo()` in addition to `view` and `actions`.
   - Instantiate the new hook with:
     - `stripeSubscriptionId: subscription.stripeSubscriptionId`
     - `fallbackCancelSubscription: actions.cancelSubscription`
   - Change the Subscription Center `Cancel Subscription` button to call `openCancelFlow` directly instead of opening the direct-cancel `AlertDialog`.
   - Disable the button while `isOpeningCancelFlow` or `actions.isCancelingSubscription` is true, and show an opening/canceling label if appropriate.
   - Remove the cancel branch from the local confirmation-dialog state; keep the resume confirmation dialog intact.
   - After the rewrite, the local confirmation state should model only actions that still use the dialog, currently `resume`.

4. Add focused server-side coverage for Churnkey auth.

   - Update `apps/web/src/routers/kilo-pass-router.test.ts`.
   - Add `getChurnkeyAuthHash` to the local `KiloPassCaller` type.
   - Add tests for:
     - missing `stripe_customer_id` throws `Missing Stripe customer for user.`;
     - configured `CHURNKEY_API_SECRET` returns the Stripe customer id and expected HMAC-SHA256 hash;
     - missing `CHURNKEY_API_SECRET` throws `CHURNKEY_API_SECRET is not configured`.
   - Preserve and restore the original `process.env.CHURNKEY_API_SECRET` around these tests to avoid cross-test pollution.

5. Add node-only client behavior coverage for the Churnkey rewrite.

   - Add tests for the shared Churnkey cancel-flow coordinator. These tests are mandatory and should cover:
     - success path fetches the auth hash, opens Churnkey with the current Stripe subscription id, calls the Kilo Pass cancel mutation from Churnkey `onCancel`, and invalidates Kilo Pass state/scheduled-change queries;
     - auth-query failure path falls back to browser confirmation and direct cancellation, including a rejected `getChurnkeyAuthHash` that represents missing `CHURNKEY_API_SECRET` or another server-side pre-open failure;
     - SDK load/init failure path falls back to browser confirmation and direct cancellation;
     - declined fallback confirmation does not call direct cancellation;
     - duplicate `openCancelFlow` calls before the first call settles are ignored synchronously;
     - duplicate `openCancelFlow` calls after `showCancelFlow()` resolves but before the wrapped Churnkey `onClose` callback fires are ignored;
     - a new open is allowed after the wrapped Churnkey `onClose` callback clears the in-flight guard.
   - Add coverage for the Subscription Center inline action rewrite without adding jsdom/client test setup:
     - extract the inline action decision/state model into a pure helper, for example `apps/web/src/components/subscriptions/kilo-pass/KiloPassDetail.logic.ts`;
     - test that cancel maps to the Churnkey opener action, not direct cancellation;
     - test that resume still maps to the confirmation-dialog action and confirms through the existing resume callback;
     - test the loading/disabled model for Churnkey-opening and direct-cancel fallback states.
   - Do not add `@testing-library/react`, jsdom config, or Jest `*.test.tsx` matching for this task unless a separate testing-infrastructure task is explicitly approved.

## Verification

- Run mandatory repo typecheck: `pnpm typecheck`.
- Run targeted tests: `pnpm test -- apps/web/src/routers/kilo-pass-router.test.ts`.
- Run any new node-only client-flow tests added for this change, for example `pnpm test -- apps/web/src/components/profile/kilo-pass/kiloPassChurnkeyCancelFlow.test.ts apps/web/src/components/subscriptions/kilo-pass/KiloPassDetail.logic.test.ts`.
- Run lint/format checks for changed files: `pnpm --filter web lint` and `pnpm format:changed`.

## Manual QA Checklist

- With a user that has an active Kilo Pass subscription, open `/subscriptions/kilo-pass` and click `Cancel Subscription`; verify the Churnkey flow opens instead of the direct confirmation dialog.
- Double-click `Cancel Subscription` while the flow is opening and verify only one Churnkey flow opens.
- Complete the Churnkey cancel flow and verify the Subscription Center reflects pending cancellation after close.
- Reopen the profile Kilo Pass settings cancellation path and verify it still opens Churnkey after the refactor.
- Simulate Churnkey auth-hash failure or SDK failure if practical and verify both surfaces still fall back to direct cancellation confirmation.
- Verify a pending-cancel subscription still shows the resume action and the resume confirmation dialog still works.

## Risks and Notes

- Churnkey depends on `NEXT_PUBLIC_CHURNKEY_APP_ID` and `CHURNKEY_API_SECRET`; the fallback path must preserve cancellation ability for pre-Churnkey failures, including auth-hash failures and SDK load/init failures.
- `showCancelFlow()` uses live mode when `NODE_ENV === 'production'`; this is existing behavior and should not be changed for this task.
- `.specs/subscription-center.md` now captures the user-facing invariant: Kilo Pass cancellation uses the canonical cancellation flow, dismissed flows do not schedule cancellation, and direct confirmation is allowed as a fallback when the canonical flow is unavailable.
- The spec intentionally does not name Churnkey because the vendor choice is an implementation detail.
- No database schema or GDPR/PII changes are involved.
