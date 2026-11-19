import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';

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
 * Link: `kiloapp:///dev/chat-fixture/<empty|failed|credits|long>`, mapped in
 * `src/app/+native-intent.tsx`. A release build redirects away.
 */
export default function ChatFixtureRoute() {
  const { state } = useLocalSearchParams<{ state?: string }>();
  const router = useRouter();
  const place = useChatPlace();
  const [failed, setFailed] = useState(false);

  const open = useCallback(async () => {
    if (!__DEV__ || place === null || state === undefined || !isChatFixtureState(state)) {
      return;
    }
    setFailed(false);
    try {
      const sessionId = await writeChatFixture(place, state);
      router.replace({ pathname: '/(app)/(tabs)/(4_chat)/[id]', params: { id: sessionId } });
    } catch {
      setFailed(true);
    }
  }, [place, router, state]);

  useEffect(() => {
    void open();
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
