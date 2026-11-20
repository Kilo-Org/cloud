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
  const blocker = entry.blocker ?? null;

  // The blocker names the exact resolved pair that permanently failed, which is
  // not always the entry's own model: an alias reports its target.
  if (blocker !== null) {
    const variant = blocker.variant === null ? '' : ` (${blocker.variant})`;
    return [
      {
        key: `${entry.key}:failed`,
        tone: 'destructive',
        message: `Benchmark permanently failed for ${blocker.model}${variant}: ${
          blocker.reason ?? blocker.failureClass
        }. This model cannot be added to a pool; remove ${label} or choose another model.`,
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
    return [
      {
        key: `${entry.key}:alias`,
        tone: 'destructive',
        message: `The benchmarked model ${pin?.model ?? 'for this alias'} is no longer served. Requests for ${label} fall back to ${
          aliasTarget ?? fallback.servingModel ?? 'the current alias target'
        } without a benchmark measurement. Benchmark the pool again to update routing.`,
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
