import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import {
  countGlanceableSessions,
  glanceableStatusKind,
} from '@kilocode/app-shared/glanceable-agents-snapshot';

import { useSessionRowPress } from '@/components/agents/use-session-row-press';
import { type LiveSessions } from '@/components/home/live-session-state';
import { SessionStatusIcon } from '@/components/ui/session-status-icon';
import { Text } from '@/components/ui/text';
import { resolveAnsweredRaises } from '@/lib/glanceable/attention-rows';
import { newestSessionTitle } from '@/lib/glanceable/newest-session';
import { glanceableCountLinesFromCounts } from '@/lib/glanceable/presentation';
import { useSessionAttentionRevision } from '@/lib/session-attention';

type LiveNowCardProps = Readonly<{ sessions: LiveSessions }>;

/**
 * The Home `Live now` summary: one card in place of the old per-session rows.
 *
 * It derives exactly what the native glanceable draws from the same tray rows
 * the section already holds: the ack-resolved ranked count lines
 * (`needsInput`, `running`, `scheduled`, `idle`) through the shared
 * `glanceableCountLinesFromCounts` rank order, and the newest session's title.
 * No query or fetch loop is added: the rows are the `activeSessions.list`
 * cache the section passes in, so live socket writes and the foreground
 * refresh repaint the card the moment the cache changes.
 *
 * The whole card opens the highest-ranked session the card leads with, so a
 * glance's most actionable state is one tap away; the section header keeps
 * `See all` for the full Agents index.
 */
export function LiveNowCard({ sessions }: LiveNowCardProps) {
  const { t } = useTranslation();
  const handleRowPress = useSessionRowPress();
  // The ack store is the one input that is not the rows: answering a raise
  // bumps the shared revision, so the counts and the card re-derive when an
  // ack resolves.
  const attentionRevision = useSessionAttentionRevision();
  const resolvedSessions = useMemo(
    () => resolveAnsweredRaises(sessions.activeSessions),
    // eslint-disable-next-line react/exhaustive-deps -- `resolveAnsweredRaises` reads the ack store, so the revision is a real input.
    [sessions.activeSessions, attentionRevision]
  );
  // Non-zero lines only: the card is the whole glance, so an empty state row
  // ("0 Idle") would be noise. Rank order still decides which states show.
  const countLines = useMemo(
    () =>
      glanceableCountLinesFromCounts(countGlanceableSessions(resolvedSessions)).filter(
        line => line.count > 0
      ),
    [resolvedSessions]
  );
  const newestTitle = useMemo(() => newestSessionTitle(resolvedSessions), [resolvedSessions]);
  // The primary row is the highest-ranked state the card leads with, not the
  // first row in tray order: a session that needs input outranks one that is
  // merely working, so the tap lands on what the user must act on.
  const primarySession = useMemo(() => {
    const primaryKind = countLines[0]?.kind;
    return (
      (primaryKind === undefined
        ? undefined
        : resolvedSessions.find(session => glanceableStatusKind(session.status) === primaryKind)) ??
      resolvedSessions[0] ??
      null
    );
  }, [countLines, resolvedSessions]);

  const spokenCounts = countLines.map(line => `${line.count} ${t(line.key)}`).join(', ');
  const spokenNewest =
    newestTitle === null ? null : t('glanceable.newestSession', { title: newestTitle });
  const accessibilityLabel =
    [spokenCounts, spokenNewest].filter(Boolean).join(', ') || t('home.agentSessions');

  return (
    <Pressable
      onPress={() => {
        if (primarySession !== null) {
          handleRowPress(primarySession);
        }
      }}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      className="active:opacity-70"
    >
      <View className="min-h-[72px] justify-center gap-2 rounded-2xl border border-border bg-card px-4 py-3">
        <View className="flex-row flex-wrap items-center gap-x-4 gap-y-1">
          {countLines.map(line => (
            <View key={line.kind} className="flex-row items-center gap-1.5">
              <SessionStatusIcon kind={line.kind} />
              <Text className="text-sm font-semibold text-foreground">{String(line.count)}</Text>
              <Text variant="muted" className="text-sm">
                {t(line.key)}
              </Text>
            </View>
          ))}
        </View>
        {spokenNewest !== null && (
          <Text variant="muted" className="text-xs" numberOfLines={1} ellipsizeMode="tail">
            {spokenNewest}
          </Text>
        )}
      </View>
    </Pressable>
  );
}
