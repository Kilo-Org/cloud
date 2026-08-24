import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  ExternalLink,
  Loader2,
  MinusCircle,
  XCircle,
} from '@/components/ui/icons';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { PrReviewReconnectNotice } from '@/components/pr-review/pr-review-reconnect-notice';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { classifyPrReviewQueryState } from '@/lib/pr-review/classify-pr-review-query-state';
import { useTRPC } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { openExternalUrl } from '@/lib/external-link';

type PrReviewChecksSectionProps = {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  /** Head SHA to fetch check runs for. */
  readonly headSha: string;
};

type CheckRun = {
  name: string;
  status: string;
  conclusion: string | null;
  detailsUrl: string | null;
  appName: string | null;
};

type CheckTone = 'success' | 'failure' | 'pending' | 'skipped' | 'neutral' | 'warning';

function classifyCheckTone(status: string, conclusion: string | null): CheckTone {
  // GitHub's CheckRun.status: queued | in_progress | completed | pending | waiting | requested.
  // conclusion is null unless status === 'completed'.
  if (status !== 'completed') {
    return 'pending';
  }
  switch (conclusion) {
    case 'success': {
      return 'success';
    }
    case 'failure':
    case 'startup_failure': {
      return 'failure';
    }
    case 'skipped':
    case 'cancelled':
    case 'stale': {
      return 'skipped';
    }
    case 'timed_out':
    case 'action_required': {
      return 'warning';
    }
    case 'neutral':
    case null: {
      return 'neutral';
    }
    default: {
      return 'neutral';
    }
  }
}

const TONE_COLOR = {
  success: 'good',
  failure: 'destructive',
  pending: 'mutedForeground',
  skipped: 'mutedForeground',
  neutral: 'mutedForeground',
  warning: 'warn',
} satisfies Record<CheckTone, keyof ReturnType<typeof useThemeColors>>;

const TONE_ICON = {
  success: CheckCircle2,
  failure: XCircle,
  pending: Loader2,
  skipped: MinusCircle,
  neutral: Circle,
  warning: AlertTriangle,
} satisfies Record<CheckTone, typeof CheckCircle2>;

