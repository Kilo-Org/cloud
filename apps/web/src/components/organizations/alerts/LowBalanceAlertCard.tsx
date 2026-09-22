'use client';

import { Wallet } from 'lucide-react';
import { useState } from 'react';
import { useOrganizationWithMembers } from '@/app/api/organizations/hooks';
import { SpendingAlertsModal } from '@/components/organizations/SpendingAlertsModal';
import {
  lowBalanceAlertRecipientCount,
  lowBalanceAlertStateLabel,
} from '@/components/organizations/spending-alerts-form';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * The low balance alert is a single legacy organization setting, not a
 * collection-backed alert. It is shown here so Alerts is the only destination
 * users need for organization alerts, and it keeps its existing editor,
 * persistence, and delivery behavior. It intentionally has no alert identity,
 * lifecycle status, or recipient cap of its own, so it reports the same on/off
 * state as the other surfaces that expose this setting rather than borrowing the
 * enabled/disabled/archived vocabulary of collection alerts.
 */
export function LowBalanceAlertCard({ organizationId }: { organizationId: string }) {
  const { data: organization, isLoading } = useOrganizationWithMembers(organizationId);
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const settings = organization?.settings;
  const recipientCount = lowBalanceAlertRecipientCount(settings);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Wallet className="size-4 text-muted-foreground" />
          Low balance
        </CardTitle>
        <CardDescription>
          Notifies recipients when the organization&apos;s available balance falls below an amount
          you set. Monthly spending watches the opposite condition.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex items-center justify-between gap-4">
        {isLoading ? (
          <Skeleton className="h-6 w-32" />
        ) : (
          <Badge variant={recipientCount > 0 ? 'new' : 'secondary'}>
            {lowBalanceAlertStateLabel(recipientCount)}
          </Badge>
        )}
        <Button variant="outline" disabled={!organization} onClick={() => setIsEditorOpen(true)}>
          Configure
        </Button>
      </CardContent>

      <SpendingAlertsModal
        open={isEditorOpen}
        onOpenChange={setIsEditorOpen}
        organizationId={organizationId}
        settings={settings}
      />
    </Card>
  );
}
