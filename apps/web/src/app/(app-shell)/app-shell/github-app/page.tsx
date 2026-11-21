import type { Metadata } from 'next';
import { GitHubIntegrationDetails } from '@/components/integrations/GitHubIntegrationDetails';
import { buildAppReturnOutcomeView } from '@/components/integrations/github-app-outcome';
import { requireAppShellUser } from '@/lib/app-shell/session';
import { loadAppShellOrganization, readSearchParam } from '@/lib/app-shell/guards';
import { APP_SHELL_PREFIX } from '@/lib/app-shell/shell-paths';
import { ShellOutcome } from '../components/shell-outcome';

export const metadata: Metadata = {
  title: 'Connect GitHub',
  robots: { index: false, follow: false },
};

const SELF_PATH = `${APP_SHELL_PREFIX}/github-app`;

const OUTCOME_KIND = {
  installed: 'success',
  pending: 'pending',
  blocked: 'failure',
  retryable: 'failure',
} as const;

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * The GitHub App install, inside the shell. The install state this page mints
 * carries this page as its `returnTo`, so the GitHub callback lands back here
 * with the outcome, and the outcome closes the in-app browser.
 */
export default async function AppShellGitHubAppPage({ searchParams }: PageProps) {
  const search = await searchParams;
  const user = await requireAppShellUser();
  if (!user) {
    return (
      <ShellOutcome
        kind="failure"
        title="Start again from the Kilo App"
        description="This page's session has ended. Close this window and start GitHub setup again from the Kilo App."
      />
    );
  }

  const organizationId = readSearchParam(search, 'organizationId');
  if (organizationId && !(await loadAppShellOrganization(user, organizationId))) {
    return (
      <ShellOutcome
        kind="failure"
        title="No access to this organization"
        description="You are not a member of this organization. Close this window and start again from the Kilo App."
      />
    );
  }

  const success =
    readSearchParam(search, 'github_install') === 'success' ||
    readSearchParam(search, 'success') === 'installed';
  const pendingApproval =
    readSearchParam(search, 'github_pending_approval') === 'true' ||
    readSearchParam(search, 'pending_approval') === 'true';
  const error = readSearchParam(search, 'error');

  if (success || pendingApproval || error) {
    const view = buildAppReturnOutcomeView({
      success,
      pendingApproval,
      error,
      organizationId,
      appBasePath: SELF_PATH,
    });
    return (
      <ShellOutcome
        kind={OUTCOME_KIND[view.kind]}
        title={view.title}
        description={view.description}
      />
    );
  }

  return (
    <>
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Connect GitHub</h1>
        <p className="text-muted-foreground text-sm">
          Install the Kilo GitHub App, then return to the Kilo App.
        </p>
      </header>
      <GitHubIntegrationDetails
        organizationId={organizationId}
        fromApp
        success={false}
        appReturnPath={SELF_PATH}
        installStartPath={`${SELF_PATH}/start`}
      />
    </>
  );
}
