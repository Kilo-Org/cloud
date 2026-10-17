import { getShareExtensionKey } from 'expo-share-intent';

import { handleAppActionPath } from '@/lib/app-actions/action-url-handler';
import { takeRemoteMcpRedirect } from '@/lib/chat/remote-mcp-oauth-browser';
import { redirectSystemPath as mapWebPath } from '@/lib/deep-link-handler';
import { handleGlanceableFixturePath } from '@/lib/glanceable/fixture-harness';
import { handleHomeFixturePath } from '@/lib/home-fixture';
import { modelPickerFixtureRoute } from '@/lib/model-picker-fixture';

// Composes the native-intent concerns in order: the share-extension check
// returns early before web-path mapping (a share URL is never a web route), then
// an app-action URL is handled by its own contract, and only what neither owns
// reaches the universal-link mapper. Both handled branches return falsy
// (`deep-link-handler.ts`); a truthy return re-dispatches the linking resolver.
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
    if (/(?:^|\/)dev\/transcript-style-fixture\/?(?:[?#].*)?$/.test(path)) {
      return '/(auth)/transcript-style-fixture';
    }
    if (/(?:^|\/)dev\/question-card-fixture\/?(?:[?#].*)?$/.test(path)) {
      return '/(auth)/question-card-fixture';
    }
    const fixtureRoute = modelPickerFixtureRoute(path);
    if (fixtureRoute) {
      return fixtureRoute;
    }
  }
  if (handleAppActionPath({ path, initial })) {
    return null;
  }
  return mapWebPath({ path, initial });
}

// ci-probe 1
