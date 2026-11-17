'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { PageContainer } from '@/components/layouts/PageContainer';
import type { SupportAccessNeededContent } from '@/lib/organizations/support-access-needed-content';
import { SupportAccessRequestDialog } from './SupportAccessRequestDialog';

export function SupportAccessNeeded({
  organizationId,
  organizationName,
  content,
}: {
  organizationId: string;
  organizationName: string | null;
  content: SupportAccessNeededContent;
}) {
  const [open, setOpen] = useState(false);

  return (
    <PageContainer>
      <Card className="max-w-xl">
        <CardHeader>
          <CardTitle>Access needed</CardTitle>
          <CardDescription>{content.description}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-4">
          {content.canRequest && <Button onClick={() => setOpen(true)}>Request access</Button>}
          {content.dashboardHref && (
            <a
              href={content.dashboardHref}
              className="text-primary text-sm font-medium hover:underline"
            >
              Open organization dashboard
            </a>
          )}
          <a href={content.adminHref} className="text-primary text-sm font-medium hover:underline">
            Open admin organization page
          </a>
        </CardContent>
      </Card>
      {content.canRequest && (
        <SupportAccessRequestDialog
          open={open}
          onOpenChange={setOpen}
          organizationId={organizationId}
          organizationName={organizationName ?? organizationId}
          onGranted={grant => {
            if (grant.status === 'active') window.location.reload();
          }}
        />
      )}
    </PageContainer>
  );
}
