'use client';

import { useEffect } from 'react';
import { MessageSquare } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useKiloClawStatus } from '@/hooks/useKiloClaw';
import { useOrgKiloClawStatus } from '@/hooks/useOrgKiloClaw';
import { ClawContextProvider } from './ClawContext';
import { ChatTab } from './ChatTab';
import { BillingWrapper } from './billing/BillingWrapper';
import { SetPageTitle } from '@/components/SetPageTitle';
import { Card, CardContent } from '@/components/ui/card';

/**
 * Wrapper that polls status and handles loading/error/no-instance states
 * before rendering the chat content.
 */
function ClawChatWithStatus({ organizationId }: { organizationId?: string }) {
  const router = useRouter();
  const personalStatus = useKiloClawStatus();
  const orgStatus = useOrgKiloClawStatus(organizationId ?? '');
  const { data: status, isLoading, error } = organizationId ? orgStatus : personalStatus;

  const clawUrl = organizationId ? `/organizations/${organizationId}/claw/new` : '/claw/new';

  // Redirect to main KiloClaw page when there is no instance — it has the
  // onboarding/provisioning flow that guides the user through setup.
  const shouldRedirect = !isLoading && !error && (!status || status.status === null);
  useEffect(() => {
    if (shouldRedirect) {
      router.replace(clawUrl);
    }
  }, [shouldRedirect, clawUrl, router]);

  if (isLoading || shouldRedirect) {
    return (
      <Card>
        <CardContent className="py-12 text-center">
          <p className="text-muted-foreground">Loading…</p>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className="py-12 text-center">
          <p className="text-destructive text-sm">
            Failed to load status: {error instanceof Error ? error.message : 'Unknown error'}
          </p>
        </CardContent>
      </Card>
    );
  }

  if (!status || status.status === null) return null;

  const isRunning = status.status === 'running';
  const chatContent = (
    <Card>
      <CardContent className="p-5">
        <ChatTab enabled={isRunning} />
      </CardContent>
    </Card>
  );

  // Personal context uses BillingWrapper for access-lock dialogs/banners.
  if (!organizationId) {
    return <BillingWrapper>{chatContent}</BillingWrapper>;
  }

  return chatContent;
}

export function ClawChatPage({ organizationId }: { organizationId?: string }) {
  return (
    <ClawContextProvider organizationId={organizationId}>
      <div className="container m-auto flex w-full max-w-[1140px] flex-col gap-6 p-4 md:p-6">
        <SetPageTitle
          title="Chat"
          icon={<MessageSquare className="text-muted-foreground h-4 w-4" />}
        />
        <ClawChatWithStatus organizationId={organizationId} />
      </div>
    </ClawContextProvider>
  );
}
