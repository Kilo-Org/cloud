import { UsersRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { money, percentOf, sourceLabels, spendRangePeriodLabel } from '../formatting';
import { EmptyPanel } from '../shared/EmptyPanel';
import type { CostInsightsOwner, SpendDriver, SpendRange } from '../types';

export function TopDriversCard({
  drivers,
  period,
  owner,
  memberLimitsHref,
}: {
  drivers: SpendDriver[];
  period: SpendRange;
  owner: CostInsightsOwner;
  memberLimitsHref?: string;
}) {
  const total = drivers.reduce((sum, driver) => sum + driver.spendUsd, 0);
  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle className="type-heading">Where spend went</CardTitle>
        <CardDescription>Largest contributors in {spendRangePeriodLabel(period)}.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {drivers.length === 0 ? (
          <EmptyPanel
            title="No spend drivers"
            description="Products and members will appear after Credit spend is recorded."
          />
        ) : (
          <ol className="grid gap-x-8 gap-y-6 overflow-hidden lg:grid-cols-2">
            {drivers.slice(0, 5).map(driver => (
              <li
                key={driver.id}
                className="border-border min-w-0 border-t pt-5 first:border-t-0 first:pt-0 lg:[&:nth-child(2)]:border-t-0 lg:[&:nth-child(2)]:pt-0"
              >
                <DriverRow
                  driver={driver}
                  total={total}
                  showMember={owner.type === 'organization'}
                />
              </li>
            ))}
          </ol>
        )}
        {owner.type === 'organization' && memberLimitsHref && (
          <Button
            asChild
            type="button"
            variant="outline"
            className="min-h-control-touch w-full sm:min-h-0"
          >
            <a href={memberLimitsHref}>
              <UsersRound className="size-4" aria-hidden="true" />
              Manage member daily limits
            </a>
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function DriverRow({
  driver,
  total,
  showMember,
}: {
  driver: SpendDriver;
  total: number;
  showMember: boolean;
}) {
  const row = (
    <div
      className={cn(
        driver.href &&
          'hover:bg-surface-hover focus-visible:ring-ring -mx-2 rounded-md px-2 py-2 focus-visible:ring-2 focus-visible:outline-none'
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="type-body font-medium break-words">{driver.label}</div>
          <dl className="mt-2 grid gap-x-4 gap-y-1 type-label text-muted-foreground sm:grid-cols-2">
            <div>
              <dt className="sr-only">Product</dt>
              <dd>{sourceLabels[driver.source]}</dd>
            </div>
            {showMember && (
              <div>
                <dt className="sr-only">Member</dt>
                <dd>{driver.actorLabel ?? 'No member attributed'}</dd>
              </div>
            )}
            {driver.modelOrProvider && (
              <div className="sm:col-span-2">
                <dt className="sr-only">Model or provider</dt>
                <dd>{driver.modelOrProvider}</dd>
              </div>
            )}
          </dl>
        </div>
        <div className="max-w-28 shrink-0 text-right sm:max-w-none">
          <div className="type-body font-mono font-semibold tabular-nums">
            {money(driver.spendUsd)}
          </div>
          <div className="type-label text-muted-foreground">
            {percentOf(driver.spendUsd, total)}% of shown spend
          </div>
        </div>
      </div>
      <div
        className="bg-surface-overlay mt-3 h-1.5 overflow-hidden rounded-full"
        aria-hidden="true"
      >
        <div
          className="bg-chart-1 h-full rounded-full"
          style={{ width: `${percentOf(driver.spendUsd, total)}%` }}
        />
      </div>
    </div>
  );
  return driver.href ? (
    <a href={driver.href} className="block min-w-0">
      {row}
    </a>
  ) : (
    row
  );
}
