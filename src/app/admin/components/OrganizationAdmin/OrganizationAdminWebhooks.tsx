'use client';

import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Webhook } from 'lucide-react';

type OrganizationAdminWebhooksProps = {
  organizationId: string;
};

export function OrganizationAdminWebhooks({ organizationId }: OrganizationAdminWebhooksProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Webhook Triggers</CardTitle>
      </CardHeader>
      <CardContent className="flex items-center justify-between gap-4">
        <p className="text-muted-foreground text-sm">
          Read-only view of webhook triggers and request history for this organization.
        </p>
        <Button variant="outline" size="sm" asChild>
          <Link href={`/admin/organizations/${encodeURIComponent(organizationId)}/webhooks`}>
            <Webhook className="mr-2 h-4 w-4" />
            View webhooks
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}
