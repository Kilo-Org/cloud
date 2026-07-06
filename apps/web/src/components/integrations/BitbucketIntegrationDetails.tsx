'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertCircle } from 'lucide-react';
import { BitbucketLogo } from '@/components/auth/BitbucketLogo';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useTRPC } from '@/lib/trpc/utils';
import { BitbucketConnectSetup } from './BitbucketConnectSetup';
import { BitbucketConnectedManagement } from './BitbucketConnectedManagement';

type BitbucketIntegrationDetailsProps = {
  organizationId: string;
  error?: string;
};

const bitbucketConnectionErrorMessages: Record<string, string> = {
  authorization_cancelled:
    'Bitbucket authorization was cancelled. No changes were made. Start OAuth again when you are ready.',
  invalid_state: 'Bitbucket authorization expired or could not be verified. Start OAuth again.',
  unauthorized:
    "You don't have access to connect Bitbucket for this organization. Ask an owner or billing manager to connect it.",
  missing_code: 'Bitbucket did not return an authorization code. Start OAuth again.',
  no_workspaces:
    'The authorized Bitbucket account has no available workspaces. Use a service bot account with access to the workspace, then try again.',
  connection_exists:
    'Bitbucket is already connected. Disconnect the current connection before using OAuth.',
  connection_failed: 'Bitbucket could not be connected. Try OAuth again in a minute.',
};

export function getBitbucketConnectionErrorMessage(error: string): string {
  return (
    bitbucketConnectionErrorMessages[error] ?? 'Bitbucket could not be connected. Try OAuth again.'
  );
}

export function BitbucketConnectionRedirectNotice({ error }: { error?: string }) {
  if (!error) return null;

  const isAuthorizationCancelled = error === 'authorization_cancelled';

  return (
    <Alert variant={isAuthorizationCancelled ? 'warning' : 'destructive'}>
      <AlertCircle />
      <AlertTitle>
        {isAuthorizationCancelled ? 'Bitbucket OAuth was cancelled' : 'Could not connect Bitbucket'}
      </AlertTitle>
      <AlertDescription>{getBitbucketConnectionErrorMessage(error)}</AlertDescription>
    </Alert>
  );
}

function LoadingState() {
  return (
    <Card>
      <CardHeader className="space-y-3">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-4 w-full max-w-md" />
      </CardHeader>
      <CardContent className="space-y-6">
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-40 w-full" />
      </CardContent>
    </Card>
  );
}

function ErrorState() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BitbucketLogo className="size-5" />
          Bitbucket Cloud
        </CardTitle>
      </CardHeader>
      <CardContent>
        <Alert className="border-status-destructive-border bg-status-destructive-surface text-status-destructive">
          <AlertCircle />
          <AlertTitle>Bitbucket status is unavailable</AlertTitle>
          <AlertDescription>
            Refresh the page to try again. No integration settings were changed.
          </AlertDescription>
        </Alert>
      </CardContent>
    </Card>
  );
}

export function BitbucketIntegrationDetails({
  organizationId,
  error,
}: BitbucketIntegrationDetailsProps) {
  const trpc = useTRPC();
  const statusQuery = useQuery(
    trpc.organizations.bitbucket.getStatus.queryOptions({ organizationId })
  );

  let details;
  if (statusQuery.isLoading) {
    details = <LoadingState />;
  } else if (!statusQuery.data) {
    details = <ErrorState />;
  } else if (statusQuery.data.integrationId === null) {
    details = (
      <BitbucketConnectSetup
        organizationId={organizationId}
        canManage={statusQuery.data.canManage}
        statusRefetchFailed={statusQuery.isRefetchError}
      />
    );
  } else {
    details = (
      <BitbucketConnectedManagement
        organizationId={organizationId}
        status={statusQuery.data}
        statusRefetchFailed={statusQuery.isRefetchError}
      />
    );
  }

  return (
    <div className="space-y-6">
      <BitbucketConnectionRedirectNotice error={error} />
      {details}
    </div>
  );
}
