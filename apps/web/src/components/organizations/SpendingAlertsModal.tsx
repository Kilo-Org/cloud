'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
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
import { Checkbox } from '@/components/ui/checkbox';
import type { OrganizationSettings } from '@/lib/organizations/organization-types';
import { Loader2, Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { useUpdateMinimumBalanceAlert } from '@/app/api/organizations/hooks';

type SpendingAlertsModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organizationId: string;
  settings: OrganizationSettings | undefined;
};

const isValidEmail = (email: string): boolean => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email.trim());
};

export function SpendingAlertsModal({
  open,
  onOpenChange,
  organizationId,
  settings,
}: SpendingAlertsModalProps) {
  // Determine if alerts are currently enabled based on settings
  const currentlyEnabled =
    settings?.minimum_balance !== undefined &&
    settings?.minimum_balance_alert_email !== undefined &&
    settings.minimum_balance_alert_email.length > 0;

  const [enabled, setEnabled] = useState(currentlyEnabled);
  const [minimumBalance, setMinimumBalance] = useState<string>(
    settings?.minimum_balance !== undefined ? settings.minimum_balance.toString() : ''
  );
  const [emails, setEmails] = useState<string[]>(settings?.minimum_balance_alert_email ?? []);
  const [newEmail, setNewEmail] = useState('');
  const [emailError, setEmailError] = useState<string | null>(null);

  const updateMinimumBalanceAlertMutation = useUpdateMinimumBalanceAlert();

  // Sync form state with settings when dialog opens
  useEffect(() => {
    if (open) {
      const isEnabled =
        settings?.minimum_balance !== undefined &&
        settings?.minimum_balance_alert_email !== undefined &&
        settings.minimum_balance_alert_email.length > 0;
      setEnabled(isEnabled);
      setMinimumBalance(
        settings?.minimum_balance !== undefined ? settings.minimum_balance.toString() : ''
      );
      setEmails(settings?.minimum_balance_alert_email ?? []);
      setNewEmail('');
      setEmailError(null);
    }
  }, [open, settings]);

  const handleAddEmail = () => {
    const trimmedEmail = newEmail.trim();
    if (!trimmedEmail) {
      return;
    }

    if (!isValidEmail(trimmedEmail)) {
      setEmailError('Please enter a valid email address');
      return;
    }

    if (emails.includes(trimmedEmail)) {
      setEmailError('This email is already in the list');
      return;
    }

    setEmails([...emails, trimmedEmail]);
    setNewEmail('');
    setEmailError(null);
  };

  const handleRemoveEmail = (emailToRemove: string) => {
    setEmails(emails.filter(email => email !== emailToRemove));
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAddEmail();
    }
  };

  const parsedBalance = parseFloat(minimumBalance);
  const isBalanceValid = !enabled || (!isNaN(parsedBalance) && parsedBalance > 0);
  const hasEmails = !enabled || emails.length > 0;
  const canSave = isBalanceValid && hasEmails;

  const handleSave = () => {
    if (!canSave) {
      if (!isBalanceValid) {
        toast.error('Please enter a valid minimum balance greater than $0');
      } else if (!hasEmails) {
        toast.error('Please add at least one email address');
      }
      return;
    }

    updateMinimumBalanceAlertMutation.mutate(
      {
        organizationId,
        enabled,
        minimum_balance: enabled ? parsedBalance : undefined,
        minimum_balance_alert_email: enabled ? emails : undefined,
      },
      {
        onSuccess: () => {
          toast.success(
            enabled
              ? `Spending alert configured: notify when balance falls below $${parsedBalance.toFixed(2)}`
              : 'Spending alerts disabled'
          );
          onOpenChange(false);
        },
        onError: (error: unknown) => {
          toast.error(
            error instanceof Error ? error.message : 'Failed to update spending alert settings'
          );
        },
      }
    );
  };

  const handleClose = () => {
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Configure Minimum Balance Alerts</DialogTitle>
          <DialogDescription>
            Get notified when your organization&apos;s balance falls below a threshold.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          {/* Enable/Disable checkbox */}
          <div className="flex items-center space-x-2">
            <Checkbox
              id="enableAlerts"
              checked={enabled}
              onCheckedChange={checked => setEnabled(checked === true)}
            />
            <Label htmlFor="enableAlerts" className="cursor-pointer">
              Enable minimum balance alerts
            </Label>
          </div>

          {/* Minimum balance input - only shown when enabled */}
          {enabled && (
            <>
              <div className="space-y-2">
                <Label htmlFor="minimumBalance">Minimum Balance Threshold (USD)</Label>
                <div className="relative">
                  <span className="text-muted-foreground absolute top-1/2 left-3 -translate-y-1/2">
                    $
                  </span>
                  <Input
                    id="minimumBalance"
                    type="number"
                    min="0.01"
                    step="0.01"
                    placeholder="100.00"
                    value={minimumBalance}
                    onChange={e => setMinimumBalance(e.target.value)}
                    className={`pl-8 ${!isBalanceValid ? 'border-red-500 focus:border-red-500' : ''}`}
                  />
                </div>
                <p className="text-muted-foreground text-xs">
                  You&apos;ll receive an alert when your balance falls below this amount.
                </p>
              </div>

              {/* Email list */}
              <div className="space-y-2">
                <Label>Notification Emails</Label>
                <div className="flex gap-2">
                  <Input
                    type="email"
                    placeholder="email@example.com"
                    value={newEmail}
                    onChange={e => {
                      setNewEmail(e.target.value);
                      setEmailError(null);
                    }}
                    onKeyDown={handleKeyDown}
                    className={emailError ? 'border-red-500 focus:border-red-500' : ''}
                  />
                  <Button type="button" variant="outline" size="icon" onClick={handleAddEmail}>
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
                {emailError && <p className="text-sm text-red-600">{emailError}</p>}

                {/* Email list display */}
                {emails.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {emails.map(email => (
                      <div
                        key={email}
                        className="bg-muted flex items-center justify-between rounded-md px-3 py-2 text-sm"
                      >
                        <span>{email}</span>
                        <button
                          type="button"
                          onClick={() => handleRemoveEmail(email)}
                          className="text-muted-foreground hover:text-foreground"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {emails.length === 0 && (
                  <p className="text-muted-foreground text-xs">
                    Add at least one email address to receive alerts.
                  </p>
                )}
              </div>
            </>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={handleClose}
            disabled={updateMinimumBalanceAlertMutation.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={!canSave || updateMinimumBalanceAlertMutation.isPending}
          >
            {updateMinimumBalanceAlertMutation.isPending && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
