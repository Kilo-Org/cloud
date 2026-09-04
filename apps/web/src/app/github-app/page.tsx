import React from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';

import { GitHubIntegrationDetails } from '@/components/integrations/GitHubIntegrationDetails';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { checkInstallState } from '@/lib/integrations/github/install-state';
import { getUserFromAuthOrRedirect } from '@/lib/user/server';

export const metadata: Metadata = {
  title: 'Connect GitHub',
  description: 'Connect GitHub for Kilo App',
  robots: {
    index: false,
    follow: false,
  },
};

type GitHubAppSearchParams = Promise<{
  organizationId?: string;
  installState?: string;
  fromApp?: string;
  github_install?: string;
  success?: string;
  error?: string;
  github_pending_approval?: string;
  pending_approval?: string;
  org?: string;
}>;

function getGitHubAppReturnPath(
  organizationId?: string,
  installState?: string,
  fromApp?: string
): string {
  const params = new URLSearchParams();
  if (organizationId) params.set('organizationId', organizationId);
  if (installState) params.set('installState', installState);
  if (fromApp) params.set('fromApp', fromApp);
  const query = params.toString();
  return query ? `/github-app?${query}` : '/github-app';
}

export default async function GitHubAppPage({
  searchParams,
}: {
  searchParams: GitHubAppSearchParams;
}) {
  const search = await searchParams;
  const isFromApp = search.fromApp === '1';
  const installState = search.installState;
  const returnPath = getGitHubAppReturnPath(search.organizationId, installState, search.fromApp);

  const user = await getUserFromAuthOrRedirect(
    `/users/sign_in?callbackPath=${encodeURIComponent(returnPath)}`
  );
  const preflight =
    installState !== undefined ? await checkInstallState(installState, user.id) : null;
  const blocked = preflight && preflight.status !== 'valid';
  const mismatch = preflight?.status === 'user_mismatch';
  const recoveryError = mismatch ? 'install_state_user_mismatch' : 'install_state_unusable';
  const recoveryOrgParam = search.organizationId
    ? `&organizationId=${encodeURIComponent(search.organizationId)}`
    : '';

  return (
    <main className="min-h-screen bg-background px-4 py-5 sm:px-6">
      <div className="mx-auto flex max-w-2xl flex-col gap-5">
        <header className="space-y-1">
          <p className="text-muted-foreground text-sm">Kilo App</p>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Connect GitHub</h1>
          <p className="text-muted-foreground text-sm">
            {isFromApp
              ? 'Install the Kilo GitHub App, then return to the Kilo App.'
              : 'Connect GitHub, then return to Kilo App to start a Cloud Agent session.'}
          </p>
        </header>

        {blocked ? (
          <Card>
            <CardHeader>
              <CardTitle>{mismatch ? 'Account mismatch' : 'Restart GitHub setup'}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-muted-foreground text-sm">
                {mismatch
                  ? 'This connection was started by a different Kilo account. Sign in with the account that started it, then restart setup.'
                  : 'This setup link has expired, has already been used, or is invalid. Return to Kilo and start GitHub setup again.'}
              </p>
              <Button asChild variant="outline">
                <Link
                  href={
                    isFromApp ? `/cloud/sessions?error=${recoveryError}${recoveryOrgParam}` : '/'
                  }
                >
                  {isFromApp ? 'Return to Kilo App' : 'Go to dashboard'}
                </Link>
              </Button>
            </CardContent>
          </Card>
        ) : (
          <GitHubIntegrationDetails
            organizationId={search.organizationId}
            installState={installState}
            fromApp={isFromApp}
            success={search.github_install === 'success' || search.success === 'installed'}
            error={search.error}
            pendingApproval={
              search.github_pending_approval === 'true' || search.pending_approval === 'true'
            }
            existingPendingOrg={search.org}
            appReturnPath={isFromApp ? returnPath : undefined}
          />
        )}
      </div>
    </main>
  );
}
