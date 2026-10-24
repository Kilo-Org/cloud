import { type Href, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { DirectionalChevronRight } from '@/components/ui/directional-icons';
import { X } from '@/components/ui/icons';
import { IconButton } from '@/components/ui/icon-button';
import { Text } from '@/components/ui/text';
import {
  BRIEFING_PATH,
  type BriefingReport,
  useBriefingDismissals,
  useBriefings,
} from '@/lib/agent-briefing';
import { useNowTicker } from '@/lib/hooks/use-now-ticker';
import { useOfflineBannerState } from '@/lib/hooks/use-offline-banner-state';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useOrganization } from '@/lib/organization-context';
import { briefingSummaryStatusKey, visibleHomeBriefing } from '@/lib/agent-briefing-state';
import { briefingMoney } from '@/lib/agent-briefing-format';
import { cn } from '@/lib/utils';
import { formatCalendarDate, formatNumber } from '@/lib/format';

export function BriefingScorecard({ report }: { readonly report: BriefingReport }) {
  const { t, i18n } = useTranslation();
  const rows = [
    {
      label: t(
        report.kind === 'one_off' ? 'agentBriefing.periodSessions' : 'agentBriefing.sessions'
      ),
      amount: report.scorecard.sessions,
      coverage: report.coverage.activity,
    },
    {
      label: t('agentBriefing.pullRequests'),
      amount: report.scorecard.pullRequests,
      coverage: report.coverage.pullRequests,
    },
    {
      label: t('agentBriefing.blockers'),
      amount: report.scorecard.blockers,
      coverage: report.coverage.blockers,
    },
    {
      label: t(report.kind === 'one_off' ? 'agentBriefing.periodSpend' : 'agentBriefing.spend'),
      amount: report.scorecard.spendMicrodollars,
      coverage: report.coverage.spend,
      money: true,
    },
  ];
  return (
    <View className="gap-2 px-4 py-3">
      {rows.map(row => {
        const lowerBound =
          row.coverage !== 'complete' && row.amount > 0 && row.coverage !== 'unavailable';
        let value = t('common.unknown');
        if (row.coverage !== 'unavailable' && (row.coverage === 'complete' || row.amount > 0)) {
          value = row.money
            ? briefingMoney(row.amount, i18n.language, { lowerBound })
            : formatNumber(row.amount, i18n.language);
        }
        const displayValue = lowerBound ? t('agentBriefing.atLeast', { value }) : value;
        return (
          <View key={row.label} className="min-h-6 flex-row items-center gap-2">
            <Text className="text-sm font-semibold text-foreground">{displayValue}</Text>
            <Text numberOfLines={1} className="min-w-0 shrink text-sm text-muted-foreground">
              {row.label}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

export function useHomeBriefing() {
  const { organizationId, isLoaded } = useOrganization();
  const query = useBriefings(organizationId);
  const dismissals = useBriefingDismissals();
  const now = useNowTicker(10_000);
  return {
    briefing:
      isLoaded && dismissals.isSuccess
        ? visibleHomeBriefing(query.reports, organizationId, {
            dismissedReportIds: dismissals.data.map(item => item.reportId),
            now,
          })
        : undefined,
    frameReport: isLoaded ? query.reports.find(report => report.kind !== 'one_off') : undefined,
  };
}

export function BriefingCard({
  report,
  embedded = false,
}: {
  readonly report: BriefingReport;
  readonly embedded?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const offline = useOfflineBannerState();
  const dismissals = useBriefingDismissals();
  const colors = useThemeColors();
  const aiPreview =
    report.summary.status === 'ready' && report.summary.text
      ? report.summary.text
      : t(briefingSummaryStatusKey(report.summary.status));
  const hasAiPreview = report.summary.status !== 'disabled';
  const preview = [
    offline ? t('agentBriefing.offline') : null,
    report.revised ? t('agentBriefing.revised', { revision: report.revision }) : null,
    hasAiPreview ? aiPreview : t('agentBriefing.view'),
    hasAiPreview ? null : formatCalendarDate(report.localDate, i18n.language),
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <View
      className={cn(
        'justify-between overflow-hidden rounded-2xl border border-border bg-card',
        embedded && 'rounded-none border-0 bg-transparent'
      )}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('agentBriefing.view')}
        className="active:opacity-70"
        onPress={() => {
          router.push(`${BRIEFING_PATH}/${report.id}` as Href);
        }}
      >
        <BriefingScorecard report={report} />
      </Pressable>
      <View className="h-px bg-border" />
      <View className="min-h-[68px] flex-row items-center gap-2 px-4 py-3">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            hasAiPreview ? t('agentBriefing.viewWithPreview', { preview }) : preview
          }
          className="min-h-[44px] min-w-0 flex-1 flex-row items-center gap-2 active:opacity-70"
          onPress={() => {
            router.push(`${BRIEFING_PATH}/${report.id}` as Href);
          }}
        >
          <Text numberOfLines={2} className="min-w-0 flex-1 text-sm text-foreground">
            {preview}
          </Text>
          <DirectionalChevronRight size={18} color={colors.foreground} />
        </Pressable>
        <IconButton
          accessibilityLabel={t('agentBriefing.dismiss')}
          className="shrink-0 rounded-full border border-border bg-secondary"
          disabled={dismissals.save.isPending}
          onPress={() => {
            dismissals.dismiss(report);
          }}
        >
          <X size={18} color={colors.foreground} />
        </IconButton>
      </View>
    </View>
  );
}
