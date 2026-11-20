'use client';

import type { BenchmarkPoolKind, BenchmarkPriceSkip } from '@kilocode/auto-routing-contracts';

/** Pool type names. Public text names the type only; owner ids never reach this surface. */
const POOL_LABELS: Record<BenchmarkPoolKind, string> = {
  platform: 'platform',
  user_subscription: 'user subscription',
  custom: 'custom pool',
};

export function poolLabel(kind: BenchmarkPoolKind): string {
  return POOL_LABELS[kind];
}

function formatUsd(value: number): string {
  const fixed = value.toFixed(6);
  return `$${fixed.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '.0')}`;
}

function formatUsdOrDash(value: number | null): string {
  return value === null ? '—' : formatUsd(value);
}

/** One skip's explanation: the pair's price, its leader, and the numbers behind the call. */
export function priceSkipReason(skip: BenchmarkPriceSkip): string {
  if (skip.budgetUsd !== null) {
    return `over ${formatUsd(skip.budgetUsd)} budget`;
  }
  if (skip.pairBestValue !== null && skip.leader?.value != null) {
    return 'best case still ranks behind the leader';
  }
  return 'cannot outrank the leader';
}

/**
 * Live price-dominance skips: `(model, variant, route)` pairs the measurement drain does
 * not run because they cannot win that route at their price in the pool shown. The row
 * carries the pair's price, the leader it lost to and the bound it exceeded, so an
 * operator can see why without re-deriving the ranking.
 */
export function PriceSkipsTable({ skips }: { skips: readonly BenchmarkPriceSkip[] }) {
  if (skips.length === 0) {
    return (
      <p className="text-muted-foreground text-xs">
        Every pending pair can still win somewhere at its price, so none is skipped.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs">
        <thead className="text-muted-foreground">
          <tr>
            <th className="py-1 pr-3 font-medium">Model</th>
            <th className="py-1 pr-3 font-medium">Route</th>
            <th className="py-1 pr-3 font-medium">Pool</th>
            <th className="py-1 pr-3 font-medium">Pair price</th>
            <th className="py-1 pr-3 font-medium">Leader</th>
            <th className="py-1 pr-3 font-medium">Leader price</th>
            <th className="py-1 pr-3 font-medium">Budget</th>
            <th className="py-1 font-medium">Why</th>
          </tr>
        </thead>
        <tbody>
          {skips.map(skip => (
            <tr
              key={`${skip.model}\0${skip.variant ?? ''}\0${skip.routeKey}`}
              className="border-t align-top"
            >
              <td className="py-1 pr-3">
                <span className="font-mono">{skip.model}</span>
                {skip.variant ? (
                  <span className="text-muted-foreground"> · {skip.variant}</span>
                ) : null}
              </td>
              <td className="py-1 pr-3 font-mono">{skip.routeKey}</td>
              <td className="py-1 pr-3">{poolLabel(skip.poolKind)}</td>
              <td className="py-1 pr-3 tabular-nums">{formatUsdOrDash(skip.pairRequestCostUsd)}</td>
              <td className="py-1 pr-3">
                {skip.leader ? (
                  <span className="font-mono">
                    {skip.leader.model}
                    {skip.leader.variant ? ` · ${skip.leader.variant}` : ''}
                  </span>
                ) : (
                  '—'
                )}
              </td>
              <td className="py-1 pr-3 tabular-nums">
                {skip.leader ? formatUsd(skip.leader.requestCostUsd) : '—'}
              </td>
              <td className="py-1 pr-3 tabular-nums">{formatUsdOrDash(skip.budgetUsd)}</td>
              <td className="py-1">{priceSkipReason(skip)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The panel header line: how many pairs are skipped and the console's one-sentence rule.
 */
export function priceSkipsSummary(skips: readonly BenchmarkPriceSkip[]): string {
  if (skips.length === 0) return 'Nothing is skipped for price.';
  const pairs = new Set(skips.map(skip => `${skip.model}\0${skip.variant ?? ''}`)).size;
  return `${pairs} ${pairs === 1 ? 'pair' : 'pairs'} skipped: cannot win at this price.`;
}
