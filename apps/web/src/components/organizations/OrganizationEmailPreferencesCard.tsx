'use client';

import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Bell, ChartLine, Mail } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import {
  useOrganizationWithMembers,
  useUpdateRecommendationsDigest,
} from '@/app/api/organizations/hooks';
import { SpendingAlertsModal } from './SpendingAlertsModal';

type Props = {
  organizationId: string;
};

function recipientStateLabel(recipientCount: number): string {
  if (recipientCount === 0) {
    return 'Off';
  }
  return `On · ${recipientCount} recipient${recipientCount === 1 ? '' : 's'}`;
}

function PreferenceRow({
  icon: Icon,
  title,
  description,
  stateLabel,
  isOn,
  control,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  stateLabel?: string;
  isOn?: boolean;
  control: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-4 first:pt-0 last:pb-0">
      <div className="flex items-start gap-3">
        <Icon className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0" />
        <div className="space-y-1">
          <p className="text-sm font-medium">{title}</p>
          <p className="text-muted-foreground text-xs">{description}</p>
          {stateLabel && (
            <p className="text-muted-foreground text-xs tabular-nums">
              <span className={isOn ? 'text-foreground font-medium' : undefined}>{stateLabel}</span>
            </p>
          )}
        </div>
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}

export function OrganizationEmailPreferencesCard({ organizationId }: Props) {
  const { data } = useOrganizationWithMembers(organizationId);
  const [isSpendingAlertsOpen, setIsSpendingAlertsOpen] = useState(false);
  const updateRecommendationsDigest = useUpdateRecommendationsDigest();

  if (!data) {
    return null;
  }

  const settings = data.settings;
  const isEnterprise = data.plan === 'enterprise';

  // Low-balance alerts are "on" only when both a threshold and at least one
  // recipient are configured (matches SpendingAlertsModal's enabled check).
  const spendingRecipientCount =
    settings?.minimum_balance !== undefined
      ? (settings?.minimum_balance_alert_email?.length ?? 0)
      : 0;
  const digestEnabled = settings?.recommendations_digest_enabled === true;

  const handleDigestToggle = (next: boolean) => {
    updateRecommendationsDigest.mutate(
      { organizationId, enabled: next },
      {
        onSuccess: () => {
          toast.success(
            next
              ? 'Weekly recommendations email enabled. Organization owners will receive it.'
              : 'Weekly recommendations email disabled.'
          );
        },
        onError: (error: unknown) => {
          toast.error(
            error instanceof Error
              ? error.message
              : 'Failed to update the recommendations digest setting'
          );
        },
      }
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <Mail className="mr-2 inline h-5 w-5" />
          Email preferences
        </CardTitle>
        <CardDescription>Choose which emails this organization receives.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="divide-border divide-y">
          <PreferenceRow
            icon={Bell}
            title="Low balance alerts"
            description="Notify recipients when the organization balance falls below a threshold."
            stateLabel={recipientStateLabel(spendingRecipientCount)}
            isOn={spendingRecipientCount > 0}
            control={
              <Button
                variant="outline"
                size="sm"
                className="h-8"
                onClick={() => setIsSpendingAlertsOpen(true)}
              >
                Configure
              </Button>
            }
          />
          {isEnterprise && (
            <PreferenceRow
              icon={ChartLine}
              title="Weekly recommendations email"
              description="Email the organization's owners a weekly summary of open recommendations and feature setup."
              control={
                <Switch
                  checked={digestEnabled}
                  disabled={updateRecommendationsDigest.isPending}
                  onCheckedChange={handleDigestToggle}
                  aria-label="Weekly recommendations email"
                />
              }
            />
          )}
        </div>
      </CardContent>

      <SpendingAlertsModal
        open={isSpendingAlertsOpen}
        onOpenChange={setIsSpendingAlertsOpen}
        organizationId={organizationId}
        settings={settings}
      />
    </Card>
  );
}
