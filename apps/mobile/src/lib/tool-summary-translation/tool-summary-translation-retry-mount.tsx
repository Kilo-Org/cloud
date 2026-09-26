import { useEffect } from 'react';
import { Linking } from 'react-native';

import { useUserWebConnection } from '@/components/agents/user-web-connection-provider';

import { retryUnresolvedTranslations } from './tool-summary-translation-runtime';

/**
 * Re-queue failed tool-summary translations when the app gets another chance
 * to reach the gateway. Two moments qualify, and neither is a tap on the
 * transcript:
 *
 * - the session transport's down-to-up edge: a real outage ended, so the
 *   summaries whose batches failed during it can resolve now;
 * - a delivered deep link: re-entering an already-mounted transcript is a
 *   navigation no-op, so its rows never remount and nothing would otherwise
 *   re-request the work that failed while the gateway was unreachable. The
 *   link is the user coming back to look, so the remembered work goes back
 *   through the normal batch path.
 *
 * Both are idempotent: `retryUnresolvedTranslations` re-queues only what never
 * resolved, and `takeBatch` drops keys a request already owns, so a retry
 * during a still-failing gateway costs exactly one batch, not a storm.
 * Renders nothing.
 */
export function ToolSummaryTranslationRetryMount(): null {
  const connection = useUserWebConnection();
  useEffect(() => {
    let wasConnected = connection.isConnected();
    return connection.onConnectionChange(() => {
      const connected = connection.isConnected();
      if (connected && !wasConnected) {
        retryUnresolvedTranslations();
      }
      wasConnected = connected;
    });
  }, [connection]);
  useEffect(() => {
    const subscription = Linking.addEventListener('url', () => {
      retryUnresolvedTranslations();
    });
    return () => {
      subscription.remove();
    };
  }, []);
  return null;
}
