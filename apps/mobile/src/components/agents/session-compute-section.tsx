import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { formatClockTime, formatCurrency, formatDate, formatDuration } from '@/lib/format';
import { useComputeRates } from '@/lib/hooks/use-session-compute';
import {
  computeHourlyUsdFromCentsPerSecond,
  type SessionComputeCharges,
  type SessionComputeRate,
  type SessionComputeRun,
} from '@/lib/session-compute-total';
import { parseTimestamp } from '@/lib/utils';

import { formatSessionTotalCost } from './session-list-helpers';

type SessionComputeSectionProps = {
  /** The recorded compute charges, or undefined while the read is unsettled. */
  charges: SessionComputeCharges | undefined;
  /** Whether that read failed in a way a retry can fix. */
  isError: boolean;
  onRetry: () => void;
};

/** One amount in the sheet's 4-decimal precision, never an empty cell. */
function formatComputeAmount(microdollars: number): string {
  return (
    formatSessionTotalCost(microdollars) ??
    formatCurrency(microdollars / 1_000_000, i18n.language, 4)
  );
}

/** The hour rate a charged run was billed at, from its per-second rate. */
function formatRunRate(rateCentsPerSecond: number): string {
  return i18n.t('cloudAgent.compute.perHour', {
    rate: formatCurrency(computeHourlyUsdFromCentsPerSecond(rateCentsPerSecond), i18n.language, 2),
  });
}

/**
 * A run's time and rate, in the one line under its clock times. A run that just
 * opened has recorded no time yet, and `formatDuration` writes nothing for zero,
 * so the duration and its separator are omitted instead of leaving the row with
 * a `×` and no measured value in front of it.
 */
function formatRunMeasure(seconds: number, rateCentsPerSecond: number, locale: string): string {
  const duration = formatDuration(seconds, locale);
  const rate = formatRunRate(rateCentsPerSecond);
  return duration.length === 0 ? rate : `${duration} × ${rate}`;
}

/**
 * The sandbox size a saved rate belongs to. The catalogue names sizes by their
 * platform instance, so the two selectable sizes are the only ones shown.
 */
function rateLabel(rate: SessionComputeRate): string | null {
  if (rate.instance === 'standard-3') {
    return i18n.t('cloudAgent.compute.mediumSandbox');
  }
  if (rate.instance === 'standard-4') {
    return i18n.t('cloudAgent.compute.largeSandbox');
  }
  return null;
}

/**
 * The session's sandbox usage: what it cost, the runs charged for it, and the
 * rates a new sandbox is billed at. This block breaks down the compute half of
 * the total beside the model cost it is added to; the sheet paints that total,
 * and a total that includes a shared workspace's sandbox carries the note that
 * says so, exactly as the web session information dialog labels its Compute row.
 *
 * A session with no reachable compute scope (an old session id, or one billed
 * to another payer) is denied by the router: the block stays absent instead of
 * claiming the session cost nothing.
 */
