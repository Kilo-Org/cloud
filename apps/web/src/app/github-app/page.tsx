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
  github_install?: string;
  success?: string;
  error?: string;
  github_pending_approval?: string;
  pending_approval?: string;
  org?: string;
}>;

function getGitHubAppReturnPath(organizationId?: string): string {
  if (!organizationId) {
    return '/github-app';
  }
  return `/github-app?organizationId=${encodeURIComponent(organizationId)}`;
}

export default async function GitHubAppPage({
  searchParams,
}: {
  searchParams: GitHubAppSearchParams;
}) {
  const search = await searchParams;
  const returnPath = getGitHubAppReturnPath(search.organizationId);

  await getUserFromAuthOrRedirect(`/users/sign_in?callbackPath=${encodeURIComponent(returnPath)}`);

  return (
    <main className="min-h-screen bg-background px-4 py-5 sm:px-6">
      <div className="mx-auto flex max-w-2xl flex-col gap-5">
        <header className="space-y-1">
          <p className="text-muted-foreground text-sm">Kilo App</p>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Connect GitHub</h1>
          <p className="text-muted-foreground text-sm">
            Connect GitHub, then return to Kilo App to start a Cloud Agent session.
          </p>
        </header>

        <GitHubIntegrationDetails
          organizationId={search.organizationId}
          success={search.github_install === 'success' || search.success === 'installed'}
          error={search.error}
          pendingApproval={
            search.github_pending_approval === 'true' || search.pending_approval === 'true'
          }
          existingPendingOrg={search.org}
          appReturnPath={returnPath}
        />
      </div>
    </main>
  );
}
