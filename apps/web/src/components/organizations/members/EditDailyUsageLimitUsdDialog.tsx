'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { LockableContainer } from '../LockableContainer';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { OrganizationMember } from '@/lib/organizations/organization-types';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useUpdateDailyUsageLimitUsd } from '@/app/api/organizations/hooks';

const MAX_DAILY_LIMIT_USD = 2000;

type EditDailyUsageLimitUsdDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organizationId: string;
  member: OrganizationMember;
  onLimitUpdated: () => void;
};

const formatLimitValue = (limit: number | null): string => (limit !== null ? limit.toString() : '');

const formatLimitDisplay = (limit: number | null): string =>
  limit !== null ? `$${limit.toFixed(2)}` : 'Unlimited';

const parseAndValidateLimit = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return { parsed: null, isValid: true }; // Empty is valid for unlimited

  const parsed = parseFloat(trimmed);
  const isValid = !isNaN(parsed) && parsed >= 0 && parsed <= MAX_DAILY_LIMIT_USD;

  return { parsed: isValid ? parsed : null, isValid };
};

export function EditDailyUsageLimitUsdDialog({
  open,
  onOpenChange,
  organizationId,
  member,
  onLimitUpdated,
}: EditDailyUsageLimitUsdDialogProps) {
  const [limitValue, setLimitValue] = useState<string>(() =>
    formatLimitValue(member.dailyUsageLimitUsd)
  );
  const [isInputFocused, setIsInputFocused] = useState(false);

  const updateDailyUsageLimitUsdMutation = useUpdateDailyUsageLimitUsd();

  // Sync form state with member data when dialog opens or member changes
  useEffect(() => {
    if (open) {
      setLimitValue(formatLimitValue(member.dailyUsageLimitUsd));
    }
  }, [open, member.dailyUsageLimitUsd]);

  const { parsed: parsedLimit, isValid: isLimitValid } = parseAndValidateLimit(limitValue);
  const shouldShowError = limitValue.trim() && !isInputFocused && !isLimitValid;

  // Determine button text and styling based on the parsed limit
  const getButtonText = () => {
    if (parsedLimit === null) return 'Allow Unlimited';
    if (parsedLimit === 0) return 'Block Usage';
    return 'Update Limit';
  };

  const isBlockUsageButton = parsedLimit === 0;

  const handleUpdateLimit = () => {
    if (!isLimitValid) {
      toast.error('Please enter a valid daily usage limit');
      return;
    }

    // If empty, send null for unlimited; otherwise send the parsed value (including 0)
    const finalLimit = parsedLimit;

    if (member.status !== 'active') {
      toast.error('Cannot set limits for pending invitations');
      return;
    }

    updateDailyUsageLimitUsdMutation.mutate(
      {
        organizationId,
        memberId: member.id,
        dailyUsageLimitUsd: finalLimit,
      },
      {
        onSuccess: () => {
          const message =
            finalLimit === null
              ? 'Daily usage limit removed (unlimited)'
              : finalLimit === 0
                ? 'Daily usage limit set to $0.00 (no usage allowed)'
                : `Daily usage limit set to $${finalLimit.toFixed(2)}`;
          toast.success(message);
          onLimitUpdated();
          onOpenChange(false);
          handleReset();
        },
        onError: (error: unknown) => {
          toast.error(
            error instanceof Error ? error.message : 'Failed to update daily usage limit'
          );
        },
      }
    );
  };

  const handleReset = () => {
    setLimitValue(formatLimitValue(member.dailyUsageLimitUsd));
  };

  const handleClose = () => {
    onOpenChange(false);
    handleReset();
  };

  const memberName = member.status === 'active' ? member.name : member.email;
  const currentLimitText = formatLimitDisplay(member.dailyUsageLimitUsd);

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <LockableContainer>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>Edit Daily Usage Limit</DialogTitle>
            <DialogDescription>
              Set a daily spending limit for <strong>{memberName}</strong>.
            </DialogDescription>
            <DialogDescription>Current limit: {currentLimitText}</DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="dailyLimit">Daily Usage Limit (USD)</Label>
              <div className="flex min-h-[60px] flex-col justify-start">
                <div className="relative">
                  <span className="text-muted-foreground absolute top-1/2 left-3 -translate-y-1/2">
                    $
                  </span>
                  <Input
                    id="dailyLimit"
                    type="number"
                    min="0"
                    max={MAX_DAILY_LIMIT_USD.toString()}
                    step="0.01"
                    placeholder="0.00"
                    value={limitValue}
                    onChange={e => setLimitValue(e.target.value)}
                    onFocus={() => setIsInputFocused(true)}
                    onBlur={() => setIsInputFocused(false)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') {
                        handleUpdateLimit();
                      }
                    }}
                    className={`pl-8 ${shouldShowError ? 'border-red-500 focus:border-red-500' : ''}`}
                  />
                </div>
                {shouldShowError && (
                  <p className="mt-1 text-sm text-red-600">
                    Please enter a valid amount (0 to ${MAX_DAILY_LIMIT_USD})
                  </p>
                )}
                <p className="text-muted-foreground mt-1 text-xs">
                  Leave empty for unlimited usage, set to 0 to block all usage. Maximum limit is $
                  {MAX_DAILY_LIMIT_USD}.
                </p>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={handleClose}
              disabled={updateDailyUsageLimitUsdMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={handleUpdateLimit}
              disabled={!isLimitValid || updateDailyUsageLimitUsdMutation.isPending}
              variant={isBlockUsageButton ? 'destructive' : 'default'}
            >
              {updateDailyUsageLimitUsdMutation.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              {getButtonText()}
            </Button>
          </DialogFooter>
        </DialogContent>
      </LockableContainer>
    </Dialog>
  );
}
