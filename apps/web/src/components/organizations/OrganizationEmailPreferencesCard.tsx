'use client';

import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Bell, ChartLine, Mail } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useOrganizationWithMembers } from '@/app/api/organizations/hooks';
import { SpendingAlertsModal } from './SpendingAlertsModal';
import { AdoptionDigestModal } from './AdoptionDigestModal';

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
  onConfigure,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  stateLabel: string;
  isOn: boolean;
  onConfigure: () => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-4 first:pt-0 last:pb-0">
      <div className="flex items-start gap-3">
        <Icon className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0" />
        <div className="space-y-1">
          <p className="text-sm font-medium">{title}</p>
          <p className="text-muted-foreground text-xs">{description}</p>
          <p className="text-muted-foreground text-xs tabular-nums">
            <span className={isOn ? 'text-foreground font-medium' : undefined}>{stateLabel}</span>
          </p>
        </div>
      </div>
      <Button variant="outline" size="sm" className="h-8 shrink-0" onClick={onConfigure}>
        Configure
      </Button>
    </div>
  );
}

export function OrganizationEmailPreferencesCard({ organizationId }: Props) {
  const { data } = useOrganizationWithMembers(organizationId);
  const [isSpendingAlertsOpen, setIsSpendingAlertsOpen] = useState(false);
  const [isDigestOpen, setIsDigestOpen] = useState(false);

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
  const digestRecipientCount = settings?.adoption_digest_email?.length ?? 0;

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
            onConfigure={() => setIsSpendingAlertsOpen(true)}
          />
          {isEnterprise && (
            <PreferenceRow
              icon={ChartLine}
              title="Weekly adoption digest"
              description="A weekly summary of adopted features and open recommendations."
              stateLabel={recipientStateLabel(digestRecipientCount)}
              isOn={digestRecipientCount > 0}
              onConfigure={() => setIsDigestOpen(true)}
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
      <AdoptionDigestModal
        open={isDigestOpen}
        onOpenChange={setIsDigestOpen}
        organizationId={organizationId}
        settings={settings}
      />
    </Card>
  );
}
