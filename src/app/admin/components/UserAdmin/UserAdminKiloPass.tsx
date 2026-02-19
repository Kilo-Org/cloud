'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useQuery } from '@tanstack/react-query';
import { Coins } from 'lucide-react';
import { formatMicrodollars, formatDate } from '@/lib/admin-utils';
import { useTRPC } from '@/lib/trpc/utils';
import CheckKiloPassButton from './CheckKiloPassButton';
import { KiloPassIssuanceItemKind } from '@/lib/kilo-pass/enums';

function formatUsd(value: number | string | null | undefined): string {
  const num = typeof value === 'string' ? parseFloat(value) : value;
  if (num == null || isNaN(num)) return '$0.00';
  return `$${num.toFixed(2)}`;
}

export function UserAdminKiloPass({ userId }: { userId: string }) {
  const trpc = useTRPC();
  const { data, isLoading, error } = useQuery(
    trpc.admin.users.getKiloPassState.queryOptions({ userId })
  );

  if (isLoading) {
    return (
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Coins className="h-5 w-5" /> Kilo Pass
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">Loading...</p>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Coins className="h-5 w-5" /> Kilo Pass
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-red-400">Failed to load Kilo Pass state</p>
        </CardContent>
      </Card>
    );
  }

  if (!data?.subscription) {
    return (
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Coins className="h-5 w-5" /> Kilo Pass
          </CardTitle>
          <CardDescription>No active Kilo Pass subscription</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const { subscription, issuances, currentPeriodUsageUsd, thresholds } = data;

  const statusColor =
    subscription.status === 'active'
      ? 'bg-green-900/20 text-green-400'
      : subscription.status === 'canceled'
        ? 'bg-red-900/20 text-red-400'
        : 'bg-yellow-900/20 text-yellow-400';

  // Group issuances by issue_month
  const issuancesByMonth = new Map<string, typeof issuances>();
  for (const row of issuances) {
    const existing = issuancesByMonth.get(row.issueMonth) ?? [];
    existing.push(row);
    issuancesByMonth.set(row.issueMonth, existing);
  }

  // Latest month's base credits for the progress display
  const latestBase = issuances.find(r => r.itemKind === KiloPassIssuanceItemKind.Base);
  const latestBonus = issuances.find(
    r =>
      r.issueMonth === latestBase?.issueMonth &&
      (r.itemKind === KiloPassIssuanceItemKind.Bonus ||
        r.itemKind === KiloPassIssuanceItemKind.PromoFirstMonth50Pct)
  );
  const baseUsd = latestBase ? parseFloat(String(latestBase.itemAmountUsd)) : null;
  const bonusUsd = latestBonus ? parseFloat(String(latestBonus.itemAmountUsd)) : null;
  const totalAvailable = baseUsd != null ? baseUsd + (bonusUsd ?? 0) : null;

  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Coins className="h-5 w-5" /> Kilo Pass
        </CardTitle>
        <CardDescription>Subscription state, issuances, and usage thresholds</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Subscription Info */}
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          <div>
            <h4 className="text-muted-foreground text-xs font-medium">Status</h4>
            <Badge className={statusColor}>{subscription.status}</Badge>
            {subscription.cancelAtPeriodEnd && (
              <Badge className="ml-1 bg-yellow-900/20 text-yellow-400">cancels at period end</Badge>
            )}
          </div>
          <div>
            <h4 className="text-muted-foreground text-xs font-medium">Tier</h4>
            <p className="font-mono text-sm font-semibold">{subscription.tier}</p>
          </div>
          <div>
            <h4 className="text-muted-foreground text-xs font-medium">Cadence</h4>
            <p className="text-sm">{subscription.cadence}</p>
          </div>
          <div>
            <h4 className="text-muted-foreground text-xs font-medium">Streak</h4>
            <p className="font-mono text-sm">{subscription.currentStreakMonths} months</p>
          </div>
        </div>

        {/* Current Period Usage */}
        {currentPeriodUsageUsd != null && (
          <div className="rounded-lg border p-3">
            <h4 className="text-muted-foreground mb-2 text-xs font-medium">
              Current Period Usage (since base credits issued)
            </h4>
            <div className="flex items-baseline gap-3">
              <span className="font-mono text-xl font-bold">
                {formatUsd(currentPeriodUsageUsd)}
              </span>
              {totalAvailable != null && (
                <span className="text-muted-foreground text-sm">
                  / {formatUsd(totalAvailable)} ({formatUsd(baseUsd)} base
                  {bonusUsd != null && ` + ${formatUsd(bonusUsd)} bonus`})
                </span>
              )}
            </div>
            {totalAvailable != null && (
              <div className="bg-muted/50 mt-2 h-2 overflow-hidden rounded-full">
                <div
                  className={`h-full rounded-full transition-all ${
                    currentPeriodUsageUsd > totalAvailable
                      ? 'bg-red-500'
                      : currentPeriodUsageUsd > (baseUsd ?? 0)
                        ? 'bg-emerald-500'
                        : 'bg-amber-500'
                  }`}
                  style={{
                    width: `${Math.min(100, (currentPeriodUsageUsd / totalAvailable) * 100)}%`,
                  }}
                />
              </div>
            )}
          </div>
        )}

        {/* Thresholds */}
        {thresholds && (
          <div className="rounded-lg border p-3">
            <h4 className="text-muted-foreground mb-2 text-xs font-medium">Bonus Threshold</h4>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <span className="text-muted-foreground">kilo_pass_threshold:</span>{' '}
                <span className="font-mono">
                  {thresholds.kiloPassThreshold_mUsd != null
                    ? formatMicrodollars(thresholds.kiloPassThreshold_mUsd)
                    : 'null'}
                </span>
              </div>
              <div>
                <span className="text-muted-foreground">effective (−$1):</span>{' '}
                <span className="font-mono">
                  {thresholds.effectiveThreshold_mUsd != null
                    ? formatMicrodollars(thresholds.effectiveThreshold_mUsd)
                    : 'null'}
                </span>
              </div>
              <div>
                <span className="text-muted-foreground">microdollars_used:</span>{' '}
                <span className="font-mono">{formatMicrodollars(thresholds.microdollarsUsed)}</span>
              </div>
              <div>
                <span className="text-muted-foreground">bonus unlocked:</span>{' '}
                <Badge
                  className={
                    thresholds.bonusUnlocked
                      ? 'bg-green-900/20 text-green-400'
                      : 'bg-gray-800 text-gray-300'
                  }
                >
                  {thresholds.bonusUnlocked ? 'yes' : 'no'}
                </Badge>
              </div>
            </div>
            <div className="mt-3">
              <CheckKiloPassButton userId={userId} />
            </div>
          </div>
        )}

        {/* Issuance History */}
        <div>
          <h4 className="text-muted-foreground mb-2 text-xs font-medium">Issuance History</h4>
          <div className="bg-muted/50 rounded-md border">
            {[...issuancesByMonth.entries()].map(([month, items]) => (
              <div key={month} className="border-b p-3 last:border-b-0">
                <div className="mb-1 text-sm font-medium">{month}</div>
                <div className="space-y-1">
                  {items.map((item, i) => (
                    <div
                      key={`${month}-${item.itemKind}-${i}`}
                      className="text-muted-foreground flex items-center justify-between text-xs"
                    >
                      <div className="flex items-center gap-2">
                        <Badge
                          variant="outline"
                          className={
                            item.itemKind === KiloPassIssuanceItemKind.Base
                              ? 'border-amber-500/30 text-amber-400'
                              : 'border-emerald-500/30 text-emerald-400'
                          }
                        >
                          {item.itemKind}
                        </Badge>
                        <span className="font-mono">{formatUsd(item.itemAmountUsd)}</span>
                        {item.bonusPercentApplied != null && (
                          <span>
                            ({Math.round(parseFloat(String(item.bonusPercentApplied)) * 100)}%)
                          </span>
                        )}
                      </div>
                      <span>{formatDate(item.itemCreatedAt)}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
            {issuancesByMonth.size === 0 && (
              <div className="text-muted-foreground p-3 text-sm">No issuances yet</div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
