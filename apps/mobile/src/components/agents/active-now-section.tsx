import { View } from 'react-native';

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
 * pinned above the list).
 *
 * The tray and its rows mount and unmount atomically: there are no entering,
 * exiting, or layout animations. A session moving between history and the
 * tray therefore swaps in the same commit its twin is excluded or
 * reinserted — no fade overlap against the instant virtualized-row removal,
 * and no ~120 ms exiting native node that would duplicate the reinserted
 * history row for screen readers. `maintainVisibleContentPosition` on the
 * SectionList keeps the remaining rows anchored.
 *
 * The tray renders one row per pinned session. There is no cap and no
 * expander: the user asked for the full list.
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
    <View testID="agents-active-now-section" className="bg-background">
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
    </View>
  );
}
