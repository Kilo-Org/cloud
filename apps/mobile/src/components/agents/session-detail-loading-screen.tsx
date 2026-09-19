import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { ScreenHeader } from '@/components/screen-header';

import { setSessionAutoApproveEnabled, useSessionAutoApproveEnabled } from './session-auto-approve';
import { SessionContextMetrics } from './session-context-metrics';
import { SessionContextSheet } from './session-context-sheet';
import { SessionComposerSkeleton, SessionSkeletonMessages } from './session-detail-skeleton';

type SessionDetailLoadingScreenProps = {
  sessionId: string;
  /**
   * The route's `?at=` anchor. The sheet's Copy link row uses it, so a link
   * copied before the transcript loads keeps the position the route holds.
   */
  anchorMessageId: string | null;
};

/**
 * The session route's metadata-pending screen. It renders the loaded header's
 * context pill — and keeps it pressable — so the context sheet, and with it the
 * session's Copy link row, stays reachable while the identity and session
 * metadata resolve. The pill keeps its size in both states, so swapping to the
 * loaded header cannot re-wrap the title.
 */
export function SessionDetailLoadingScreen({
  sessionId,
  anchorMessageId,
}: Readonly<SessionDetailLoadingScreenProps>) {
  const { t } = useTranslation();
  const [contextSheetOpen, setContextSheetOpen] = useState(false);
  // The transport is unresolved here, so this screen cannot know whether the
  // session is read-only. The auto-approve row is the same per-session setting
  // the loaded sheet owns, so both read and write the one store instead of
  // this phase inventing an availability it cannot see.
  const autoApproveEnabled = useSessionAutoApproveEnabled(sessionId);

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title={t('agentChat.session.title')}
        reserveTitleSpace
        backFallback="/(app)/(tabs)/(2_agents)"
        headerRight={
          <View className="flex-row items-center gap-2">
            <SessionContextMetrics
              info={undefined}
              totalCostMicrodollars={null}
              hasMessages={false}
              loading
              onPress={() => {
                setContextSheetOpen(true);
              }}
            />
          </View>
        }
      />
      <SessionSkeletonMessages sessionId={sessionId} />
      <SessionComposerSkeleton />
      {contextSheetOpen ? (
        <SessionContextSheet
          visible
          info={undefined}
          sessionId={sessionId}
          anchorMessageId={anchorMessageId}
          sessionTitle={t('agentChat.session.title')}
          activeSessionType={null}
          ownerConnectionId={null}
          modelDisplay=""
          providerDisplay=""
          totalCostMicrodollars={null}
          breakdownCostUsd={0}
          messages={[]}
          modelOptions={[]}
          autoApproveState={autoApproveEnabled ? 'on' : 'off'}
          onAutoApproveChange={enabled => {
            // Selection haptic for the commit: a capability iOS and Android both
            // have, served by the one cross-platform call. The loaded sheet
            // commits through the same store and the same feedback.
            void Haptics.selectionAsync();
            setSessionAutoApproveEnabled(sessionId, enabled);
          }}
          connectionDisplay="connecting"
          onRetryConnection={() => undefined}
          onClose={() => {
            setContextSheetOpen(false);
          }}
        />
      ) : null}
    </View>
  );
}
