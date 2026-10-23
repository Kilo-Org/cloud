import { type Href, useRouter } from 'expo-router';
import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import Animated, { FadeIn, LinearTransition } from 'react-native-reanimated';

import { useSessionRowPress } from '@/components/agents/use-session-row-press';
import { AdaptiveHomeCardFrame } from '@/components/home/adaptive-home-card-frame';
import {
  GlanceableActiveCard,
  GlanceableActiveCardSkeleton,
} from '@/components/home/glanceable-active-card';
import {
  LiveSessionHeaderNotice,
  useLiveSessionHeaderNotice,
} from '@/components/home/live-session-header-notice';
import {
  liveSessionContent,
  type LiveSessionContext,
  type LiveSessions,
} from '@/components/home/live-session-state';
import { LiveSessionFeedback } from '@/components/home/agent-sessions-section';
import { SectionHeader } from '@/components/home/section-header';
import { selectReducedMotionEntrance, useMotionPolicy } from '@/lib/a11y/motion';
import { AGENTS_SESSIONS_HREF } from '@/lib/agents-sessions-route';

/**
 * The briefing that replaces the live card inside the shared adaptive frame.
 * Injected by the screen rather than read here, so the live-card component
 * stays free of the briefing's API and storage imports.
 */
export type HomeBriefingSlot = Readonly<{ visible: boolean; card: ReactNode }>;

export function AgentSessionsSection({
  context,
  sessions,
  briefing,
}: Readonly<{ context: LiveSessionContext; sessions: LiveSessions; briefing?: HomeBriefingSlot }>) {
  const router = useRouter();
  const { t } = useTranslation();
  const { reducedMotion } = useMotionPolicy();
  const handleRowPress = useSessionRowPress();
  const content = liveSessionContent(context, sessions);
  const failureLabel = t('home.couldNotLoadActiveSessions');
  const notice = useLiveSessionHeaderNotice(context, sessions, failureLabel);
  const showBriefing = briefing?.visible === true;
  const briefingCard = briefing?.card ?? null;

  return (
    <View>
      {/* The header row stays in every state, so settling never adds or
          removes it. `See all` keeps its box but hides while nothing runs: it
          would advertise the Agents live index for sessions that do not exist. */}
      <SectionHeader
        label={showBriefing ? t('agentBriefing.title') : t('home.agentSessions')}
        actionLabel={showBriefing ? t('agentBriefing.history') : t('home.seeAll')}
        actionHidden={!showBriefing && content === 'empty'}
        onActionPress={() => {
          if (showBriefing) {
            router.push('/(app)/agent-briefing' as Href);
            return;
          }
          // Switch tabs, then pop a previously pushed history screen to the live index.
          router.navigate(AGENTS_SESSIONS_HREF);
          router.dismissTo(AGENTS_SESSIONS_HREF);
        }}
        notice={notice && <LiveSessionHeaderNotice notice={notice} />}
      />
      <View className="mx-4 gap-2">
        <LiveSessionFeedback
          context={context}
          sessions={sessions}
          failureLabel={failureLabel}
          inlineNotices={false}
        />
        {/* One card, not a row per session. The skeleton shares the loaded
            card's minimum frame; scaled text can grow the loaded content. */}
        <Animated.View layout={LinearTransition}>
          {(briefingCard !== null ||
            content === 'pending' ||
            content === 'empty' ||
            content === 'rows') && (
            <Animated.View
              entering={selectReducedMotionEntrance(reducedMotion, FadeIn.duration(150))}
            >
              <AdaptiveHomeCardFrame
                live={
                  content === 'pending' ? (
                    <GlanceableActiveCardSkeleton embedded />
                  ) : (
                    <GlanceableActiveCard
                      sessions={sessions.activeSessions}
                      onPressSession={handleRowPress}
                      embedded
                    />
                  )
                }
                briefing={briefingCard ?? undefined}
                showBriefing={showBriefing}
              />
            </Animated.View>
          )}
        </Animated.View>
      </View>
    </View>
  );
}
