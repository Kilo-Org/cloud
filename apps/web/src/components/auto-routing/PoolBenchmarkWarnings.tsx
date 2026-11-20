'use client';

// Web Jest compiles JSX with the classic runtime, which needs React in scope.
import React from 'react';
import type { CustomRouterListEntry, CustomRouterSummary } from '@kilocode/auto-routing-contracts';
import { TriangleAlert } from 'lucide-react';
import { entryLabel } from './custom-router-display';

export type PoolBenchmarkWarning = {
  key: string;
  tone: 'warning' | 'destructive';
  message: string;
};

function failedBenchmarkWarnings(entry: CustomRouterListEntry): PoolBenchmarkWarning[] {
  const label = entryLabel(entry.entry);
  // A permanent verdict only exists on a status row's `failure`/`availability`.
  // The list has no separate `blocker` field, so a permanent failure would
  // otherwise never warn.
  const permanent = entry.variants.find(
    variant => variant.failure?.kind === 'permanent' || variant.availability === 'permanent_failure'
  );
  if (permanent !== undefined) {
    const failedModel = permanent.resolvedModel ?? label;
    const variant = permanent.variant === null ? '' : ` (${permanent.variant})`;
    const reason =
      permanent.failure?.reason ??
      permanent.failureReason ??
      permanent.failure?.failureClass ??
      'the benchmark permanently failed';
    // A ready/stale row still ranks this pool, so removal advice would be wrong.
    const serving = entry.variants.some(row => row.status === 'ready' || row.status === 'stale');
    return [
      {
        key: `${entry.key}:failed`,
        tone: serving ? 'warning' : 'destructive',
        message: serving
          ? `Benchmark permanently failed for ${failedModel}${variant}: ${reason}. Its existing usable measurement still ranks routes in this pool. New pools cannot add this model until an admin re-admits its benchmark.`
          : `Benchmark permanently failed for ${failedModel}${variant}: ${reason}. It has no usable measurement, so it cannot serve this pool; replace ${label} or choose another model.`,
      },
    ];
  }

  const failed = entry.variants.find(variant => variant.status === 'failed');
  if (failed === undefined) return [];
  const failedModel = failed.resolvedModel ?? label;
  const variant = failed.variant === null ? '' : ` (${failed.variant})`;
  const failure = failed.failure;
  const retry = failure?.kind === 'retryable' ? ` It is retried after ${failure.retryAfter}.` : '';
  return [
    {
      key: `${entry.key}:failed`,
      tone: 'warning',
      message: `Benchmark failed for ${failedModel}${variant}: ${
        failure?.reason ?? failed.failureReason ?? 'no reason was recorded'
      }.${retry} Routing keeps its last usable measurement when one exists; benchmark the pool again to retry.`,
    },
  ];
}

/**
 * Alias warnings come from the saved serving pin and the status rows: a pinned
 * alias keeps dispatching its benchmarked target, a missing target falls back to
 * the live alias, and the model catalog's current target shows a moved alias.
 */
function aliasWarnings(
  entry: CustomRouterListEntry,
  aliasTargets: ReadonlyMap<string, string>
): PoolBenchmarkWarning[] {
  if (entry.entry.kind !== 'gateway' || !entry.entry.model.startsWith('~')) return [];
  const label = entryLabel(entry.entry);
  const pin = entry.servingPin ?? entry.entry.servingPin ?? null;
  const aliasTarget = aliasTargets.get(entry.entry.model) ?? null;
  const fallback = entry.variants.find(variant => variant.servingFallback === true);

  if (fallback !== undefined) {
    const servedTarget = aliasTarget ?? fallback.servingModel ?? null;
    const target = servedTarget ?? 'the current alias target';
    const measured = entry.variants.some(
      variant => variant.status === 'ready' || variant.status === 'stale'
    );
    return [
      {
        key: `${entry.key}:alias`,
        tone: measured ? 'warning' : 'destructive',
        message: [
          `The benchmarked model ${pin?.model ?? 'for this alias'} is no longer served.`,
          measured
            ? `Requests for ${label} go to ${target}, which is measured in this pool.`
            : `Requests for ${label} go to ${target}, which has no measurement in this pool.`,
          'Benchmark the pool again to pin the current target.',
        ].join(' '),
      },
    ];
  }

  if (pin !== null && aliasTarget !== null && aliasTarget !== pin.model) {
    return [
      {
        key: `${entry.key}:alias`,
        tone: 'warning',
        message: `Alias ${label} now resolves to ${aliasTarget}, but routing keeps using the benchmarked ${pin.model} until you benchmark the pool again.`,
      },
    ];
  }

  return [
    {
      key: `${entry.key}:alias`,
      tone: 'warning',
      message:
        pin === null
          ? `Alias ${label}: benchmarking pins the model this alias resolves to. If the alias moves to a different model, re-benchmark the pool to update routing.`
          : `Alias ${label} is benchmarked against ${pin.model} (pinned ${pin.pinnedAt.slice(
              0,
              10
            )}). Requests keep using that model if the alias moves; benchmark the pool again to follow the alias.`,
    },
  ];
}

export function poolBenchmarkWarnings(
  router: CustomRouterSummary,
  aliasTargets: ReadonlyMap<string, string> = new Map()
): PoolBenchmarkWarning[] {
  return router.entries.flatMap(entry => [
    ...aliasWarnings(entry, aliasTargets),
    ...failedBenchmarkWarnings(entry),
  ]);
}

export function PoolBenchmarkWarnings({
  router,
  aliasTargets,
}: {
  router: CustomRouterSummary;
  aliasTargets?: ReadonlyMap<string, string>;
}) {
  const warnings = poolBenchmarkWarnings(router, aliasTargets);
  if (warnings.length === 0) return null;
  return (
    <ul className="space-y-2" aria-label="Benchmark warnings">
      {warnings.map(warning => (
        <li
          key={warning.key}
          className={
            warning.tone === 'destructive'
              ? 'text-destructive flex items-start gap-1.5 text-xs'
              : 'flex items-start gap-1.5 text-xs text-amber-500'
          }
        >
          <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span>{warning.message}</span>
        </li>
      ))}
    </ul>
  );
}
