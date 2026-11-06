import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { SessionContextSheet } from '@/components/agents/session-context-sheet';
import { i18n } from '@/i18n';

/**
 * The session context sheet, rendered on its own for the design gate. The real
 * sheet is a native panel over a live session, so a link opens this route
 * instead: the panel sits on owned sample data and reports no usage (`info`
 * undefined), the state a session holds until it first reports. Its model and
 * provider come pre-resolved from the session screen, the way
 * `session-detail-content` passes them.
 *
 * Use the dev context-sheet fixture link to open it. Closing is inert: the
 * fixture is a measuring surface, not a session.
 */
export function SessionContextSheetFixture() {
  const [prepared, setPrepared] = useState(false);
  useEffect(() => {
    async function prepare() {
      await i18n.changeLanguage(i18n.language);
      setPrepared(true);
    }
    void prepare();
  }, []);
  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top', 'left', 'right', 'bottom']}>
      <View className="flex-1">
        {prepared ? (
          <SessionContextSheet
            visible
            info={undefined}
            sessionId="fixture-context-sheet-session"
            anchorMessageId={null}
            sessionTitle="Context sheet fixture"
            activeSessionType="read-only"
            ownerConnectionId={null}
            modelDisplay="DeepSeek V4.1 Flash 1017"
            providerDisplay="Kilo"
            totalCostMicrodollars={null}
            breakdownCostUsd={0}
            messages={[]}
            modelOptions={[]}
            autoApproveState="unavailable"
            onAutoApproveChange={() => undefined}
            onClose={() => undefined}
            connectionDisplay="connected"
            onRetryConnection={() => undefined}
          />
        ) : null}
      </View>
    </SafeAreaView>
  );
}
