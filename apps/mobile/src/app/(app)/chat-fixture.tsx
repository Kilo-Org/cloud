import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect } from 'react';

import { BootstrapLoadingSurface } from '@/components/bootstrap-loading-surface';
import { isChatFixtureState, writeChatFixture } from '@/lib/chat/chat-fixture';
import { useChatPlace } from '@/lib/chat/use-chat';

/**
 * Development-only entry for one chat conversation in a fixed state: it writes
 * the device records of `src/lib/chat/chat-fixture.ts` for the signed-in place,
 * then replaces itself with the real conversation route, so the gate measures
 * `(app)/(tabs)/(4_chat)/[id]` itself.
 *
 * Link: `kiloapp:///dev/chat-fixture/<empty|failed|credits|long>`, mapped in
 * `src/app/+native-intent.tsx`. A release build redirects away.
 */
export default function ChatFixtureRoute() {
  const { state } = useLocalSearchParams<{ state?: string }>();
  const router = useRouter();
  const place = useChatPlace();

  useEffect(() => {
    if (__DEV__ && place !== null && state !== undefined && isChatFixtureState(state)) {
      const open = async () => {
        const sessionId = await writeChatFixture(place, state);
        router.replace({ pathname: '/(app)/(tabs)/(4_chat)/[id]', params: { id: sessionId } });
      };
      void open();
    }
  }, [place, router, state]);

  if (!__DEV__ || state === undefined || !isChatFixtureState(state)) {
    return <Redirect href="/(app)" />;
  }
  return <BootstrapLoadingSurface />;
}
