import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type Href, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, View } from 'react-native';
import { toast } from 'sonner-native';

import { briefingMoney, BriefingScorecard } from './briefing-card';
import { BriefingSummary } from './briefing-summary';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import {
  BRIEFING_PATH,
  useBriefingAccess,
  useBriefingDismissals,
  useBriefingInvalidation,
} from '@/lib/agent-briefing';
import { briefingAccessDenied, briefingReportMissing } from '@/lib/agent-briefing-state';
import { openExternalUrl } from '@/lib/external-link';
import { formatDate } from '@/lib/format';
import { useOfflineBannerState } from '@/lib/hooks/use-offline-banner-state';
import { useOrganization } from '@/lib/organization-context';
import { useTRPC } from '@/lib/trpc';
import { parseTimestamp } from '@/lib/utils';

const BRIEFING_DATE_TIME: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' };

export function BriefingDetailScreen() {
  const { 'report-id': reportId } = useLocalSearchParams<{ 'report-id': string }>();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const router = useRouter();
  const { t, i18n } = useTranslation();
  const { setOrganizationId } = useOrganization();
  const access = useBriefingAccess();
  const offline = useOfflineBannerState();
  const dismissals = useBriefingDismissals();
  const [goneReportId, setGoneReportId] = useState<string | null>(null);
  const gone = goneReportId === reportId;
  const query = useQuery({
    ...trpc.agentBriefing.get.queryOptions({ reportId }),
    enabled: access.enabled && Boolean(reportId) && !gone,
    refetchInterval: 15_000,
    retry: (failureCount, error) => !briefingReportMissing(error) && failureCount < 3,
  });
  useBriefingInvalidation(query.error);
  const missing = gone || briefingReportMissing(query.error);
  useEffect(() => {
    if (!briefingReportMissing(query.error) || gone) {
      return;
    }
    setGoneReportId(reportId);
    queryClient.removeQueries({
      queryKey: trpc.agentBriefing.get.queryKey({ reportId }),
      exact: true,
    });
  }, [gone, query.error, queryClient, reportId, trpc]);
  const report =
    !missing &&
    query.data &&
    !briefingAccessDenied(query.error) &&
    access.canRead(query.data.context.organizationId)
      ? query.data
      : undefined;
  const read = useMutation(
    trpc.agentBriefing.read.mutationOptions({
      onError: () => {
        toast.error(t('common.somethingWentWrong'));
      },
    })
  );
  const marked = useRef<string | null>(null);
  useEffect(() => {
    if (!report || offline || report.readAt || marked.current === report.id) {
      return;
    }
    marked.current = report.id;
    read.mutate({ reportId: report.id });
  }, [offline, read, report]);
  const loading = !report && !missing && query.isPending && !offline;
  const failure = !report && !loading;

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title={t('agentBriefing.title')}
        showBackButton
        backFallback={BRIEFING_PATH as Href}
      />
      {loading && (
        <View className="gap-4 p-4">
          <Skeleton className="h-48 rounded-2xl" />
          <Skeleton className="h-64 rounded-2xl" />
        </View>
      )}
      {failure && missing && <QueryError variant="not-found" />}
      {failure && !missing && (
        <QueryError
          title={t('agentBriefing.loadError')}
          variant={briefingAccessDenied(query.error) ? 'permission' : 'neutral'}
          onRetry={() => {
            void query.refetch();
          }}
        />
      )}
      {report && (
        <ScrollView automaticallyAdjustKeyboardInsets contentContainerClassName="gap-4 p-4 pb-12">
          <View className="gap-1">
            <Text className="text-lg font-semibold">
              {report.context.organizationId === null ? t('common.personal') : report.context.name}
            </Text>
            <Text className="text-sm text-muted-foreground">{report.localDate}</Text>
            <Text className="text-xs text-muted-foreground">
              {t('agentBriefing.window', {
                start: formatDate(
                  parseTimestamp(report.nightStartAt),
                  i18n.language,
                  BRIEFING_DATE_TIME
                ),
                end: formatDate(parseTimestamp(report.cutoffAt), i18n.language, BRIEFING_DATE_TIME),
              })}
            </Text>
            {report.revised ? (
              <Text className="text-xs text-muted-foreground">
                {t('agentBriefing.revised', { revision: report.revision })}
              </Text>
            ) : null}
            {offline || query.isError ? (
              <Text className="text-xs text-muted-foreground">
                {t(offline ? 'agentBriefing.offline' : 'agentBriefing.cached')}
              </Text>
            ) : null}
          </View>
          <View className="overflow-hidden rounded-2xl border border-border bg-card">
            <BriefingScorecard report={report} />
          </View>
          {Object.values(report.coverage).some(value => value !== 'complete') ? (
            <Text className="text-xs text-muted-foreground">{t('agentBriefing.coverageHint')}</Text>
          ) : null}
          <BriefingSummary report={report} />
          <View className="gap-2">
            <Text className="font-semibold">{t('common.agents')}</Text>
            {report.sessions.map(session => {
              let spend = t('common.unknown');
              if (
                report.coverage.spend !== 'unavailable' &&
                (report.coverage.spend === 'complete' || session.spendMicrodollars > 0)
              ) {
                const amount = briefingMoney(session.spendMicrodollars, i18n.language);
                spend =
                  report.coverage.spend === 'complete'
                    ? amount
                    : t('agentBriefing.atLeast', { value: amount });
              }
              return (
                <Pressable
                  key={session.sessionId}
                  accessibilityRole="button"
                  className="gap-1 rounded-xl border border-border bg-card p-4 active:opacity-70"
                  onPress={() => {
                    setOrganizationId(report.context.organizationId);
                    router.push(
                      `/(app)/agent-chat/${encodeURIComponent(session.sessionId)}` as Href
                    );
                  }}
                >
                  <Text>{session.title || t('agents.sessionRow.untitled')}</Text>
                  <Text className="text-xs text-muted-foreground">{spend}</Text>
                </Pressable>
              );
            })}
          </View>
          <View className="gap-2">
            <Text className="font-semibold">{t('agentBriefing.sources')}</Text>
            {report.sources.map(source => (
              <Pressable
                key={source.id}
                accessibilityRole="link"
                className="gap-1 rounded-xl border border-border bg-card p-4 active:opacity-70"
                onPress={() => {
                  if (
                    source.kind === 'activity' ||
                    source.kind === 'cost' ||
                    source.kind === 'blocker'
                  ) {
                    const rootId =
                      report.sessions.find(session =>
                        session.sources.some(entry => entry.id === source.id)
                      )?.sessionId ?? source.sessionId;
                    setOrganizationId(report.context.organizationId);
                    router.push(`/(app)/agent-chat/${encodeURIComponent(rootId)}` as Href);
                  } else {
                    void openExternalUrl(source.url, { label: source.title });
                  }
                }}
              >
                <Text className="text-sm">{source.title}</Text>
                <Text className="text-xs text-muted-foreground">
                  {formatDate(parseTimestamp(source.occurredAt), i18n.language, BRIEFING_DATE_TIME)}
                </Text>
              </Pressable>
            ))}
          </View>
          <Button
            variant="outline"
            onPress={() => {
              dismissals.dismiss(report);
              router.back();
            }}
          >
            <Text>{t('agentBriefing.dismiss')}</Text>
          </Button>
          <Button
            variant="ghost"
            onPress={() => {
              router.push(`${BRIEFING_PATH}/settings` as Href);
            }}
          >
            <Text>{t('agentBriefing.settings')}</Text>
          </Button>
        </ScrollView>
      )}
    </View>
  );
}
