import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { briefingSessionHref } from './briefing-session-href';
import { Text } from '@/components/ui/text';
import { type BriefingReport } from '@/lib/agent-briefing';
import { briefingMoney } from '@/lib/agent-briefing-format';
import { useOrganization } from '@/lib/organization-context';

export function BriefingSessionList({ report }: Readonly<{ report: BriefingReport }>) {
  const router = useRouter();
  const { t, i18n } = useTranslation();
  const { setOrganizationId } = useOrganization();
  const shownSessions = report.sessions.length;
  const totalSessions = shownSessions + (report.omittedCollectedSessions ?? 0);
  return (
    <View className="gap-2">
      <Text className="font-semibold">{t('common.agents')}</Text>
      {report.sessions.map(session => {
        const coverage = report.coverage.spend;
        const lowerBound =
          coverage !== 'complete' && coverage !== 'unavailable' && session.spendMicrodollars > 0;
        let spend = t('common.unknown');
        if (
          coverage !== 'unavailable' &&
          (coverage === 'complete' || session.spendMicrodollars > 0)
        ) {
          const amount = briefingMoney(session.spendMicrodollars, i18n.language, { lowerBound });
          spend = lowerBound ? t('agentBriefing.atLeast', { value: amount }) : amount;
        }
        const shownItems = session.sources.length;
        const totalItems = shownItems + (session.omittedSources ?? 0);
        return (
          <Pressable
            key={session.sessionId}
            accessibilityRole="button"
            className="gap-1 rounded-xl border border-border bg-card p-4 active:opacity-70"
            onPress={() => {
              setOrganizationId(report.context.organizationId);
              router.push(briefingSessionHref(report, session.sessionId));
            }}
          >
            <Text>{session.title || t('agents.sessionRow.untitled')}</Text>
            <Text className="text-xs text-muted-foreground">{spend}</Text>
            {totalItems > shownItems ? (
              <Text className="text-xs text-muted-foreground">
                {t('agentBriefing.itemsShown', {
                  count: totalItems,
                  shown: shownItems,
                  total: totalItems,
                })}
              </Text>
            ) : null}
          </Pressable>
        );
      })}
      {totalSessions > shownSessions ? (
        <Text className="text-xs text-muted-foreground">
          {t('agentBriefing.sessionsShown', {
            count: totalSessions,
            shown: shownSessions,
            total: totalSessions,
          })}
        </Text>
      ) : null}
    </View>
  );
}
