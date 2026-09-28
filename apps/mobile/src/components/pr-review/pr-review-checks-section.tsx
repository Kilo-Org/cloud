/* eslint-disable max-lines -- the section owns every CHECKS state in one file: the card shell, the tone/rollup helpers and the rows share one surface, and splitting the visible-loading fix away from the states it must match scatters it across callers. */
import { useQuery } from '@tanstack/react-query';
import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';
import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  ExternalLink,
  Loader2,
  MinusCircle,
  XCircle,
} from '@/components/ui/icons';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import {
  type PrReviewChecksStatus,
  PrReviewChecksStatusRow,
} from '@/components/pr-review/pr-review-checks-status-row';
import { PrReviewReconnectNotice } from '@/components/pr-review/pr-review-reconnect-notice';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { SpinningIcon } from '@/components/ui/spinning-icon';
import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { reviewerPlatformLabel } from '@/lib/code-reviewer-config';
import { formatNumber } from '@/lib/format';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { classifyPrReviewQueryState } from '@/lib/pr-review/classify-pr-review-query-state';
import { useProviderPrQueries } from '@/lib/pr-review/provider-pr-queries';
import { providerPrTermKey, providerPrWebUrl } from '@/lib/pr-review/provider-pr-ref';
import { cn } from '@/lib/utils';
import { openExternalUrl } from '@/lib/external-link';

type RouterOutputs = inferRouterOutputs<MobileRouter>;
type CheckRun = RouterOutputs['githubPrReview']['listChecks']['checkRuns'][number];

