import { getShareExtensionKey } from 'expo-share-intent';

import { handleAppActionPath } from '@/lib/app-actions/action-url-handler';
import { takeRemoteMcpRedirect } from '@/lib/chat/remote-mcp-oauth-browser';
import { redirectSystemPath as mapWebPath } from '@/lib/deep-link-handler';
import { handleGlanceableFixturePath } from '@/lib/glanceable/fixture-harness';
import { handleHomeFixturePath } from '@/lib/home-fixture';
import { instancePickerFixtureRoute } from '@/lib/instance-picker-fixture';
import { handleLockedKeychainFixturePath } from '@/lib/locked-keychain-fixture';
import { modelPickerFixtureRoute } from '@/lib/model-picker-fixture';
import { handleOrganizationInviteMemberFixturePath } from '@/lib/organization-invite-member-fixture';
import { handlePrReviewCopyFixturePath } from '@/lib/pr-review/pr-review-copy-fixture-route';
import { handlePrReviewInstanceFixturePath } from '@/lib/pr-review/pr-review-instance-fixture';
import { profilePickerFixtureRoute } from '@/lib/profile-picker-fixture';
import { handleRenderRecoveryFixturePath } from '@/lib/render-recovery-fixture';
import { securityAgentSingleRouteFixtureRoute } from '@/lib/security-agent-single-route-fixture';

// Composes the native-intent concerns in order: the share-extension check
// returns early before web-path mapping (a share URL is never a web route), then
// an app-action URL is handled by its own contract, and only what neither owns
// reaches the universal-link mapper. Every handled or ignored link returns
// falsy (`deep-link-handler.ts`); a truthy return re-dispatches the linking
// resolver.
export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }) {
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
  // Dev-only Home fixture links (`kiloapp:///dev/home-fixture/<name>`).
  if (__DEV__ && handleHomeFixturePath(path)) {
    return null;
  }
  // Dev-only locked-keychain links (`kiloapp:///dev/locked-keychain/<name>`).
  if (__DEV__ && handleLockedKeychainFixturePath(path)) {
    return null;
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
    if (/(?:^|\/)dev\/button-label-fixture\/?(?:[?#].*)?$/.test(path)) {
      return '/button-label-fixture';
    }
    if (/(?:^|\/)dev\/session-row-fixture\/?(?:[?#].*)?$/.test(path)) {
      return '/(auth)/session-row-fixture';
    }
    if (/(?:^|\/)dev\/save-profile-sheet-fixture\/?(?:[?#].*)?$/.test(path)) {
      return '/(app)/save-profile-sheet-fixture';
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
    if (/(?:^|\/)dev\/preparation-copy-fixture\/?(?:[?#].*)?$/.test(path)) {
      return '/(app)/preparation-copy-fixture';
    }
    if (/(?:^|\/)dev\/new-session-plan-refusal-fixture\/?(?:[?#].*)?$/.test(path)) {
      return '/(app)/new-session-plan-refusal-fixture';
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
    if (/(?:^|\/)dev\/transcript-undelivered-fixture\/?(?:[?#].*)?$/.test(path)) {
      return '/(app)/transcript-undelivered-fixture';
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
    if (/(?:^|\/)dev\/organization-invoices-fixture\/?(?:[?#].*)?$/.test(path)) {
      return '/(app)/(tabs)/(3_profile)/organization/invoices-fixture';
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
  }
  if (handleAppActionPath({ path, initial })) {
    return null;
  }
  return mapWebPath({ path, initial });
}
