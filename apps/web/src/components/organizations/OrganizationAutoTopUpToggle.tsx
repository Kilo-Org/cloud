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
import { OrganizationAutoTopUpConfigureDialog } from './OrganizationAutoTopUpConfigureDialog';

type Props = {
  organizationId: string;
};

export function OrganizationAutoTopUpToggle({ organizationId }: Props) {
  const [configureModalOpen, setConfigureModalOpen] = useState(false);

  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const { data: configData, isLoading } = useQuery(
    trpc.organizations.autoTopUp.getConfig.queryOptions({ organizationId })
  );

  const enabled = configData?.enabled ?? false;
  const currentAmount = configData?.amountCents ?? DEFAULT_ORG_AUTO_TOP_UP_AMOUNT_CENTS;
  const paymentMethodInfo = configData?.paymentMethod ?? null;

  const [selectedAmount, setSelectedAmount] = useState<OrgAutoTopUpAmountCents>(currentAmount);

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

  const changePaymentMethodMutation = useMutation(
    trpc.organizations.autoTopUp.changePaymentMethod.mutationOptions({
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
    trpc.organizations.autoTopUp.updateAmount.mutationOptions({
      onSuccess: () => {
        toast.success('Automatic top up amount updated');
        void queryClient.invalidateQueries({
          queryKey: trpc.organizations.autoTopUp.getConfig.queryKey({ organizationId }),
        });
      },
      onError: () => {
        toast.error('Failed to update amount');
      },
    })
  );

  const handleToggle = (checked: boolean) => {
    if (checked) {
      return;
    }
    toggleMutation.mutate({
      organizationId,
      currentEnabled: !checked,
      amountCents: selectedAmount,
    });
  };

  const handleChangePaymentMethod = () => {
    changePaymentMethodMutation.mutate({ organizationId, amountCents: currentAmount });
  };

  const handleAmountChange = (value: string) => {
    const amountCents = parseInt(value, 10) as OrgAutoTopUpAmountCents;
    setSelectedAmount(amountCents);
    if (enabled) {
      updateAmountMutation.mutate({ organizationId, amountCents });
    }
  };

  const isPending =
    toggleMutation.isPending ||
    changePaymentMethodMutation.isPending ||
    updateAmountMutation.isPending;

  const displayAmount = enabled ? currentAmount : selectedAmount;

  if (isLoading) {
    return (
      <div className="mt-1 space-y-4">
        <p className="text-muted-foreground text-sm">Loading auto-top-up settings...</p>
      </div>
    );
  }

  if (!enabled) {
    return (
      <div className="mt-1 space-y-4">
        <p className="text-muted-foreground text-sm">
          Automatically top up your organization balance when it drops below $
          {ORG_AUTO_TOP_UP_THRESHOLD_DOLLARS}.
        </p>
        <Button
          variant="primary"
          onClick={() => setConfigureModalOpen(true)}
          data-ph-action="open-org-autotopup-config"
        >
          Configure automatic top up
        </Button>
        <OrganizationAutoTopUpConfigureDialog
          organizationId={organizationId}
          open={configureModalOpen}
          onOpenChange={setConfigureModalOpen}
        />
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
            data-ph-action="disable-org-autotopup"
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
            {ORG_AUTO_TOP_UP_AMOUNTS_CENTS.map(option => (
              <SelectItem key={option} value={String(option)}>
                {formatCents(option)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span>when balance drops below ${ORG_AUTO_TOP_UP_THRESHOLD_DOLLARS}.</span>
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
