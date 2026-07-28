import { useState } from 'react';
import { Pressable, View } from 'react-native';
import Animated, {
  FadeIn,
  FadeOut,
  LinearTransition,
  useReducedMotion,
} from 'react-native-reanimated';

import { RemoteSessionRow } from '@/components/agents/remote-session-row';
import { SessionListSectionHeader } from '@/components/agents/session-list-section-header';
import { ACTIVE_NOW_TRAY_CAP, selectTrayWindow } from '@/components/agents/active-now-window';
import { Text } from '@/components/ui/text';
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
 * The tray caps the visible rows at `ACTIVE_NOW_TRAY_CAP` while collapsed
 * and exposes a `+N more` expander when more sessions are pinned. Expansion
 * is local `useState` (no persistence — resets on unmount). The list keeps
 * a single SectionList mount across loading → rows so this state is not
 * wiped when skeletons are replaced by real sections.
 */
export function ActiveNowSection({
  pinned,
  organizationIdBySessionId,
  onSessionPress,
}: Readonly<ActiveNowSectionProps>) {
  const [expanded, setExpanded] = useState(false);
  const reducedMotion = useReducedMotion();

  if (pinned.length === 0) {
    return null;
  }

  const { visible, hiddenCount } = selectTrayWindow(pinned, expanded, ACTIVE_NOW_TRAY_CAP);

  return (
    <Animated.View
      entering={FadeIn.duration(180)}
      exiting={FadeOut.duration(120)}
      layout={reducedMotion ? undefined : LinearTransition}
      className="bg-background"
    >
      <SessionListSectionHeader title="Active now" count={pinned.length} />
      {visible.map(session => (
        <AnimatedRow
          key={session.id}
          reducedMotion={reducedMotion}
          session={session}
          onPress={() => {
            onSessionPress(session.id, organizationIdBySessionId.get(session.id));
          }}
        />
      ))}
      {hiddenCount > 0 && (
        <Animated.View
          entering={reducedMotion ? undefined : FadeIn.duration(120)}
          exiting={reducedMotion ? undefined : FadeOut.duration(120)}
          layout={reducedMotion ? undefined : LinearTransition}
        >
          <Pressable
            onPress={() => {
              setExpanded(prev => !prev);
            }}
            accessibilityRole="button"
            accessibilityLabel={
              expanded ? 'Show fewer active sessions' : `${hiddenCount} more active sessions`
            }
            hitSlop={8}
            className="min-h-[44px] items-center justify-center px-[22px] py-2 active:opacity-70"
          >
            <Text variant="mono" className="text-[10px] uppercase tracking-[1.5px] text-primary">
              {expanded ? 'Show less' : `+${hiddenCount} more`}
            </Text>
          </Pressable>
        </Animated.View>
      )}
    </Animated.View>
  );
}

/**
 * Per-row wrapper that fades individual rows in/out while the tray is
 * animating expansion. Under `useReducedMotion()` the entering/exiting
 * row animations are suppressed AND the tray/expander layout transition
 * is omitted so rows appear instantly; the expand/collapse still works
 * functionally.
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
