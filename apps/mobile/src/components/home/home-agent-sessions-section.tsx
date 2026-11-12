import { type Href, useRouter } from 'expo-router';
import { type ReactNode, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import Animated, { FadeIn, LinearTransition } from 'react-native-reanimated';

import { type GlanceableStatusKind } from '@kilocode/app-shared/glanceable-agents-snapshot';

import { AGENTS_SESSIONS_INDEX_HREF } from '@/lib/agents-sessions-route';
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
import { LiveSessionsCardFailure } from '@/components/home/home-sessions-failure-card';
import { SectionHeader } from '@/components/home/section-header';
import { selectReducedMotionEntrance, useMotionPolicy } from '@/lib/a11y/motion';

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
  // A whole-surface failure draws inside the card frame, in the height the
  // frame already reserved while the query was pending, so the sections below
  // the card do not move when the load fails after the first paint.
  const failureInCard = content === 'error';
  const briefingCard = briefing?.card ?? null;
  // Open the Agents tab, with the status filter a count row names. Same tab
  // switch and stack reset as `See all`, so a pushed history screen cannot hide
  // the filtered list. `See all` passes no status, which clears any filter a
  // previous tap left on the route.
  const openAgentsIndex = useCallback(
    (status?: GlanceableStatusKind) => {
      // An object href replaces the route params. A bare string would keep a
      // status param a previous tap left behind, so See all clears them.
      const href: Href = status
        ? { pathname: '/(app)/(tabs)/(2_agents)/', params: { status } }
        : AGENTS_SESSIONS_INDEX_HREF;
      router.navigate(href);
      router.dismissTo(href);
    },
    [router]
  );
  // The card's one drawn body. A failure takes the slot instead of a block
  // above it, so the frame keeps the height it reserved while pending.
  const cardBody = (): ReactNode => {
    if (failureInCard) {
      return (
        <LiveSessionsCardFailure
          context={context}
          sessions={sessions}
          failureLabel={failureLabel}
        />
      );
    }
    if (content === 'pending') {
      return <GlanceableActiveCardSkeleton embedded />;
    }
    return (
      <GlanceableActiveCard
        sessions={sessions.activeSessions}
        onPressSession={handleRowPress}
        onPressStatus={openAgentsIndex}
        embedded
      />
    );
  };

  return (
    <View>
      {/* The header row stays in every state, so settling never adds or
          removes it. `See all` keeps its box but hides while nothing runs: it
          would advertise the Agents live index for sessions that do not exist. */}
      <SectionHeader
        label={showBriefing ? t('agentBriefing.title') : t('home.agentSessions')}
        actionLabel={showBriefing ? t('agentBriefing.history') : t('home.seeAll')}
        actionHidden={!showBriefing && content === 'empty'}
        reserveLabelAir
        onActionPress={() => {
          if (showBriefing) {
            router.push('/(app)/agent-briefing' as Href);
            return;
          }
          openAgentsIndex();
        }}
        notice={notice && <LiveSessionHeaderNotice notice={notice} />}
      />
      <View className="mx-4 gap-2">
        <LiveSessionFeedback
          context={context}
          sessions={sessions}
          failureLabel={failureLabel}
          inlineNotices={false}
          bodyHidden={failureInCard}
        />
        {/* One card, not a row per session. The skeleton shares the loaded
            card's minimum frame; scaled text can grow the loaded content. */}
        <Animated.View layout={LinearTransition}>
          {(briefingCard !== null ||
            content === 'pending' ||
            content === 'empty' ||
            content === 'rows' ||
            failureInCard) && (
            <Animated.View
              entering={selectReducedMotionEntrance(reducedMotion, FadeIn.duration(150))}
            >
              <AdaptiveHomeCardFrame
                live={cardBody()}
                briefing={briefingCard ?? undefined}
                showBriefing={showBriefing && !failureInCard}
              />
            </Animated.View>
          )}
        </Animated.View>
      </View>
    </View>
  );
}
