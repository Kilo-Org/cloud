import { useSegments } from 'expo-router';
import { useEffect } from 'react';

import { captureScreen } from '@/lib/analytics/posthog';

/**
 * Captures a PostHog $screen event on every route change. Route segments keep
 * their bracket placeholders (e.g. `chat/[sandbox-id]`), so no IDs or other
 * dynamic values ever leave the device.
 */
export function useScreenTracking(): void {
  const segments = useSegments();
  const screenName = segments.join('/');

  useEffect(() => {
    if (screenName) {
      captureScreen(screenName);
    }
  }, [screenName]);
}
