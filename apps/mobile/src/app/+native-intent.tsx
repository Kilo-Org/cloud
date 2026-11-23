import { getShareExtensionKey } from 'expo-share-intent';

import { agentChatPickerFixtureRoute } from '@/lib/agent-chat-picker-fixture';
import { handleAppActionPath } from '@/lib/app-actions/action-url-handler';
import { takeRemoteMcpRedirect } from '@/lib/chat/remote-mcp-oauth-browser';
import { contextPickerFixtureRoute } from '@/lib/context-picker-fixture';
import { redirectSystemPath as mapWebPath } from '@/lib/deep-link-handler';
import { applyForceStatePath } from '@/lib/force-state-fixture';
import { handleGlanceableFixturePath } from '@/lib/glanceable/fixture-harness';
import { handleHomeFixturePath } from '@/lib/home-fixture';
import { instancePickerFixtureRoute } from '@/lib/instance-picker-fixture';
import { handleLockedKeychainFixturePath } from '@/lib/locked-keychain-fixture';
import { loginFixtureRoute } from '@/lib/login-fixture';
import { modelPickerFixtureRoute } from '@/lib/model-picker-fixture';
import { handleOrganizationInviteMemberFixturePath } from '@/lib/organization-invite-member-fixture';
import { nativeRemoteFixtureRoute } from '@/lib/native-remote-fixture';
import { handlePrReviewCopyFixturePath } from '@/lib/pr-review/pr-review-copy-fixture-route';
import { handlePrReviewInstanceFixturePath } from '@/lib/pr-review/pr-review-instance-fixture';
import { profilePickerFixtureRoute } from '@/lib/profile-picker-fixture';
import { queryClient } from '@/lib/query-client';
import { handleRenderRecoveryFixturePath } from '@/lib/render-recovery-fixture';
import { securityAgentSingleRouteFixtureRoute } from '@/lib/security-agent-single-route-fixture';

