'use client';

import { useState } from 'react';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { useTRPC } from '@/lib/trpc/utils';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AUTO_TOP_UP_AMOUNTS_CENTS,
  AUTO_TOP_UP_THRESHOLD_DOLLARS,
  DEFAULT_AUTO_TOP_UP_AMOUNT_CENTS,
  type AutoTopUpAmountCents,
} from '@/lib/autoTopUpConstants';
import { formatCents, formatPaymentMethodDescription } from '@/lib/utils';

export function AutoTopUpToggle() {
  const [configureModalOpen, setConfigureModalOpen] = useState(false);
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { data: autoTopUpInfo } = useQuery({
    ...trpc.user.getAutoTopUpPaymentMethod.queryOptions(),
  });
  const enabled = autoTopUpInfo?.enabled ?? false;
  const currentAmount = autoTopUpInfo?.amountCents ?? DEFAULT_AUTO_TOP_UP_AMOUNT_CENTS;
  const paymentMethodInfo = autoTopUpInfo?.paymentMethod;
  const [selectedAmount, setSelectedAmount] = useState<AutoTopUpAmountCents>(currentAmount);

  // Sync selectedAmount when modal opens (to pick up server value)
  const handleOpenChange = (open: boolean) => {
    if (open) {
      setSelectedAmount(currentAmount);
    }
    setConfigureModalOpen(open);
  };

  const toggleMutation = useMutation(
    trpc.user.toggleAutoTopUp.mutationOptions({
      onSuccess: result => {
        if ('redirectUrl' in result) {
          toast.info('Redirecting to set up payment method...');
          window.location.href = result.redirectUrl;
          return;
        }

        toast.success(`Automatic top up ${result.enabled ? 'enabled' : 'disabled'}`);
        void queryClient.invalidateQueries({
          queryKey: trpc.user.getAutoTopUpPaymentMethod.queryKey(),
        });
      },
      onError: () => {
        toast.error('Failed to update settings');
      },
    })
  );

  const changePaymentMethodMutation = useMutation(
    trpc.user.changeAutoTopUpPaymentMethod.mutationOptions({
      onSuccess: result => {
        toast.info('Redirecting to update payment method...');
        window.location.href = result.redirectUrl;
      },
      onError: () => {
        toast.error('Failed to create checkout session');
      },
    })
  );

  const updateAmountMutation = useMutation(
    trpc.user.updateAutoTopUpAmount.mutationOptions({
      onSuccess: () => {
        toast.success('Automatic top up amount updated');
        void queryClient.invalidateQueries({
          queryKey: trpc.user.getAutoTopUpPaymentMethod.queryKey(),
        });
      },
      onError: () => {
        toast.error('Failed to update amount');
      },
    })
  );

  const removePaymentMethodMutation = useMutation(
    trpc.user.removeAutoTopUpPaymentMethod.mutationOptions({
      onSuccess: () => {
        toast.success('Payment method removed');
        void queryClient.invalidateQueries({
          queryKey: trpc.user.getAutoTopUpPaymentMethod.queryKey(),
        });
      },
      onError: () => {
        toast.error('Failed to remove payment method');
      },
    })
  );

  const handleToggle = (checked: boolean) => {
    if (checked) {
      return;
    }
    toggleMutation.mutate({ currentEnabled: !checked, amountCents: selectedAmount });
  };

  const handleEnableAutoTopUp = () => {
    setConfigureModalOpen(false);
    toggleMutation.mutate({ currentEnabled: false, amountCents: selectedAmount });
  };

  const handleChangePaymentMethod = () => {
    changePaymentMethodMutation.mutate({ amountCents: currentAmount });
  };

  const handleAmountChange = (value: string) => {
    const amountCents = parseInt(value, 10) as 2000 | 5000 | 10000;
    setSelectedAmount(amountCents);
    if (enabled) {
      updateAmountMutation.mutate({ amountCents });
    }
  };

  const isPending =
    toggleMutation.isPending ||
    changePaymentMethodMutation.isPending ||
    updateAmountMutation.isPending ||
    removePaymentMethodMutation.isPending;

  const displayAmount = enabled ? currentAmount : selectedAmount;

  if (!enabled) {
    return (
      <div className="mt-1 space-y-4">
        <p className="text-muted-foreground text-sm">
          Automatically top up your balance when it drops below ${AUTO_TOP_UP_THRESHOLD_DOLLARS}.
        </p>

        <Dialog open={configureModalOpen} onOpenChange={handleOpenChange}>
          <DialogTrigger asChild>
            <Button variant="outline" data-ph-action="open-autotopup-config">
              Configure automatic top up
            </Button>
          </DialogTrigger>
          <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
            <DialogHeader className="text-left">
              <DialogTitle>Configure Automatic Top Up</DialogTitle>
              <DialogDescription asChild>
                <div className="space-y-3 pt-2">
                  <p>
                    Automatic top up keeps your account funded so you can use Kilo Code without
                    interruption.
                  </p>
                  <p>
                    <strong>How it works:</strong>
                  </p>
                  <ul className="list-disc space-y-1 pl-5">
                    {!paymentMethodInfo && (
                      <li>
                        To verify your payment method works, you&apos;ll be charged once immediately
                        when you enable this feature.
                      </li>
                    )}
                    <li>
                      When your balance falls below ${AUTO_TOP_UP_THRESHOLD_DOLLARS}, we&apos;ll
                      automatically charge your payment method.
                    </li>
                    <li>
                      If a payment ever fails, we'll email you and pause auto top ups to prevent
                      repeat charges; you can resume automatic top ups at any time.
                    </li>
                    <li>You can disable automatic top up at any time.</li>
                    <li>As always, purchased credits never expire.</li>
                  </ul>
                </div>
              </DialogDescription>
            </DialogHeader>

            <div className="flex items-center gap-3 py-2">
              <Label htmlFor="topup-amount">Top up amount:</Label>
              <Select
                value={String(selectedAmount)}
                onValueChange={value =>
                  setSelectedAmount(parseInt(value, 10) as AutoTopUpAmountCents)
                }
              >
                <SelectTrigger className="w-24" id="topup-amount">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {AUTO_TOP_UP_AMOUNTS_CENTS.map(option => (
                    <SelectItem key={option} value={String(option)}>
                      {formatCents(option)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <DialogFooter className="flex-col gap-4 sm:flex-col">
              {paymentMethodInfo ? (
                <div className="flex flex-col gap-4 sm:flex-row">
                  <div className="flex flex-1 flex-col justify-between gap-2">
                    <h4 className="font-medium">Use existing payment method</h4>
                    <span className="text-muted-foreground text-sm">
                      Your existing payment method (
                      {formatPaymentMethodDescription(paymentMethodInfo)}) will be used for
                      automatic top ups when your balance falls below $
                      {AUTO_TOP_UP_THRESHOLD_DOLLARS}.
                    </span>
                    <Button
                      onClick={handleEnableAutoTopUp}
                      disabled={isPending}
                      data-ph-action="enable-autotopup"
                    >
                      Enable automatic top up
                    </Button>
                  </div>
                  <div className="border-border flex flex-1 flex-col justify-between gap-2 border-t pt-4 sm:border-t-0 sm:border-l sm:pt-0 sm:pl-4">
                    <h4 className="font-medium">Remove payment method</h4>
                    <span className="text-muted-foreground text-sm">
                      Removes your saved payment method for automatic top ups.
                    </span>
                    <Button
                      variant="outline"
                      onClick={() => {
                        setConfigureModalOpen(false);
                        removePaymentMethodMutation.mutate();
                      }}
                      disabled={isPending}
                    >
                      Remove payment method
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  <span className="text-muted-foreground text-sm">
                    Top up once now to verify your payment method, then automatically whenever your
                    balance falls below ${AUTO_TOP_UP_THRESHOLD_DOLLARS}.
                  </span>
                  <Button
                    onClick={handleEnableAutoTopUp}
                    disabled={isPending}
                    data-ph-action="enable-autotopup"
                  >
                    Enable automatic top up
                  </Button>
                </div>
              )}
              <Button variant="outline" onClick={() => setConfigureModalOpen(false)}>
                Cancel
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  return (
    <div className="mt-1 space-y-4">
      <div className="text-muted-foreground flex items-center gap-4 text-sm">
        <Label className="flex cursor-pointer items-center space-x-2">
          <Switch
            checked={enabled}
            onCheckedChange={handleToggle}
            disabled={isPending}
            data-ph-action="disable-autotopup"
          />
          <span>Automatically top up</span>
        </Label>
        <Select
          value={String(displayAmount)}
          onValueChange={handleAmountChange}
          disabled={isPending}
        >
          <SelectTrigger className="w-24">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {AUTO_TOP_UP_AMOUNTS_CENTS.map(option => (
              <SelectItem key={option} value={String(option)}>
                {formatCents(option)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span>when your balance drops below ${AUTO_TOP_UP_THRESHOLD_DOLLARS}.</span>
      </div>
      <p className="text-muted-foreground text-sm">
        You can disable automatic top ups at any time. If a payment fails, automatic top up will be
        disabled to prevent repeated charges.
        {paymentMethodInfo && paymentMethodInfo.type && (
          <> Top ups use your {formatPaymentMethodDescription(paymentMethodInfo)}.</>
        )}
      </p>
      {paymentMethodInfo && paymentMethodInfo.type && (
        <div className="text-muted-foreground flex items-center gap-3 text-sm">
          <Button
            variant="outline"
            size="sm"
            onClick={handleChangePaymentMethod}
            disabled={isPending}
          >
            Change payment method
          </Button>
          Triggers an immediate top up to verify the new payment method.
        </div>
      )}
    </div>
  );
}
