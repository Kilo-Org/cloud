import { View } from 'react-native';
import Animated, {
  FadeIn,
  FadeOut,
  LinearTransition,
  useReducedMotion,
} from 'react-native-reanimated';

import { RemoteSessionRow } from '@/components/agents/remote-session-row';
import { SessionListSectionHeader } from '@/components/agents/session-list-section-header';
import { type ActiveSession } from '@/lib/hooks/use-agent-sessions';

type ActiveNowSectionProps = {
  /** Pinned sessions. The section renders `null` when empty. */
  pinned: ActiveSession[];
  /**
   * Organization id for each session id, when one is known from the stored
   * pages. Tray rows that also live in history reuse the stored org id so
   * navigation stays in the user's org context.
   */
  organizationIdBySessionId: Map<string, string | null | undefined>;
  onSessionPress: (sessionId: string, organizationId?: string | null) => void;
};

/**
 * Pinned "Active now" tray for the Agents session list. Rendered as the
 * history `SectionList`'s `ListHeaderComponent`, so it scrolls with the
 * session history in one continuous gesture (search/filter chrome stays
 * pinned above the list). `ListHeaderComponent` is not a virtualized cell,
 * so Reanimated `FadeIn`/`FadeOut`/`LinearTransition` wrappers on the tray
 * and its rows keep working.
 *
 * The tray renders one row per pinned session. There is no cap and no
 * expander: the user asked for the full list.
 */
export function ActiveNowSection({
  pinned,
  organizationIdBySessionId,
  onSessionPress,
}: Readonly<ActiveNowSectionProps>) {
  const reducedMotion = useReducedMotion();

  if (pinned.length === 0) {
    return null;
  }

  return (
    <Animated.View
      entering={FadeIn.duration(180)}
      exiting={FadeOut.duration(120)}
      layout={reducedMotion ? undefined : LinearTransition}
      className="bg-background"
    >
      <SessionListSectionHeader title="Active now" count={pinned.length} />
      {pinned.map(session => (
        <AnimatedRow
          key={session.id}
          reducedMotion={reducedMotion}
          session={session}
          onPress={() => {
            onSessionPress(session.id, organizationIdBySessionId.get(session.id));
          }}
        />
      ))}
    </Animated.View>
  );
}

/**
 * Per-row wrapper that fades individual rows in/out while the tray is
 * animating. Under `useReducedMotion()` the entering/exiting row animations
 * are suppressed so rows appear instantly.
 */
function AnimatedRow({
  reducedMotion,
  session,
  onPress,
}: Readonly<{
  reducedMotion: boolean | null;
  session: ActiveSession;
  onPress: () => void;
}>) {
  if (reducedMotion) {
    return (
      <View>
        <RemoteSessionRow session={session} onPress={onPress} />
      </View>
    );
  }
  return (
    <Animated.View entering={FadeIn.duration(120)} exiting={FadeOut.duration(120)}>
      <RemoteSessionRow session={session} onPress={onPress} />
    </Animated.View>
  );
}
