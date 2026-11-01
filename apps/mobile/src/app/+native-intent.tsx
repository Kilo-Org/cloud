import { getShareExtensionKey } from 'expo-share-intent';

import { handleAppActionPath } from '@/lib/app-actions/action-url-handler';
import { takeRemoteMcpRedirect } from '@/lib/chat/remote-mcp-oauth-browser';
import { redirectSystemPath as mapWebPath } from '@/lib/deep-link-handler';
import { handleGlanceableFixturePath } from '@/lib/glanceable/fixture-harness';
import { handleHomeFixturePath } from '@/lib/home-fixture';
import { modelPickerFixtureRoute } from '@/lib/model-picker-fixture';
import { handlePrReviewInstanceFixturePath } from '@/lib/pr-review/pr-review-instance-fixture';
import { profilePickerFixtureRoute } from '@/lib/profile-picker-fixture';
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
  if (__DEV__) {
    // Dev-only link that opens the connect gate's GitLab-instance state the way
    // the paste flow reaches it: a provider route carrying the paste's
    // `?instance=` hint. It returns a route itself, so this returns falsy (see
    // `handlePrReviewInstanceFixturePath`).
    if (handlePrReviewInstanceFixturePath(path)) {
      return null;
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
    const reviewCopyFixture =
      /(?:^|\/)dev\/pr-review-copy-fixture\/(tabs|checks|navigator|files|merge|overview|merge-request-missing|merge-request-error|submit)\/?(?:\?([^#]*))?(?:#.*)?$/.exec(
        path
      );
    if (reviewCopyFixture) {
      // Carry the link's own query (the submit surface reads the PR triple from
      // it) alongside the surface the fixture mounts.
      const extras = reviewCopyFixture[2] ? `&${reviewCopyFixture[2]}` : '';
      return `/(auth)/pr-review-copy-fixture?surface=${reviewCopyFixture[1]}${extras}`;
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
    if (/(?:^|\/)dev\/transcript-style-fixture\/?(?:[?#].*)?$/.test(path)) {
      return '/(auth)/transcript-style-fixture';
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
