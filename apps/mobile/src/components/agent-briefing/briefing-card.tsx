import { type Href, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { CardControl } from '@/components/home/adaptive-home-card-frame';
import { DirectionalChevronRight } from '@/components/ui/directional-icons';
import { X } from '@/components/ui/icons';
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
import { ICON_TARGET_BOX_CLASS } from '@/lib/a11y/tap-target';
import { briefingSummaryStatusKey, visibleHomeBriefing } from '@/lib/agent-briefing-state';
import { cn } from '@/lib/utils';
import { formatCalendarDate, formatNumber } from '@/lib/format';

export function BriefingScorecard({ report }: { readonly report: BriefingReport }) {
  const { t, i18n } = useTranslation();
  const rows = [
    {
      label: t('agentBriefing.selectedSessions'),
      amount: report.scorecard.sessions,
    },
    {
      label: t('agentBriefing.snapshotPullRequests'),
      amount: report.scorecard.pullRequests,
    },
    {
      label: t('agentBriefing.snapshotBlockers'),
      amount: report.scorecard.blockers,
    },
  ];
  return (
    <View className="gap-2 px-4 py-3">
      {rows.map(row => (
        <View key={row.label} className="min-h-6 flex-row items-center gap-2">
          <Text className="text-sm font-semibold text-foreground">
            {formatNumber(row.amount, i18n.language)}
          </Text>
          <Text numberOfLines={1} className="min-w-0 shrink text-sm text-muted-foreground">
            {row.label}
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
  return (
    <View
      className={cn(
        'overflow-hidden rounded-2xl border border-border bg-card',
        // `grow` lets the frame's taller layer stretch the card, so no slack is left
        // below it. The divider then follows the counts at their own padding, and the
        // summary row takes the height the frame reserves beyond the live card's
        // fourth count row and centers its content in it, so the counts and the
        // summary stay evenly spaced inside the card.
        embedded && 'grow rounded-none border-0 bg-transparent'
      )}
    >
      <CardControl
        accessibilityRole="button"
        accessibilityLabel={t('agentBriefing.view')}
        onPress={() => {
          router.push(`${BRIEFING_PATH}/${report.id}` as Href);
        }}
      >
        <BriefingScorecard report={report} />
      </CardControl>
      <View className="h-px bg-border" />
      <View
        className={cn(
          'flex-row items-center gap-2 px-4 py-3',
          // Only the stretched card has height to share; outside the frame the row
          // keeps its content height instead of collapsing to a zero flex basis.
          embedded && 'flex-1'
        )}
      >
        <CardControl
          accessibilityRole="button"
          accessibilityLabel={previewLabel}
          className="min-h-[44px] min-w-0 flex-1 flex-row items-center gap-2"
          onPress={() => {
            router.push(`${BRIEFING_PATH}/${report.id}` as Href);
          }}
        >
          <Text numberOfLines={2} className="min-w-0 flex-1 text-sm text-foreground">
            {preview}
          </Text>
          <DirectionalChevronRight size={18} color={colors.foreground} />
        </CardControl>
        <CardControl
          accessibilityRole="button"
          accessibilityLabel={t('agentBriefing.dismiss')}
          className={cn(
            ICON_TARGET_BOX_CLASS,
            'shrink-0 rounded-full border border-border bg-secondary'
          )}
          disabled={dismissals.save.isPending}
          onPress={() => {
            dismissals.dismiss(report);
          }}
        >
          <X size={18} color={colors.foreground} />
        </CardControl>
      </View>
    </View>
  );
}
