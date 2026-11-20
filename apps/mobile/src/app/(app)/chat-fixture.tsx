import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';

import { BootstrapLoadingSurface } from '@/components/bootstrap-loading-surface';
import { QueryError } from '@/components/query-error';
import { isChatFixtureState, writeChatFixture } from '@/lib/chat/chat-fixture';
import { useChatPlace } from '@/lib/chat/use-chat';

/**
 * Development-only entry for one chat conversation in a fixed state: it starts
 * the chat of `src/lib/chat/chat-fixture.ts` for the signed-in place, then
 * replaces itself with the real conversation route, so the gate measures
 * `(app)/(tabs)/(4_chat)/[id]` itself. A write that fails shows the error with
 * Retry instead of the loading surface.
 *
 * The place follows the organization context, which can still be restoring
 * when the link lands. Only the newest attempt may navigate or show its
 * failure: an attempt for a place the route has since left, or one that settles
 * after the route unmounted, is dropped. Its chat is already released, so it is
 * one more fixture row in that place's list and nothing stays live.
 *
 * Link: `kiloapp:///dev/chat-fixture/<empty|failed|credits|long>`, mapped in
 * `src/app/+native-intent.tsx`. A release build redirects away.
 */
export default function ChatFixtureRoute() {
  const { state } = useLocalSearchParams<{ state?: string }>();
  const router = useRouter();
  const place = useChatPlace();
  const [failed, setFailed] = useState(false);
  // Counts attempts; an attempt owns the route while it is the latest one.
  const attempt = useRef(0);

  const open = useCallback(async () => {
    if (!__DEV__ || place === null || state === undefined || !isChatFixtureState(state)) {
      return;
    }
    attempt.current += 1;
    const mine = attempt.current;
    setFailed(false);
    try {
      const sessionId = await writeChatFixture(place, state);
      if (attempt.current === mine) {
        router.replace({ pathname: '/(app)/(tabs)/(4_chat)/[id]', params: { id: sessionId } });
      }
    } catch {
      if (attempt.current === mine) {
        setFailed(true);
      }
    }
  }, [place, router, state]);

  useEffect(() => {
    void open();
    // A new place, or leaving the route, takes the route from this attempt.
    return () => {
      attempt.current += 1;
    };
  }, [open]);

  if (!__DEV__ || state === undefined || !isChatFixtureState(state)) {
    return <Redirect href="/(app)" />;
  }
  if (failed) {
    return (
      <QueryError
        onRetry={() => {
          void open();
        }}
      />
    );
  }
  return <BootstrapLoadingSurface />;
}