type PrReviewChecksSectionProps = {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  /** Head SHA to fetch check runs for. */
  readonly headSha: string;
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
    // GitHub's commit-status `error` state is a real API conclusion the
    // server already counts as failure (mappers.ts rollupState).
    case 'failure':
    case 'startup_failure':
    case 'error': {
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

/**
 * Which collapsed row counts a run. The tone above picks the detail row's
 * icon; this picks the bucket, and the two answer different questions — a
 * cancelled run keeps its muted circle while it counts as a failure.
 *
 * It mirrors the server's `rollupState` (apps/web/src/lib/github-pr-review/
 * mappers.ts), which is the count the rows replaced: `cancelled`/`stale` are
 * failures there, and a completed run with a null or unmapped conclusion is
 * pending, never skipped. The provider read layer agrees (`canceled` blocks a
 * GitLab merge as a failed pipeline), so the rows cannot contradict the
 * rollup on either arm.
 */
function classifyCheckStatus(status: string, conclusion: string | null): PrReviewChecksStatus {
  if (status !== 'completed') {
    return 'pending';
  }
  const value = conclusion ?? '';
  if (/^success$/i.test(value)) {
    return 'success';
  }
  if (/failure|error|cancelled|timed_out|action_required|stale/i.test(value)) {
    return 'failure';
  }
  if (/skipped|neutral/i.test(value)) {
    return 'skipped';
  }
  return 'pending';
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
      <SpinningIcon icon={Icon} size={16} color={iconColor} spinning={tone === 'pending'} />
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

// The row order the rollup line has always summarised, kept for the groups.
const STATUS_ORDER = ['success', 'failure', 'pending', 'skipped'] as const;

// React Native on Android keeps a View's contentDescription when a later
// render drops its `accessibilityLabel` (the loaded card inherited the loading
// card's "Loading…" and a screen reader announced it over the loaded rows,
// e2-scene.xml: the loaded `ViewGroup` kept `content-desc="Loading…"`). A
// state switch must therefore mount a fresh native card: the loading card and
// every content card carry different keys, so React unmounts one and mounts
// the other instead of updating a reused view. The key stays stable within a
// state, because re-mounting the same card on a re-render would drop the
// expanded rows' state.
const LOADING_CARD_KEY = 'checks-card-loading';
const CONTENT_CARD_KEY = 'checks-card';

type CheckRunGroup = {
  status: PrReviewChecksStatus;
  runs: CheckRun[];
};

/**
 * Group the run list by the rollup status the server counts the run in,
 * dropping statuses with no runs: a status the head commit has no checks for
 * renders no row. Every run lands in exactly one bucket, so the row counts
 * always sum to the card total and no run is dropped.
 */
function groupRunsByStatus(runList: readonly CheckRun[]): CheckRunGroup[] {
  const byStatus = new Map<PrReviewChecksStatus, CheckRun[]>();
  for (const run of runList) {
    const status = classifyCheckStatus(run.status, run.conclusion);
    const bucket = byStatus.get(status);
    if (bucket) {
      bucket.push(run);
    } else {
      byStatus.set(status, [run]);
    }
  }
  return STATUS_ORDER.flatMap(status => {
    const runs = byStatus.get(status);
    return runs ? [{ status, runs }] : [];
  });
}

export function PrReviewChecksSection({
  owner,
  repo,
  number,
  headSha,
}: PrReviewChecksSectionProps) {
  const queries = useProviderPrQueries({ owner, repo, number });
  const colors = useThemeColors();
  const { t } = useTranslation();
  // Null on a GitLab ref with no instance hint: no host, so no link out.
  const prUrl = providerPrWebUrl(queries.ref);

  const checks = useQuery(queries.checksOptions(headSha));

  // Loading (first time, no cached data): reserve the loaded card's shape so
  // the swap cannot move the page. The loaded card is a header strip
  // (`border-b-[0.5px] border-hair-soft px-4 py-2`) plus one `min-h-11` group
  // row per present status, and STATUS_ORDER holds exactly four statuses with
  // no row for an absent one, so the card tops out at four rows. Reserving
  // four means a mixed-status PR (the case this feature targets) is shift-free
  // and the Review button, PrMergeSection and the head line below never get
  // pushed down while the user is on the page; an empty or single-status card
  // settles upward instead of growing under the user.
  // The bars must NOT be `bg-muted` here: `--muted` and `--secondary` are
  // the same colour in both themes (apps/mobile/src/global.css), so a
  // `bg-muted` bar inside this `bg-secondary` card paints nothing and the
  // section reads as an empty gray block (spot check e1-nav-mr). The shared
  // Skeleton gives the pulse + shimmer, and `bg-muted-soft` is the one gray
  // that contrasts with the card in both themes.
  if (checks.isLoading) {
    return (
      <View className="gap-2">
        <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
          {t('prReview.checks.title')}
        </Text>
        <View
          key={LOADING_CARD_KEY}
          className="overflow-hidden rounded-lg bg-secondary"
          accessibilityRole="progressbar"
          accessibilityLabel={t('common.loading')}
        >
          <View className="border-b-[0.5px] border-hair-soft px-4 py-2">
            <Skeleton className="h-3 w-24 rounded-md bg-muted-soft" />
          </View>
          {STATUS_ORDER.map((status, rowIndex) => (
            <View key={status}>
              <View className="min-h-11 flex-row items-center gap-3 px-4 py-3">
                <Skeleton className="h-4 w-4 rounded-full bg-muted-soft" />
                <View className="flex-1">
                  <Skeleton className="h-3.5 w-24 rounded-md bg-muted-soft" />
                </View>
                <Skeleton className="h-4 w-4 rounded-md bg-muted-soft" />
              </View>
              {rowIndex < STATUS_ORDER.length - 1 ? (
                <View className="border-b-[0.5px] border-hair-soft" />
              ) : null}
            </View>
          ))}
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
          <View key={CONTENT_CARD_KEY} className="gap-2 rounded-lg bg-secondary p-4">
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
          <View key={CONTENT_CARD_KEY} className="gap-2 rounded-lg bg-secondary p-4">
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
        <View key={CONTENT_CARD_KEY} className="gap-3 rounded-lg bg-secondary p-4">
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

  const viewOnProviderLabel =
    queries.platform === 'github'
      ? t('prReview.checks.viewOnGitHub')
      : t('prReview.terms.viewOnProvider', { provider: reviewerPlatformLabel(queries.platform) });

  const data = checks.data;
  const runList = data?.checkRuns ?? [];
  const groups = groupRunsByStatus(runList);

  if (runList.length === 0) {
    return (
      <View className="gap-2">
        <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
          {t('prReview.checks.title')}
        </Text>
        <View key={CONTENT_CARD_KEY} className="gap-3 rounded-lg bg-secondary p-4">
          <Text className="text-sm text-muted-foreground">
            {t('prReview.checks.noChecksReported')}
          </Text>
          {prUrl ? (
            <Button
              variant="outline"
              onPress={() => {
                void openExternalUrl(prUrl, { label: t(providerPrTermKey(queries.platform)) });
              }}
              accessibilityLabel={viewOnProviderLabel}
            >
              <View className="flex-row items-center gap-2">
                <ExternalLink size={14} color={colors.foreground} />
                <Text>{viewOnProviderLabel}</Text>
              </View>
            </Button>
          ) : null}
        </View>
      </View>
    );
  }

  // i18n-dup-ok: 'prReview.checks.checksCount_other' repeats the bare
  // 'prReview.checks.checksCount' by i18next convention — the bare key is the
  // plural fallback that must carry the `other` copy, so the family is one key
  // with a plural stem, not two keys for one string.
  return (
    <View className="gap-2">
      <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
        {t('prReview.checks.title')}
      </Text>
      <View key={CONTENT_CARD_KEY} className="overflow-hidden rounded-lg bg-secondary">
        <View className="border-b-[0.5px] border-hair-soft px-4 py-2">
          <Text variant="muted" className="text-xs">
            {t('prReview.checks.checksCount', {
              count: runList.length,
              displayCount: formatNumber(runList.length, i18n.language),
            })}
          </Text>
        </View>
        {groups.map((group, groupIndex) => (
          <PrReviewChecksStatusRow
            key={group.status}
            status={group.status}
            count={group.runs.length}
            showSeparator={groupIndex < groups.length - 1}
          >
            {group.runs.map((run, runIndex) => (
              <View key={`${run.name}-${runIndex}`}>
                <CheckRow run={run} />
                {runIndex < group.runs.length - 1 ? (
                  <View className="ml-4 border-b-[0.5px] border-hair-soft" />
                ) : null}
              </View>
            ))}
          </PrReviewChecksStatusRow>
        ))}
      </View>
    </View>
  );
}
