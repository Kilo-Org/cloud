import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { RemoteSessionRow } from '@/components/agents/remote-session-row';
import { useAgentSessionNavigator } from '@/components/agents/use-agent-session-navigator';
import { buildActiveAgentsCardModel } from '@/components/home/active-agents-card-model';
import { Text } from '@/components/ui/text';
import { useNowTicker } from '@/lib/hooks/use-now-ticker';
import { type ActiveSession } from '@/lib/hooks/use-agent-sessions';
import { useSessionAttentionRevision } from '@/lib/session-attention';
import { cn, parseTimestamp, timeAgo } from '@/lib/utils';

type ActiveAgentsCardProps = {
  /** Org-scoped live rows from the shared `activeSessions.list` cache. */
  sessions: readonly ActiveSession[];
  organizationId: string | null;
};

export function ActiveAgentsCard({ sessions, organizationId }: Readonly<ActiveAgentsCardProps>) {
  const { t } = useTranslation();
  const navigateToSession = useAgentSessionNavigator();
  const attentionRevision = useSessionAttentionRevision();
  // The relative wait and newest-result labels must be traced to a clock
  // (see `timeAgo`), so the card owns one shared tick.
  const now = useNowTicker(10_000);
  const model = useMemo(
    () => buildActiveAgentsCardModel(sessions),
    // eslint-disable-next-line react/exhaustive-deps -- the revision is a real input: `resolveAnsweredRaises` reads the ack store, so an ack must re-derive the counts and the relevant session.
    [sessions, attentionRevision]
  );

  if (model.relevantSession === null) {
    return (
      <View className="min-h-[72px] items-center justify-center rounded-2xl border border-border bg-card px-4">
        <Text variant="muted" className="text-sm">
          {t('home.noLiveSessions')}
        </Text>
      </View>
    );
  }

  const newestResultLine = model.countLines.find(line => line.kind === model.newestResultKind);

  return (
    <View className="overflow-hidden rounded-2xl border border-border bg-card">
      <View className="gap-2 px-4 py-3">
        {model.countLines.map(line => {
          // Only the highest-ranked non-zero count is emphasized; the native
          // glanceable ranks its rows the same way, so a zero needs-input row
          // stays muted instead of wearing the warning amber that is reserved
          // for an agent actually waiting on the user.
          const isPrimary = line.kind === model.primaryCountKind;
          return (
            <View key={line.key} className="flex-row items-baseline justify-between gap-2">
              {/* The label owns the flexible space and truncates in place, the
                  same way the native glanceable bounds its label. The trailing
                  cluster sizes to its content and never shrinks, so the wait
                  time and count stay whole instead of running past the card's
                  overflow-hidden edge at a large font scale or with a longer
                  localized label. */}
              <Text
                className={cn(
                  'min-w-0 flex-1 text-sm',
                  !isPrimary && 'text-muted-foreground',
                  isPrimary && line.kind === 'needsInput' && 'text-warn',
                  isPrimary && line.kind !== 'needsInput' && 'text-foreground'
                )}
                numberOfLines={1}
                ellipsizeMode="tail"
              >
                {t(line.key)}
              </Text>
              <View className="shrink-0 flex-row items-baseline gap-2">
                {line.kind === 'needsInput' && model.needsInputSince ? (
                  <Text variant="muted" className="text-xs" numberOfLines={1} ellipsizeMode="tail">
                    {timeAgo(parseTimestamp(model.needsInputSince), undefined, now)}
                  </Text>
                ) : null}
                <Text
                  className="text-sm font-medium text-foreground"
                  numberOfLines={1}
                  ellipsizeMode="tail"
                >
                  {line.count}
                </Text>
              </View>
            </View>
          );
        })}
        {model.newestTitle ? (
          <Text variant="muted" className="text-xs" numberOfLines={1}>
            {t('glanceable.newestSession', { title: model.newestTitle })}
          </Text>
        ) : null}
        {newestResultLine && model.newestResultAt ? (
          <Text variant="muted" className="text-xs" numberOfLines={1}>
            {t('glanceable.newestResult')}: {t(newestResultLine.key)} ·{' '}
            {timeAgo(parseTimestamp(model.newestResultAt), undefined, now)}
          </Text>
        ) : null}
      </View>
      <View className="border-t-[0.5px] border-hair-soft">
        <RemoteSessionRow
          session={model.relevantSession}
          variant="card"
          interactive={false}
          onPress={(session: ActiveSession) => {
            navigateToSession(session.id, organizationId);
          }}
        />
      </View>
    </View>
  );
}
