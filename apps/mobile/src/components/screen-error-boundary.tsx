import {
  type ErrorBoundaryProps,
  type Href,
  useNavigation,
  useRouter,
  useSegments,
} from 'expo-router';
import { useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { QueryError } from '@/components/query-error';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useRefetchBeforeRemount } from '@/lib/hooks/use-refetch-before-remount';
import { getRouteRecoveryScope } from '@/lib/navigation/route-recovery-scope';
import { captureTelemetry } from '@/lib/telemetry/error-sink';

/** Where a route with no back stack lands: the authenticated stack's anchor. */
const AUTHENTICATED_ENTRY_HREF = '/(app)/(tabs)' as Href;

/** Fallback fingerprint part for a throw that carries no name or message. */
const UNKNOWN_FINGERPRINT_PART = 'unknown';

/**
 * Error instances already reported. Module-scoped, so a remount of the fallback
 * with the same error (a parent re-render, a navigation that re-renders the
 * scene) does not file the failure twice. React's own retry throws a fresh
 * error, which is a new failure and is reported.
 */
const reportedErrors = new WeakSet<Error>();

/**
 * The static route segment that owns the failed screen, e.g. `agent-chat` for
 * `/(app)/agent-chat/<id>`. Group segments are dropped, and the first remaining
 * segment of the app's routes is a directory name, never a parameter value, so
 * it groups failures without carrying an identifier.
 */
function routeSubsystem(segments: readonly string[]): string {
  return segments.find(segment => !segment.startsWith('(')) ?? 'authenticated_route';
}

function fingerprintPart(error: unknown, part: 'name' | 'message'): string {
  if (!(error instanceof Error)) {
    return UNKNOWN_FINGERPRINT_PART;
  }
  const value = error[part];
  return value.length > 0 ? value : UNKNOWN_FINGERPRINT_PART;
}

/**
 * Render-recovery fallback for one screen of the authenticated stack.
 *
 * Expo Router's screen boundary replaces the route component only, not the
 * navigator around it, so the stack keeps its state: the header above the
 * screen (when the route shows the native one) and the back stack survive, and
 * Back still reaches the previous screen. Routes that render their own header
 * inside the screen lose it with the failed subtree, so this fallback carries
 * its own way out: `Go back` pops, or, when a cold deep link left no history,
 * replaces the route with the authenticated entry. The app's root boundary
 * stays the last resort for anything that escapes this one.
 */
export function ScreenErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  const router = useRouter();
  const navigation = useNavigation();
  const segments = useSegments();
  const { t } = useTranslation();
  const subsystem = routeSubsystem(segments);
  // The reads this route declared for itself. `Retry` refetches them before the
  // screen remounts, so a payload that poisoned the render is replaced rather
  // than replayed; a route that declared nothing remounts without a refetch.
  const queryPrefixes = getRouteRecoveryScope(navigation);
  const remount = useCallback(() => {
    void retry();
  }, [retry]);
  const { retry: retryAfterRefetch, isRetrying } = useRefetchBeforeRemount(queryPrefixes, remount);

  useEffect(() => {
    // Catching here keeps the failure from the global handler, so this is the
    // only report the crash produces. It goes through the app's telemetry sink,
    // which forwards to Sentry with the app's scrubbing and fingerprinting.
    try {
      if (reportedErrors.has(error)) {
        return;
      }
      captureTelemetry({
        level: 'error',
        error,
        tags: {
          'error.subsystem': subsystem,
          'error.operation': 'render_screen',
        },
        fingerprint: [
          subsystem,
          'render_screen',
          fingerprintPart(error, 'name'),
          fingerprintPart(error, 'message'),
        ],
      });
      // Recorded after the capture, so a thrown value that cannot be a WeakSet
      // key still reports it.
      reportedErrors.add(error);
    } catch {
      // Telemetry must never throw into the render path.
    }
  }, [error, subsystem]);

  const goBack = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace(AUTHENTICATED_ENTRY_HREF);
  }, [router]);

  return (
    <View className="flex-1 items-center justify-center bg-background px-6">
      <QueryError placement="static" onRetry={retryAfterRefetch} isRetrying={isRetrying} />
      <Button variant="ghost" className="mt-2" onPress={goBack}>
        <Text>{t('common.goBack')}</Text>
      </Button>
    </View>
  );
}
