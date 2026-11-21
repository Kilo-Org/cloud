import { briefingHasActivity } from '@kilocode/app-shared/agent-briefing';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type Href, useLocalSearchParams, useRouter } from 'expo-router';
import { type TFunction } from 'i18next';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, View } from 'react-native';
import { toast } from 'sonner-native';

import { BriefingScorecard } from './briefing-card';
import { BriefingMetadataRows } from './briefing-metadata-rows';
import { briefingSourceHref } from './briefing-session-href';
import { BriefingSessionList } from './briefing-session-list';
import { BriefingSummary } from './briefing-summary';
import { BriefingPeriodLabel } from './briefing-period-label';
import { formatBriefingTimestamp } from './briefing-window';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Section } from '@/components/ui/section';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import {
  BRIEFING_PATH,
  type BriefingReport,
  useBriefingAccess,
  useBriefingDismissals,
  useBriefingInvalidation,
} from '@/lib/agent-briefing';
import {
  briefingAccessDenied,
  briefingReportMissing,
  selectBriefingDetailPhase,
} from '@/lib/agent-briefing-state';
import { openExternalUrl } from '@/lib/external-link';
import { useOfflineBannerState } from '@/lib/hooks/use-offline-banner-state';
import { SCREEN_BODY_CLASS } from '@/lib/layout';
import { useOrganization } from '@/lib/organization-context';
import { useTRPC } from '@/lib/trpc';
import { cn } from '@/lib/utils';

const SOURCE_LABEL_KEYS = {
  activity: 'agentBriefing.sourceActivity',
  pull_request: 'common.pullRequest',
  blocker: 'agentBriefing.sourceBlocker',
  artifact: 'agentBriefing.sourceMetadata',
} as const satisfies Record<BriefingReport['sources'][number]['kind'], string>;

/**
 * The evidence under a source row: structured metadata when the payload
 * carries it, else the stored excerpt an older report still holds.
 */
function BriefingSourceDetail({
  source,
  t,
  language,
}: {
  readonly source: BriefingReport['sources'][number];
  readonly t: TFunction;
  readonly language: string;
}) {
  if (source.metadata) {
    return <BriefingMetadataRows metadata={source.metadata} t={t} language={language} />;
  }
  if (!source.excerpt) {
    return null;
  }
  return (
    <Text className="text-sm text-muted-foreground" selectable>
      {source.excerpt}
    </Text>
  );
}

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
    refetchInterval: state =>
      state.state.data?.summary.status === 'pending' ||
      state.state.data?.summary.status === 'running'
        ? 15_000
        : false,
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
  const phase = selectBriefingDetailPhase({
    hasReport: report !== undefined,
    offline,
    isPending: query.isPending,
    isError: query.isError,
    accessDenied: briefingAccessDenied(query.error),
    missing,
  });

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title={t('agentBriefing.title')}
        showBackButton
        backFallback={BRIEFING_PATH as Href}
      />
      {phase === 'loading' && (
        <View className={SCREEN_BODY_CLASS}>
          <Skeleton className="h-48 rounded-xl" />
          <Skeleton className="h-64 rounded-xl" />
        </View>
      )}
      {/* The report aged out, was deleted, or lost its sources: the copy says so
          and offers no retry that the server would answer with the same NOT_FOUND. */}
      {phase === 'missing' && <QueryError variant="not-found" />}
      {/* Connectivity pauses the first fetch instead of failing it, so the screen
          says what it is waiting for and leaves recovery to the reconnect. */}
      {phase === 'offline' && <QueryError variant="offline" title={t('offline.noInternet')} />}
      {/* The server rejected this account's access, which no retry can change. */}
      {phase === 'denied' && <QueryError variant="permission" />}
      {phase === 'failed' && (
        <QueryError
          title={t('agentBriefing.loadError')}
          variant="neutral"
          onRetry={() => {
            void query.refetch();
          }}
        />
      )}
      {phase === 'ready' && report && (
        <ScrollView
          automaticallyAdjustKeyboardInsets
          contentContainerClassName={cn(SCREEN_BODY_CLASS, 'pb-12')}
        >
          <Section>
            <View className="gap-1">
              <Text variant="heading">
                {report.context.organizationId === null
                  ? t('common.personal')
                  : report.context.name}
              </Text>
              <BriefingPeriodLabel report={report} />
              {offline || query.isError ? (
                <Text variant="caption">
                  {t(offline ? 'agentBriefing.offline' : 'agentBriefing.cached')}
                </Text>
              ) : null}
            </View>
          </Section>
          <Section>
            <Card>
              <BriefingScorecard report={report} />
            </Card>
            <Text variant="caption">{t('agentBriefing.snapshotHint')}</Text>
            {report.truncated ? (
              <Text variant="caption">{t('agentBriefing.snapshotTruncated')}</Text>
            ) : null}
            {!briefingHasActivity(report.scorecard) ? (
              <Text variant="muted">{t('agentBriefing.quietSnapshot')}</Text>
            ) : null}
          </Section>
          {!briefingHasActivity(report.scorecard) ? null : (
            <>
              <BriefingSummary report={report} />
              <BriefingSessionList report={report} />
              <Section label={t('agentBriefing.sources')}>
                {report.sources.map(source => {
                  // A stored row of a non-activity kind still carries an old
                  // server-composed English title; the kind label replaces it.
                  const label =
                    source.kind === 'activity'
                      ? (source.title ?? t(SOURCE_LABEL_KEYS.activity))
                      : t(SOURCE_LABEL_KEYS[source.kind]);
                  return (
                    <Pressable
                      key={source.id}
                      accessibilityRole="link"
                      className="active:opacity-70"
                      onPress={() => {
                        const href = briefingSourceHref(report, source);
                        if (href === null) {
                          void openExternalUrl(source.url, { label });
                          return;
                        }
                        setOrganizationId(report.context.organizationId);
                        router.push(href);
                      }}
                    >
                      <Card>
                        <Text>{label}</Text>
                        <BriefingSourceDetail source={source} t={t} language={i18n.language} />
                        <Text variant="caption">
                          {formatBriefingTimestamp(
                            source.occurredAt,
                            i18n.language,
                            report.timezone
                          )}
                        </Text>
                      </Card>
                    </Pressable>
                  );
                })}
              </Section>
            </>
          )}
          {/* The report's actions end its body: inline, never pinned above the
              content they belong to. */}
          <Section>
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
          </Section>
        </ScrollView>
      )}
    </View>
  );
}
