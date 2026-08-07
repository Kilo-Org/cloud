import type { Metadata } from 'next';

import { GitHubIntegrationDetails } from '@/components/integrations/GitHubIntegrationDetails';
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

  await getUserFromAuthOrRedirect(`/users/sign_in?callbackPath=${encodeURIComponent(returnPath)}`);

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
      </div>
    </main>
  );
}
