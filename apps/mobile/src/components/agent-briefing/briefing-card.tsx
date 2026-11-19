import { type Href, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { CardControl } from '@/components/home/adaptive-home-card-frame';
import { Card } from '@/components/ui/card';
import { X } from '@/components/ui/icons';
import { RowChevron } from '@/components/ui/row-chevron';
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
import { ICON_TARGET_BOX_CLASS, ROW_TARGET_CLASS } from '@/lib/a11y/tap-target';
import { briefingSummaryStatusKey, visibleHomeBriefing } from '@/lib/agent-briefing-state';
import { cn } from '@/lib/utils';
import { formatCalendarDate, formatNumber } from '@/lib/format';

/** One source of truth for the scorecard counts, in announced order. */
const briefingScorecardRows = (report: BriefingReport) =>
  [
    {
      labelKey: 'agentBriefing.selectedSessions',
      amount: report.scorecard.sessions,
    },
    {
      labelKey: 'agentBriefing.snapshotPullRequests',
      amount: report.scorecard.pullRequests,
    },
    {
      labelKey: 'agentBriefing.snapshotBlockers',
      amount: report.scorecard.blockers,
    },
  ] as const;

export function BriefingScorecard({ report }: { readonly report: BriefingReport }) {
  const { t, i18n } = useTranslation();
  const rows = briefingScorecardRows(report);
  return (
    <View className="gap-2">
      {rows.map(row => (
        <View key={row.labelKey} className="flex-row items-center gap-2">
          <Text variant="figure">{formatNumber(row.amount, i18n.language)}</Text>
          <Text variant="muted" numberOfLines={1} className="min-w-0 shrink">
            {t(row.labelKey)}
          </Text>
        </View>
      ))}
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
    frameReport: isLoaded ? query.reports[0] : undefined,
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
    hasAiPreview ? aiPreview : t('agentBriefing.view'),
    hasAiPreview ? null : formatCalendarDate(report.localDate, i18n.language),
  ]
    .filter(Boolean)
    .join(' · ');
  const previewLabel = hasAiPreview ? t('agentBriefing.viewWithPreview', { preview }) : preview;
  const open = () => {
    router.push(`${BRIEFING_PATH}/${report.id}` as Href);
  };
  // The control's name carries the action and the three counts, in the same
  // formatted values the scorecard rows announce.
  const scorecardLabel = t('agentBriefing.scorecardLabel', {
    sessions: formatNumber(report.scorecard.sessions, i18n.language),
    pullRequests: formatNumber(report.scorecard.pullRequests, i18n.language),
    blockers: formatNumber(report.scorecard.blockers, i18n.language),
  });
  // The frame's taller layer stretches the embedded card, so no slack is left
  // below it: the divider follows the counts, and the summary row takes the
  // height the frame reserves beyond them and centers its content in it, so the
  // counts and the summary stay evenly spaced inside the card.
  const body = (
    <>
      <CardControl
        accessibilityRole="button"
        accessibilityLabel={scorecardLabel}
        onPress={open}
      >
        <BriefingScorecard report={report} />
      </CardControl>
      <View className="border-b-[0.5px] border-hair-soft" />
      <View className={cn('flex-row items-center gap-2', embedded && 'flex-1')}>
        <CardControl
          accessibilityRole="button"
          accessibilityLabel={previewLabel}
          className={cn(ROW_TARGET_CLASS, 'min-w-0 flex-1 flex-row items-center gap-2')}
          onPress={open}
        >
          <Text variant="muted" numberOfLines={2} className="min-w-0 flex-1">
            {preview}
          </Text>
          <RowChevron />
        </CardControl>
        <CardControl
          accessibilityRole="button"
          accessibilityLabel={t('agentBriefing.dismiss')}
          className={cn(
            ICON_TARGET_BOX_CLASS,
            // `bg-secondary` is the card's own fill, so the control painted
            // nothing at all; the outline treatment gives it an edge.
            'shrink-0 rounded-full border border-border bg-card'
          )}
          disabled={dismissals.save.isPending}
          onPress={() => {
            dismissals.dismiss(report);
          }}
        >
          <X size={18} color={colors.foreground} />
        </CardControl>
      </View>
    </>
  );
  if (embedded) {
    return <View className="grow gap-3 px-4 py-3">{body}</View>;
  }
  return <Card>{body}</Card>;
}
