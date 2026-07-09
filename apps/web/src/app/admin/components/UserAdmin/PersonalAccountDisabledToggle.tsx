'use client';

import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useTRPC } from '@/lib/trpc/utils';

export default function PersonalAccountDisabledToggle({
  userId,
  initialValue,
  isInOrganization,
}: {
  userId: string;
  initialValue: boolean;
  isInOrganization: boolean;
}) {
  const trpc = useTRPC();
  const router = useRouter();

  // UI is framed positively (the switch reflects whether the personal account
  // is enabled) while the stored flag is `personal_account_disabled`, so
  // `enabled` is its inverse.
  const [enabled, setEnabled] = useState(!initialValue);

  // Re-sync with the server value after router.refresh() re-renders the page.
  useEffect(() => {
    setEnabled(!initialValue);
  }, [initialValue]);

  const { mutate, isPending } = useMutation(
    trpc.admin.users.setPersonalAccountDisabled.mutationOptions({
      onSuccess: (_result, variables) => {
        toast.success(
          variables.value
            ? 'Personal account disabled for this user'
            : 'Personal account re-enabled for this user'
        );
        router.refresh();
      },
      onError: err => {
        setEnabled(!initialValue);
        toast.error(`Failed to update personal account: ${err.message}`);
      },
    })
  );

  const switchNode = (
    <Switch
      checked={enabled}
      disabled={isPending || !isInOrganization}
      onCheckedChange={nextEnabled => {
        setEnabled(nextEnabled);
        mutate({ userId, value: !nextEnabled });
      }}
      aria-label="Personal account enabled"
      className={!isInOrganization ? 'pointer-events-none' : undefined}
    />
  );

  // A disabled switch doesn't emit hover events, so the tooltip trigger is a
  // focusable wrapper around it.
  if (!isInOrganization) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0} className="inline-flex">
            {switchNode}
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          Only users who belong to an organization can have their personal account disabled.
        </TooltipContent>
      </Tooltip>
    );
  }

  return switchNode;
}
