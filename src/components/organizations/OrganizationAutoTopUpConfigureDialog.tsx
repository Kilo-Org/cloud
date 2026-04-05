'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
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
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { useTRPC } from '@/lib/trpc/utils';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ORG_AUTO_TOP_UP_AMOUNTS_CENTS,
  ORG_AUTO_TOP_UP_THRESHOLD_DOLLARS,
  DEFAULT_ORG_AUTO_TOP_UP_AMOUNT_CENTS,
  type OrgAutoTopUpAmountCents,
} from '@/lib/autoTopUpConstants';
import { formatCents, formatPaymentMethodDescription } from '@/lib/utils';

type Props = {
  organizationId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function OrganizationAutoTopUpConfigureDialog({
  organizationId,
  open,
  onOpenChange,
}: Props) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const { data: configData } = useQuery(
    trpc.organizations.autoTopUp.getConfig.queryOptions({ organizationId })
  );

  const currentAmount = configData?.amountCents ?? DEFAULT_ORG_AUTO_TOP_UP_AMOUNT_CENTS;
  const paymentMethodInfo = configData?.paymentMethod ?? null;
  const hasExistingPaymentMethod = paymentMethodInfo && paymentMethodInfo.stripePaymentMethodId;

  const [selectedAmount, setSelectedAmount] = useState<OrgAutoTopUpAmountCents>(currentAmount);

  // Sync selectedAmount when modal opens
  useEffect(() => {
    if (open) {
      setSelectedAmount(currentAmount);
    }
  }, [open, currentAmount]);

  const toggleMutation = useMutation(
    trpc.organizations.autoTopUp.toggle.mutationOptions({
      onSuccess: result => {
        if ('redirectUrl' in result) {
          toast.info('Redirecting to set up payment method...');
          window.location.href = result.redirectUrl;
          return;
        }

        toast.success(`Automatic top up ${result.enabled ? 'enabled' : 'disabled'}`);

        void queryClient.invalidateQueries({
          queryKey: trpc.organizations.autoTopUp.getConfig.queryKey({ organizationId }),
        });
      },
      onError: () => {
        toast.error('Failed to update settings');
      },
    })
  );

  const removePaymentMethodMutation = useMutation(
    trpc.organizations.autoTopUp.removePaymentMethod.mutationOptions({
      onSuccess: () => {
        toast.success('Payment method removed');
        void queryClient.invalidateQueries({
          queryKey: trpc.organizations.autoTopUp.getConfig.queryKey({ organizationId }),
        });
      },
      onError: () => {
        toast.error('Failed to remove payment method');
      },
    })
  );

  const handleEnableAutoTopUp = () => {
    onOpenChange(false);
    toggleMutation.mutate({ organizationId, currentEnabled: false, amountCents: selectedAmount });
  };

  const isPending = toggleMutation.isPending || removePaymentMethodMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader className="text-left">
          <DialogTitle>Configure Automatic Top Up</DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-3 pt-2">
              <p>
                Automatic top up keeps your organization funded so your team can use Kilo Code
                without interruption.
              </p>
              <p>
                <strong>How it works:</strong>
              </p>
              <ul className="list-disc space-y-1 pl-5">
                {!hasExistingPaymentMethod && (
                  <li>
                    To verify your payment method works, you&apos;ll be charged once immediately
                    when you enable this feature.
                  </li>
                )}
                <li>
                  When your organization balance falls below ${ORG_AUTO_TOP_UP_THRESHOLD_DOLLARS},
                  we&apos;ll automatically charge your payment method.
                </li>
                <li>
                  If a payment ever fails, we'll email you and pause auto top ups to prevent repeat
                  charges; you can resume automatic top ups at any time.
                </li>
                <li>You can disable automatic top up at any time.</li>
                <li>As always, purchased credits never expire.</li>
              </ul>
            </div>
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-3 py-2">
          <Label htmlFor="topup-amount-dialog">Top up amount:</Label>
          <Select
            value={String(selectedAmount)}
            onValueChange={value =>
              setSelectedAmount(parseInt(value, 10) as OrgAutoTopUpAmountCents)
            }
          >
            <SelectTrigger className="w-24" id="topup-amount-dialog">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ORG_AUTO_TOP_UP_AMOUNTS_CENTS.map(option => (
                <SelectItem key={option} value={String(option)}>
                  {formatCents(option)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <DialogFooter className="flex-col gap-4 sm:flex-col">
          {hasExistingPaymentMethod ? (
            <div className="flex flex-col gap-4 sm:flex-row">
              <div className="flex flex-1 flex-col justify-between gap-2">
                <h4 className="font-medium">Use existing payment method</h4>
                <span className="text-muted-foreground text-sm">
                  Your existing payment method ({formatPaymentMethodDescription(paymentMethodInfo)})
                  will be used for automatic top ups when your balance falls below $
                  {ORG_AUTO_TOP_UP_THRESHOLD_DOLLARS}.
                </span>
                <Button
                  onClick={handleEnableAutoTopUp}
                  disabled={isPending}
                  data-ph-action="enable-org-autotopup"
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
                    onOpenChange(false);
                    removePaymentMethodMutation.mutate({ organizationId });
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
                balance falls below ${ORG_AUTO_TOP_UP_THRESHOLD_DOLLARS}.
              </span>
              <Button
                onClick={handleEnableAutoTopUp}
                disabled={isPending}
                data-ph-action="enable-org-autotopup"
              >
                Enable automatic top up
              </Button>
            </div>
          )}
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
