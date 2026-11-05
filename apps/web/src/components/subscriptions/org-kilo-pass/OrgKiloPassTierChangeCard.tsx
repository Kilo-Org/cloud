// React must be in scope for the classic JSX runtime used by the jest transform.
import React from 'react';
import { CalendarDays, Loader2 } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { formatOrgPassMoney } from './formatters';
import type { OrgKiloPassTier, OrgKiloPassTierChange } from './types';

export type OrgKiloPassTierChangePendingAction = 'change_tier' | 'cancel_tier_change' | null;

export function OrgKiloPassTierChangeCard({
  tierChange,
  paidThrough,
  totalPasses,
  pendingAction,
}: {
  tierChange: OrgKiloPassTierChange;
  paidThrough: string;
  totalPasses: number;
  pendingAction: OrgKiloPassTierChangePendingAction;
}) {
  const [open, setOpen] = React.useState(false);
  const [selected, setSelected] = React.useState<OrgKiloPassTier | null>(null);
  const { pending, blockedReason, availableTerms, currentTier } = tierChange;
  const isChanging = pendingAction === 'change_tier';
  const isCancelling = pendingAction === 'cancel_tier_change';
  const target = availableTerms.find(terms => terms.tier === selected);
  const current = availableTerms.find(terms => terms.tier === currentTier);

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 pb-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle>Kilo Pass tier</CardTitle>
          <p className="mt-1 type-body text-muted-foreground">
            Upgrades apply to every paid seat at the next monthly renewal. Credits already added
            keep their terms.
          </p>
        </div>
        {pending ? (
          <Button
            type="button"
            variant="outline"
            className="shrink-0"
            onClick={tierChange.onCancelPendingChange}
            disabled={isCancelling}
          >
            {isCancelling ? 'Cancelling change' : 'Cancel scheduled change'}
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            className="shrink-0"
            onClick={() => {
              setSelected(null);
              setOpen(true);
            }}
            disabled={blockedReason !== undefined || availableTerms.length === 0}
          >
            Change tier
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {pending ? (
          <Alert>
            <CalendarDays />
            <AlertTitle>Tier change scheduled</AlertTitle>
            <AlertDescription>
              Your Kilo Pass moves to {pending.terms.tierName} (
              {formatOrgPassMoney(pending.terms.pricePerPassUsd)} per pass) on {pending.effectiveAt}
              . Until then you stay on {current?.tierName ?? 'your current tier'}.
            </AlertDescription>
          </Alert>
        ) : null}
        {!pending && !blockedReason && availableTerms.length === 0 ? (
          <p className="type-body text-muted-foreground">You are on the highest Kilo Pass tier.</p>
        ) : null}
        {!pending && blockedReason ? (
          <p className="type-body text-muted-foreground">{blockedReason}</p>
        ) : null}
      </CardContent>

      <Dialog open={open} onOpenChange={next => !isChanging && setOpen(next)}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Change Kilo Pass tier</DialogTitle>
            <DialogDescription>
              The new tier starts on {paidThrough}, when your seat subscription renews. You are not
              charged today.
            </DialogDescription>
          </DialogHeader>
          <div role="radiogroup" aria-label="Kilo Pass tier" className="grid gap-2">
            {availableTerms.map(terms => {
              const isCurrent = terms.tier === currentTier;
              const isSelected = terms.tier === selected;
              return (
                <button
                  key={terms.tier}
                  type="button"
                  role="radio"
                  aria-checked={isSelected}
                  disabled={isCurrent || isChanging}
                  onClick={() => setSelected(terms.tier)}
                  className={cn(
                    'flex w-full items-center justify-between rounded-md border p-3 text-left',
                    isSelected && 'border-primary',
                    isCurrent && 'opacity-60'
                  )}
                >
                  <span>
                    <span className="block font-medium">
                      {terms.tierName}
                      {isCurrent ? ' (current)' : ''}
                    </span>
                    <span className="type-label text-muted-foreground">
                      {formatOrgPassMoney(terms.baseCreditsPerPassUsd)} Credits and up to{' '}
                      {formatOrgPassMoney(terms.bonusCreditsPerPassUsd)} bonus per pass each month
                    </span>
                  </span>
                  <span className="type-body">
                    {formatOrgPassMoney(terms.pricePerPassUsd)} / pass
                  </span>
                </button>
              );
            })}
          </div>
          {target ? (
            <p className="type-label text-muted-foreground">
              {totalPasses} paid seats at {formatOrgPassMoney(target.pricePerPassUsd)} per pass,
              billed with your seats.
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={isChanging}
            >
              Keep current tier
            </Button>
            <Button
              type="button"
              disabled={!selected || isChanging}
              onClick={() => {
                if (!selected) return;
                tierChange.onChangeTier(selected);
                setOpen(false);
              }}
            >
              {isChanging ? (
                <>
                  <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden />
                  Scheduling change
                </>
              ) : (
                'Schedule tier change'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
