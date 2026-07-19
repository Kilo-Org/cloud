import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';

import { RemoteSessionRow } from '@/components/agents/session-row';
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
 * Pinned "Active now" tray for the Agents session list. Renders above the
 * history list. The section never scrolls itself — it sits inside the
 * screen's non-scrolling vertical layout so it animates in/out with
 * Reanimated `FadeIn`/`FadeOut` while the screen's `LinearTransition`
 * wrappers absorb the layout change without jumping the history list.
 */
export function ActiveNowSection({
  pinned,
  organizationIdBySessionId,
  onSessionPress,
}: Readonly<ActiveNowSectionProps>) {
  if (pinned.length === 0) {
    return null;
  }

  return (
    <Animated.View
      entering={FadeIn.duration(180)}
      exiting={FadeOut.duration(120)}
      className="bg-background"
    >
      <SessionListSectionHeader title="Active now" count={pinned.length} />
      {pinned.map(session => (
        <RemoteSessionRow
          key={session.id}
          session={session}
          onPress={() => {
            onSessionPress(session.id, organizationIdBySessionId.get(session.id));
          }}
        />
      ))}
    </Animated.View>
  );
}
