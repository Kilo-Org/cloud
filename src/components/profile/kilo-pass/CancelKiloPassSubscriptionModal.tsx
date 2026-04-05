import { Flame, Gift, ShieldAlert } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { KiloPassCadence, type KiloPassTier } from '@/lib/kilo-pass/enums';
import { computeMonthlyCadenceBonusPercent } from '@/lib/kilo-pass/bonus';
import { formatPercent } from './utils';

export function CancelKiloPassSubscriptionModal(props: {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  isLoading: boolean;
  cadence: KiloPassCadence;
  tier: KiloPassTier;
  currentStreakMonths: number | null | undefined;
  subscriptionActiveUntilLabel: string | null;
}) {
  const {
    isOpen,
    onClose,
    onConfirm,
    isLoading,
    cadence,
    tier,
    currentStreakMonths,
    subscriptionActiveUntilLabel,
  } = props;

  const showStreakWarning =
    cadence === KiloPassCadence.Monthly && typeof currentStreakMonths === 'number';

  const streakPercentLabel =
    showStreakWarning && currentStreakMonths != null && currentStreakMonths >= 1
      ? formatPercent(
          computeMonthlyCadenceBonusPercent({
            tier,
            streakMonths: currentStreakMonths + 1,
            isFirstTimeSubscriberEver: false,
            subscriptionStartedAtIso: null,
          })
        )
      : null;

  return (
    <Dialog
      open={isOpen}
      onOpenChange={open => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-amber-500" />
            Cancel Kilo Pass
          </DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-3 text-left">
              <div className="text-foreground font-medium">Are you sure?</div>

              {showStreakWarning && (
                <div className="border-border/60 bg-muted/20 grid gap-4 rounded-lg border px-3 py-2">
                  <div className="flex items-start gap-2">
                    <Flame className="mt-0.5 h-4 w-4 text-amber-500" />
                    <div>
                      <div className="text-foreground font-medium">
                        You&apos;re about to lose your streak
                        {streakPercentLabel ? ` (${streakPercentLabel} bonus credits)` : ''}.
                      </div>
                      <div className="text-muted-foreground text-sm">
                        If you re-subscribe later, your bonus ramp restarts from 5%.
                      </div>
                    </div>
                  </div>

                  <div className="flex items-start gap-2">
                    <Gift className="mt-0.5 h-4 w-4 text-red-400" />
                    <div>
                      <div className="text-foreground font-medium">
                        You won&apos;t be eligible for the 50% first-time subscriber bonus again.
                      </div>
                      <div className="text-muted-foreground text-sm">
                        This promotional offer is only available to first-time subscribers.
                      </div>
                    </div>
                  </div>
                </div>
              )}

              <div>
                Your subscription will remain active until the end of the current billing period
                {subscriptionActiveUntilLabel ? ` (${subscriptionActiveUntilLabel}).` : '.'}
              </div>
            </div>
          </DialogDescription>
        </DialogHeader>

        <DialogFooter className="flex gap-2">
          <Button variant="outline" onClick={onClose} disabled={isLoading}>
            Keep subscription
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={isLoading}>
            {isLoading ? 'Canceling...' : 'Yes, cancel'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
