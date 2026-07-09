import { UsersRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
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
    <section className="min-w-0" aria-labelledby="top-drivers-title">
      <div className="mb-4">
        <h3 id="top-drivers-title" className="type-heading">
          Largest contributors in {spendRangePeriodLabel(period)}
        </h3>
      </div>
      <div className="space-y-4">
        {drivers.length === 0 ? (
          <EmptyPanel
            title="No spend drivers"
            description="Products and members will appear after Credit spend is recorded."
          />
        ) : (
          <ol className="divide-border divide-y overflow-hidden">
            {drivers.slice(0, 5).map(driver => (
              <li key={driver.id} className="min-w-0 py-5 first:pt-0 last:pb-0">
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
      </div>
    </section>
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
  const share = percentOf(driver.spendUsd, total);
  const row = (
    <div
      className={cn(
        driver.href &&
          'hover:bg-surface-hover focus-visible:ring-ring -mx-2 rounded-md px-2 py-2 focus-visible:ring-2 focus-visible:outline-none'
      )}
    >
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_12rem] sm:items-start">
        <div className="min-w-0">
          <div className="type-body font-medium break-words">{driver.label}</div>
          <dl className="mt-3 grid gap-x-6 gap-y-3 sm:grid-cols-[minmax(8rem,1fr)_minmax(8rem,1fr)_minmax(10rem,1.5fr)]">
            {showMember && (
              <div className="min-w-0">
                <dt className="type-eyebrow text-foreground-subtle">Member</dt>
                <dd className="type-label text-muted-foreground mt-1 break-words">
                  {driver.actorLabel ?? 'No member attributed'}
                </dd>
              </div>
            )}
            <div className="min-w-0">
              <dt className="type-eyebrow text-foreground-subtle">Source</dt>
              <dd className="type-label text-muted-foreground mt-1 break-words">
                {sourceLabels[driver.source]}
              </dd>
            </div>
            {driver.modelOrProvider && (
              <div className="min-w-0">
                <dt className="type-eyebrow text-foreground-subtle">
                  {driver.modelOrProviderLabel ?? 'Model'}
                </dt>
                <dd className="type-label text-muted-foreground mt-1 break-words">
                  {driver.modelOrProvider}
                </dd>
              </div>
            )}
          </dl>
        </div>
        <div className="sm:text-right">
          <div className="type-body font-mono font-semibold tabular-nums">
            {money(driver.spendUsd)}
          </div>
          <div className="type-label text-muted-foreground mt-3 sm:whitespace-nowrap">
            {share}% of shown spend
          </div>
          <div
            className="bg-surface-overlay mt-2 h-1 overflow-hidden rounded-full"
            aria-hidden="true"
          >
            <div className="bg-chart-1 h-full rounded-full" style={{ width: `${share}%` }} />
          </div>
        </div>
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