// Composes the native-intent concerns in order: the share-extension check
// returns early before web-path mapping (a share URL is never a web route), then
// an app-action URL is handled by its own contract, and only what neither owns
// reaches the universal-link mapper. Every handled or ignored link returns
// falsy (`deep-link-handler.ts`); a truthy return re-dispatches the linking
// resolver.
export function redirectSystemPath({
  path,
  initial,
}: {
  path: string;
  initial: boolean;
}): string | null {
  let shareKey: string | null = null;
  try {
    shareKey = getShareExtensionKey();
  } catch {
    shareKey = null;
  }
  if (shareKey && path.includes(`dataUrl=${shareKey}`)) {
    // Cold start: boot the app normally. Warm: stay exactly where the user is.
    return initial ? '/' : null;
  }
  // The Android remote MCP sign-in ends on `kiloapp:///remote-mcp?code=…`, which
  // is the waiting sign-in's answer and not a screen.
  if (takeRemoteMcpRedirect(path)) {
    return initial ? '/' : null;
  }
  // Dev-only glanceable fixture links (`kiloapp:///dev/glanceable-fixture/<name>`).
  if (__DEV__ && handleGlanceableFixturePath(path)) {
    return null;
  }
  // Dev-only native-remote transcript fixtures (`kiloapp:///dev/native-remote-
  // fixture/reconnecting|gaps`): the handler records the state and returns the
  // demo route, so the resolver lands on the screen with the fixture active.
  const nativeRemoteFixture = nativeRemoteFixtureRoute(path);
  if (nativeRemoteFixture) {
    return nativeRemoteFixture;
  }
  // Dev-only Home fixture links (`kiloapp:///dev/home-fixture/<name>`).
  if (__DEV__ && handleHomeFixturePath(path)) {
    return null;
  }
  // Dev-only locked-keychain links (`kiloapp:///dev/locked-keychain/<name>`).
  if (__DEV__ && handleLockedKeychainFixturePath(path)) {
    return null;
  }
  if (__DEV__) {
    // Dev-only forced data state
    // (`kiloapp:///dev/force-state/<mode|clear>?next=<url-encoded app link>`):
    // the mode is set, then `next` resolves exactly as that link would alone.
    const forcedNext = applyForceStatePath(path, queryClient);
    if (forcedNext !== undefined) {
      return forcedNext === null ? null : redirectSystemPath({ path: forcedNext, initial });
    }
  }
  if (__DEV__) {
    // Dev-only link that opens the connect gate's GitLab-instance state the way
    // the paste flow reaches it: a provider route carrying the paste's
    // `?instance=` hint. The handler navigates itself, so this returns falsy —
    // never a route, which the resolver would re-dispatch.
    if (handlePrReviewInstanceFixturePath(path)) {
      return null;
    }
    // Dev-only Run on sheet, opened with the bridge the composer writes
    // (`dev/instance-picker-fixture/<state>` under the development scheme).
    const instancePickerRoute = instancePickerFixtureRoute(path);
    if (instancePickerRoute) {
      return instancePickerRoute;
    }
    // Dev-only branch, folder, mode and repository sheets, opened with the
    // bridge the composer writes (`dev/<picker>-picker-fixture/<state>`).
    const agentChatPickerRoute = agentChatPickerFixtureRoute(path);
    if (agentChatPickerRoute) {
      return agentChatPickerRoute;
    }
    // Dev-only sign-in states (`dev/login-fixture/<state>`): a screen of its own
    // that writes the resumed sign-in record before the sign-in screen mounts.
    const loginFixture = loginFixtureRoute(path);
    if (loginFixture) {
      return loginFixture;
    }
    // Dev-only chat conversation in a fixed state (`dev/chat-fixture/<state>`).
    const chatFixture = /(?:^|\/)dev\/chat-fixture\/([a-z]+)\/?(?:[?#].*)?$/.exec(path);
    if (chatFixture) {
      return `/(app)/chat-fixture?state=${chatFixture[1]}`;
    }
    // Dev-only: open a Security Agent screen as its group's only route
    // (`kiloapp:///dev/security-agent-single-route-fixture/<scope>/<route…>`).
    const singleRouteFixture = securityAgentSingleRouteFixtureRoute(path);
    if (singleRouteFixture) {
      return singleRouteFixture;
    }
    const reviewEntryFixture = /(?:^|\/)dev\/pr-review-entry-fixture\/?(\?.*)?$/.exec(path);
    if (reviewEntryFixture) {
      return `/(app)/pr-review-entry-fixture${reviewEntryFixture[1] ?? ''}`;
    }
    // Dev-only link that opens a PR-review copy surface the way the entry
    // screen's own navigation does: the app's link scheme, then the dev
    // PR-review copy fixture prefix and the surface name.
    // The handler navigates itself, so this returns falsy — never a route,
    // which the resolver would re-dispatch and race against a reset to Home.
    if (handlePrReviewCopyFixturePath(path)) {
      return null;
    }
    // Dev-only account picker sheet, opened with the bridge Home's header
    // writes (`dev/context-picker-fixture`) so the sheet renders its accounts
    // instead of the "Options expired" shell a bare route link produces.
    const contextPickerFixture = contextPickerFixtureRoute(path);
    if (contextPickerFixture) {
      return contextPickerFixture;
    }
    if (/(?:^|\/)dev\/button-label-fixture\/?(?:[?#].*)?$/.test(path)) {
      return '/button-label-fixture';
    }
    // The fixture reads `lang` and `rows` from the query, so it forwards them:
    // a Hindi inspection is the default and another catalog is one link away.
    const sessionRowFixture = /(?:^|\/)dev\/session-row-fixture\/?(\?.*)?$/.exec(path);
    if (sessionRowFixture) {
      return `/(auth)/session-row-fixture${sessionRowFixture[1] ?? ''}`;
    }
    // Dev-only chat failure copy for every stable on-device refusal reason. The
    // state is the link's last segment, so it is forwarded as the route's
    // `state` param; the fixture falls back to `all` for a name it does not know.
    const localFailureCopyFixture =
      /(?:^|\/)dev\/local-failure-copy-fixture\/([a-z][a-z-]*)\/?$/.exec(path);
    if (localFailureCopyFixture) {
      return `/(app)/local-failure-copy-fixture?state=${localFailureCopyFixture[1]}`;
    }
    // Dev-only GGUF row: the retrying line and the plain downloading line together.
    if (/(?:^|\/)dev\/gguf-retry-fixture\/?(?:[?#].*)?$/.test(path)) {
      return '/(app)/gguf-retry-fixture';
    }
    if (/(?:^|\/)dev\/system-search-unresolved-fixture\/?(?:[?#].*)?$/.test(path)) {
      return '/(app)/system-search-unresolved-fixture';
    }
    if (/(?:^|\/)dev\/save-profile-sheet-fixture\/?(?:[?#].*)?$/.test(path)) {
      return '/(app)/save-profile-sheet-fixture';
    }
    // Dev-only session artifacts sheet, in the state the link's last segment
    // names (`?state=` on the route; the fixture falls back to `loaded`).
    const sessionArtifactsFixture =
      /(?:^|\/)dev\/session-artifacts-fixture\/([a-z][a-z-]*)\/?$/.exec(path);
    if (sessionArtifactsFixture) {
      return `/(app)/session-artifacts-fixture?state=${sessionArtifactsFixture[1]}`;
    }
    if (/(?:^|\/)dev\/session-artifacts-fixture\/?(?:[?#].*)?$/.test(path)) {
      return '/(app)/session-artifacts-fixture';
    }
    if (/(?:^|\/)dev\/mcp-form-sheet-fixture\/?(?:[?#].*)?$/.test(path)) {
      return '/(app)/mcp-form-sheet-fixture';
    }
    if (/(?:^|\/)dev\/account-picker-sheet-fixture\/?(?:[?#].*)?$/.test(path)) {
      return '/(app)/account-picker-sheet-fixture';
    }
    if (/(?:^|\/)dev\/transcript-style-fixture\/?(?:[?#].*)?$/.test(path)) {
      return '/(auth)/transcript-style-fixture';
    }
    const partDetailFixture = /(?:^|\/)dev\/part-detail-transition-fixture\/?(\?.*)?$/.exec(path);
    if (partDetailFixture) {
      return `/(auth)/part-detail-transition-fixture${partDetailFixture[1] ?? ''}`;
    }
    if (/(?:^|\/)dev\/attachment-chip-fixture\/?(?:[?#].*)?$/.test(path)) {
      return '/(app)/attachment-chip-fixture';
    }
    // Dev-only header geometry fixture: a centered title against each trailing
    // variant the plan names (`?variant=cluster|back-only|no-back`, default
    // cluster), so the emulator probe can measure all three from one link.
    const headerBalanceFixture = /(?:^|\/)dev\/header-balance-fixture\/?(\?.*)?$/.exec(path);
    if (headerBalanceFixture) {
      return `/(app)/header-balance-fixture${headerBalanceFixture[1] ?? ''}`;
    }
    if (/(?:^|\/)dev\/preparation-copy-fixture\/?(?:[?#].*)?$/.test(path)) {
      return '/(app)/preparation-copy-fixture';
    }
    // Dev-only plan refusal at the new-session composer. The optional query
    // picks the reader's state (`?billing=1` is the role that may change the
    // plan), so it is forwarded.
    const planRefusalFixture = /(?:^|\/)dev\/new-session-plan-refusal-fixture\/?(\?.*)?$/.exec(
      path
    );
    if (planRefusalFixture) {
      return `/(app)/new-session-plan-refusal-fixture${planRefusalFixture[1] ?? ''}`;
    }
    // Dev-only plan refusal on the low-balance alert sheet's form. The same
    // optional query picks the reader's state (`?billing=1` is the role that
    // may change the plan), so it is forwarded the same way.
    const lowBalanceRefusalFixture =
      /(?:^|\/)dev\/low-balance-alert-refusal-fixture\/?(\?.*)?$/.exec(path);
    if (lowBalanceRefusalFixture) {
      return `/(app)/low-balance-alert-refusal-fixture${lowBalanceRefusalFixture[1] ?? ''}`;
    }
    if (/(?:^|\/)dev\/transcript-failure-fixture\/?(?:[?#].*)?$/.test(path)) {
      return '/(app)/transcript-failure-fixture';
    }
    if (/(?:^|\/)dev\/transcript-terminal-failure-fixture\/?(?:[?#].*)?$/.test(path)) {
      return '/(app)/transcript-terminal-failure-fixture';
    }
    if (/(?:^|\/)dev\/transcript-credits-failure-fixture\/?(?:[?#].*)?$/.test(path)) {
      return '/(app)/transcript-credits-failure-fixture';
    }
    if (/(?:^|\/)dev\/transcript-readonly-failure-fixture\/?(?:[?#].*)?$/.test(path)) {
      return '/(app)/transcript-readonly-failure-fixture';
    }
    if (/(?:^|\/)dev\/transcript-execution-failure-fixture\/?(?:[?#].*)?$/.test(path)) {
      return '/(app)/transcript-execution-failure-fixture';
    }
    if (/(?:^|\/)dev\/transcript-preparation-failure-fixture\/?(?:[?#].*)?$/.test(path)) {
      return '/(app)/transcript-preparation-failure-fixture';
    }
    if (/(?:^|\/)dev\/transcript-undelivered-fixture\/?(?:[?#].*)?$/.test(path)) {
      return '/(app)/transcript-undelivered-fixture';
    }
    // Dev-only agent chat screen with its composer, for the design gate: a live
    // session never holds still long enough for a cell to bracket it. The
    // optional query selects the fixture's still state, so it is forwarded.
    const agentChatFixture = /(?:^|\/)dev\/agent-chat-fixture\/?(\?.*)?$/.exec(path);
    if (agentChatFixture) {
      return `/(app)/agent-chat-fixture${agentChatFixture[1] ?? ''}`;
    }
    // Dev-only auth transition: the real sign-in screen, mounted inside the
    // signed-in app, so sign-in can be exercised while an account is active.
    if (/(?:^|\/)dev\/auth-switch-fixture\/?(?:[?#].*)?$/.test(path)) {
      return '/(app)/auth-switch-fixture';
    }
    // Dev-only render-recovery faults: `kiloapp:///dev/render-recovery-fixture/<name>`
    // arms one and opens the fixture route, or clears it without navigating.
    const renderRecoveryFixture = handleRenderRecoveryFixturePath(path);
    if (renderRecoveryFixture !== undefined) {
      return renderRecoveryFixture;
    }
    if (/(?:^|\/)dev\/question-card-fixture\/?(?:[?#].*)?$/.test(path)) {
      return '/(auth)/question-card-fixture';
    }
    // Dev-only destructive settings confirmation: the screen that runs the
    // agent's `settings_set` call, so the confirm can be driven without a chat.
    if (/(?:^|\/)dev\/settings-confirm-fixture\/?(?:[?#].*)?$/.test(path)) {
      return '/(auth)/settings-confirm-fixture';
    }
    const reauthorizeFixtureMatch =
      /(?:^|\/)dev\/security-agent-reauthorize-fixture\/?(\?.*)?$/.exec(path);
    if (reauthorizeFixtureMatch) {
      // Keep the optional `?lang=` that the fixture reads to choose its capture language.
      return `/(auth)/security-agent-reauthorize-fixture${reauthorizeFixtureMatch[1] ?? ''}`;
    }
    const fixtureRoute = modelPickerFixtureRoute(path);
    if (fixtureRoute) {
      return fixtureRoute;
    }
    // Dev-only organization invoices screen against fixed Stripe answers
    // (`dev/organization-invoices-fixture/<listed|empty|error>`): the list is a
    // Stripe read a local stack cannot serve, so every capture state routes
    // here. A link without a state opens the listed page.
    const organizationInvoicesFixture =
      /(?:^|\/)dev\/organization-invoices-fixture(?:\/(listed|empty|error))?\/?(?:[?#].*)?$/.exec(
        path
      );
    if (organizationInvoicesFixture) {
      const state = organizationInvoicesFixture[1] ?? 'listed';
      return `/(app)/(tabs)/(3_profile)/organization/invoices-fixture?state=${state}`;
    }
    // Dev-only personal invoices screen against fixed Stripe answers
    // (`dev/personal-invoices-fixture/<listed|empty|error>`): the personal list
    // is a Stripe read a local stack cannot serve, so every capture state routes
    // here.
    const personalInvoicesFixture =
      /(?:^|\/)dev\/personal-invoices-fixture\/(listed|empty|error)\/?$/.exec(path);
    if (personalInvoicesFixture) {
      return `/(app)/(tabs)/(3_profile)/personal-invoices-fixture?state=${personalInvoicesFixture[1]}`;
    }
    // Dev-only invite sheet: it navigates itself, so this returns falsy.
    if (handleOrganizationInviteMemberFixturePath(path)) {
      return null;
    }
    // Dev-only profile picker sheet, reached through the development fixture path.
    const profilePickerRoute = profilePickerFixtureRoute(path);
    if (profilePickerRoute) {
      return profilePickerRoute;
    }
    // Dev-only Buy credits rows against fixed store answers
    // (`dev/credits-pack-prices-fixture/<priced|partly-priced|priced-expiring|completing|unresolved|legacy-unresolved|refused-unresolved|waiting|pending|failed>`).
    const creditsPackPrices =
      /(?:^|\/)dev\/credits-pack-prices-fixture\/(priced|partly-priced|priced-expiring|completing|unresolved|legacy-unresolved|refused-unresolved|waiting|pending|failed)\/?$/.exec(
        path
      );
    if (creditsPackPrices) {
      return `/(app)/credits-pack-prices-fixture?state=${creditsPackPrices[1]}`;
    }
  }
  if (handleAppActionPath({ path, initial })) {
    return null;
  }
  return mapWebPath({ path, initial });
}