export function SessionComputeSection({
  charges,
  isError,
  onRetry,
}: Readonly<SessionComputeSectionProps>) {
  const { t } = useTranslation();
  // Only the catalogue that settles the block's rates, read once per sheet.
  const rates = useComputeRates({ enabled: charges !== undefined });

  if (charges === undefined) {
    if (!isError) {
      return null;
    }
    return (
      <View className="mt-2 gap-2 border-t border-border pt-3">
        <View className="flex-row items-center justify-between gap-3">
          <Text className="text-sm font-semibold text-foreground">
            {t('cloudAgent.compute.title')}
          </Text>
          <Text className="text-sm text-muted-foreground">
            {t('agentChat.modelSelector.unavailable')}
          </Text>
        </View>
        <View className="flex-row items-center justify-between gap-3">
          <Text className="text-xs text-muted-foreground">
            {t('cloudAgent.compute.loadFailed')}
          </Text>
          <Pressable
            onPress={onRetry}
            accessibilityRole="button"
            accessibilityLabel={t('common.retry')}
            hitSlop={8}
            className="active:opacity-70"
            testID="session-compute-retry"
          >
            <Text className="text-sm font-medium text-primary">{t('common.retry')}</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  // A rate the catalogue no longer accepts new usage for is not a rate a new
  // sandbox can be billed at, so the block only names the ones it can offer.
  const availableRates = (rates.data ?? []).filter(
    (rate): rate is SessionComputeRate & { hourlyUsd: number } =>
      rate.available && rate.hourlyUsd !== null && rate.hourlyUsd > 0
  );

  return (
    <View className="mt-2 gap-2 border-t border-border pt-3" testID="session-compute-section">
      <View className="flex-row items-center justify-between gap-3">
        <Text className="text-sm font-semibold text-foreground">
          {t('cloudAgent.compute.title')}
        </Text>
        <Text className="text-sm font-semibold text-foreground tabular-nums">
          {formatComputeAmount(charges.amountMicrodollars)}
        </Text>
      </View>

      {charges.runs.length === 0 ? (
        <Text className="text-xs text-muted-foreground">{t('cloudAgent.compute.noUsage')}</Text>
      ) : (
        <View className="gap-2">
          {charges.runs.map((run, index) => (
            <ComputeRunRow key={`${run.startedAt}-${index}`} run={run} />
          ))}
          {charges.earlierRuns ? (
            <View className="flex-row items-baseline justify-between gap-3">
              <View className="min-w-0 flex-1">
                <Text className="text-xs text-foreground">
                  {t('cloudAgent.compute.earlierActivity')}
                </Text>
                <Text className="text-xs text-muted-foreground">
                  {formatDuration(charges.earlierRuns.seconds, i18n.language)}
                </Text>
              </View>
              <Text className="text-xs text-foreground tabular-nums">
                {formatComputeAmount(charges.earlierRuns.amountMicrodollars)}
              </Text>
            </View>
          ) : null}
        </View>
      )}

      {availableRates.length > 0 ? (
        <View className="mt-1 gap-1">
          <Text className="text-xs text-muted-foreground">
            {t('cloudAgent.compute.currentRates')}
          </Text>
          {availableRates.map(rate => {
            const label = rateLabel(rate);
            if (label === null) {
              return null;
            }
            return (
              <View key={rate.instance} className="flex-row items-center justify-between gap-3">
                <Text className="text-xs text-foreground">{label}</Text>
                <Text className="text-xs text-foreground tabular-nums">
                  {t('cloudAgent.compute.perHour', {
                    rate: formatCurrency(rate.hourlyUsd, i18n.language, 2),
                  })}
                </Text>
              </View>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

function ComputeRunRow({ run }: Readonly<{ run: SessionComputeRun }>) {
  const locale = i18n.language;
  const start = parseTimestamp(run.startedAt);
  const stopped = run.running || run.stoppedAt === null ? null : parseTimestamp(run.stoppedAt);
  const end =
    stopped === null ? i18n.t('cloudAgent.compute.now') : formatClockTime(stopped, locale);
  const today = formatDate(new Date(), locale, { dateStyle: 'short' });
  const startDay = formatDate(start, locale, { dateStyle: 'short' });
  const startLabel =
    startDay === today
      ? formatClockTime(start, locale)
      : `${formatDate(start, locale, { month: 'short', day: 'numeric' })} ${formatClockTime(start, locale)}`;

  return (
    <View className="flex-row items-baseline justify-between gap-3">
      <View className="min-w-0 flex-1">
        <Text className="text-xs text-foreground" numberOfLines={1}>
          {startLabel} – {end}
        </Text>
        <Text className="text-xs text-muted-foreground" numberOfLines={1}>
          {formatRunMeasure(run.seconds, run.rateCentsPerSecond, locale)}
        </Text>
      </View>
      <Text className="text-xs text-foreground tabular-nums">
        {formatComputeAmount(run.amountMicrodollars)}
      </Text>
    </View>
  );
}