function CheckRow({ run }: Readonly<{ run: CheckRun }>) {
  const colors = useThemeColors();
  const { t } = useTranslation();
  const tone = classifyCheckTone(run.status, run.conclusion);
  const Icon = TONE_ICON[tone];
  const iconColor = colors[TONE_COLOR[tone]];

  const subtitle = run.appName ?? '';

  const body = (
    <View className={cn('flex-row items-center gap-3 px-4 py-3', 'min-h-11')}>
      <Icon size={16} color={iconColor} />
      <View className="flex-1 gap-0.5">
        <Text className="text-sm font-medium" numberOfLines={1}>
          {run.name}
        </Text>
        {subtitle ? (
          <Text variant="muted" className="text-xs" numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {run.detailsUrl ? <ExternalLink size={14} color={colors.mutedForeground} /> : null}
    </View>
  );

  if (!run.detailsUrl) {
    return body;
  }
  return (
    <Pressable
      className="active:opacity-70"
      onPress={() => {
        if (run.detailsUrl) {
          void openExternalUrl(run.detailsUrl, { label: t('prReview.checks.checkDetails') });
        }
      }}
      accessibilityRole="link"
      accessibilityLabel={t('prReview.checks.openDetails', { name: run.name })}
    >
      {body}
    </Pressable>
  );
}

function buildRollupLine(rollup: {
  total: number;
  success: number;
  failure: number;
  pending: number;
  skipped: number;
}): string {
  if (rollup.total === 0) {
    return i18n.t('prReview.checks.noChecksReported');
  }
  const parts: string[] = [];
  if (rollup.success > 0) {
    parts.push(i18n.t('prReview.checks.passed', { count: rollup.success }));
  }
  if (rollup.failure > 0) {
    parts.push(i18n.t('prReview.checks.failed', { count: rollup.failure }));
  }
  if (rollup.pending > 0) {
    parts.push(i18n.t('prReview.checks.pending', { count: rollup.pending }));
  }
  if (rollup.skipped > 0) {
    parts.push(i18n.t('prReview.checks.skipped', { count: rollup.skipped }));
  }
  return parts.length > 0
    ? parts.join(' · ')
    : i18n.t('prReview.checks.checksCount', { count: rollup.total });
}

export function PrReviewChecksSection({
  owner,
  repo,
  number,
  headSha,
}: PrReviewChecksSectionProps) {
  const trpc = useTRPC();
  const colors = useThemeColors();
  const { t } = useTranslation();
  const prUrl = useMemo(
    () => `https://github.com/${owner}/${repo}/pull/${number}`,
    [owner, repo, number]
  );

  const checks = useQuery(
    trpc.githubPrReview.listChecks.queryOptions({ owner, repo, ref: headSha })
  );

  // Loading (first time, no cached data): show three skeleton rows in a
  // card so the section matches the final dimensions once the data lands.
  if (checks.isLoading) {
    return (
      <View className="gap-2">
        <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
          {t('prReview.checks.title')}
        </Text>
        <View className="gap-2 rounded-lg bg-secondary p-4">
          <View className="h-3 w-40 rounded bg-muted" />
          <View className="h-3 w-32 rounded bg-muted" />
          <View className="h-3 w-44 rounded bg-muted" />
        </View>
      </View>
    );
  }

  if (checks.isError) {
    const state = classifyPrReviewQueryState(checks.error);
    if (state.kind === 'not-found') {
      // Section-level terminal: NOT_FOUND here means the ref has no
      // checks endpoint access (rare; usually means the app isn't
      // installed on the head repo). No retry — just the message.
      return (
        <View className="gap-2">
          <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
            {t('prReview.checks.title')}
          </Text>
          <View className="gap-2 rounded-lg bg-secondary p-4">
            <Text className="text-sm text-muted-foreground">
              {t('prReview.checks.notAvailable')}
            </Text>
          </View>
        </View>
      );
    }
    if (state.kind === 'permission') {
      return (
        <View className="gap-2">
          <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
            {t('prReview.checks.title')}
          </Text>
          <View className="gap-2 rounded-lg bg-secondary p-4">
            <Text className="text-sm text-muted-foreground">{t('prReview.checks.noAccess')}</Text>
          </View>
        </View>
      );
    }
    if (state.kind === 'reconnect') {
      return (
        <View className="gap-2">
          <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
            {t('prReview.checks.title')}
          </Text>
          <PrReviewReconnectNotice />
        </View>
      );
    }

    // Retryable (server/offline) — section-level retry button.
    return (
      <View className="gap-2">
        <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
          {t('prReview.checks.title')}
        </Text>
        <View className="gap-3 rounded-lg bg-secondary p-4">
          <Text className="text-sm text-muted-foreground">{t('prReview.checks.couldNotLoad')}</Text>
          <Button
            variant="outline"
            onPress={() => {
              void checks.refetch();
            }}
            loading={checks.isFetching}
            accessibilityLabel={t('prReview.checks.retryChecks')}
          >
            <Text>{t('common.retry')}</Text>
          </Button>
        </View>
      </View>
    );
  }

  const data = checks.data;
  const runList = data?.checkRuns ?? [];
  const rollup = data?.rollup ?? { total: 0, success: 0, failure: 0, pending: 0, skipped: 0 };
  const rollupLine = buildRollupLine(rollup);

  if (runList.length === 0) {
    return (
      <View className="gap-2">
        <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
          {t('prReview.checks.title')}
        </Text>
        <View className="gap-3 rounded-lg bg-secondary p-4">
          <Text className="text-sm text-muted-foreground">{rollupLine}</Text>
          <Button
            variant="outline"
            onPress={() => {
              void openExternalUrl(prUrl, { label: t('prReview.checks.pullRequest') });
            }}
            accessibilityLabel={t('prReview.checks.viewOnGitHub')}
          >
            <View className="flex-row items-center gap-2">
              <ExternalLink size={14} color={colors.foreground} />
              <Text>{t('prReview.checks.viewOnGitHub')}</Text>
            </View>
          </Button>
        </View>
      </View>
    );
  }

  return (
    <View className="gap-2">
      <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
        {t('prReview.checks.title')}
      </Text>
      <View className="overflow-hidden rounded-lg bg-secondary">
        <View className="border-b-[0.5px] border-hair-soft px-4 py-2">
          <Text variant="muted" className="text-xs">
            {rollupLine}
          </Text>
        </View>
        {runList.map((run, index) => (
          <View key={`${run.name}-${index}`}>
            <CheckRow run={run} />
            {index < runList.length - 1 ? (
              <View className="ml-4 border-b-[0.5px] border-hair-soft" />
            ) : null}
          </View>
        ))}
      </View>
    </View>
  );
}
