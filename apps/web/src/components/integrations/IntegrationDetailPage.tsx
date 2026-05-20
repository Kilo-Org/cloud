import { Suspense, type ReactNode } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { PLATFORM } from '@/lib/integrations/core/constants';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { PageLayout } from '@/components/PageLayout';
import { SetPageTitle } from '@/components/SetPageTitle';
import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { GitHubIntegrationDetails } from '@/components/integrations/GitHubIntegrationDetails';
import { GitLabIntegrationDetails } from '@/components/integrations/GitLabIntegrationDetails';
import { SlackIntegrationDetails } from '@/components/integrations/SlackIntegrationDetails';
import { DiscordIntegrationDetails } from '@/components/integrations/DiscordIntegrationDetails';
import { LinearIntegrationDetails } from '@/components/integrations/LinearIntegrationDetails';
import { DoltHubIntegrationDetails } from '@/components/integrations/DoltHubIntegrationDetails';

export type IntegrationDetailSearchParams = Promise<{
  success?: string;
  error?: string;
  pending_approval?: string;
  org?: string;
}>;

const INTEGRATION_DETAIL_PLATFORMS = [
  PLATFORM.GITHUB,
  PLATFORM.GITLAB,
  PLATFORM.SLACK,
  PLATFORM.DISCORD,
  PLATFORM.LINEAR,
  PLATFORM.DOLTHUB,
] as const;

type IntegrationDetailPlatform = (typeof INTEGRATION_DETAIL_PLATFORMS)[number];

type DetailRenderProps = {
  organizationId?: string;
  organizationName?: string;
  search: Awaited<IntegrationDetailSearchParams>;
};

type IntegrationDetailConfig = {
  title: string;
  userSubtitle: string;
  organizationSubtitle: (organizationName: string) => string;
  renderDetails: (props: DetailRenderProps) => ReactNode;
};

const integrationDetailPlatformSet: ReadonlySet<string> = new Set(INTEGRATION_DETAIL_PLATFORMS);

const integrationDetailConfigs: Record<IntegrationDetailPlatform, IntegrationDetailConfig> = {
  [PLATFORM.GITHUB]: {
    title: 'GitHub Integration',
    userSubtitle: 'Manage your personal GitHub App installation',
    organizationSubtitle: organizationName =>
      `Manage GitHub App installation for ${organizationName}`,
    renderDetails: ({ organizationId, organizationName, search }) => (
      <GitHubIntegrationDetails
        organizationId={organizationId}
        organizationName={organizationName}
        success={search.success === 'installed'}
        error={search.error}
        pendingApproval={search.pending_approval === 'true'}
        existingPendingOrg={search.org}
      />
    ),
  },
  [PLATFORM.GITLAB]: {
    title: 'GitLab Integration',
    userSubtitle: 'Manage your personal GitLab integration',
    organizationSubtitle: organizationName =>
      `Manage GitLab OAuth integration for ${organizationName}`,
    renderDetails: ({ organizationId, organizationName, search }) => (
      <GitLabIntegrationDetails
        organizationId={organizationId}
        organizationName={organizationName}
        success={search.success === 'connected'}
        error={search.error}
      />
    ),
  },
  [PLATFORM.SLACK]: {
    title: 'Slack Integration',
    userSubtitle: 'Connect your Slack workspace to receive notifications',
    organizationSubtitle: organizationName => `Manage Slack integration for ${organizationName}`,
    renderDetails: ({ organizationId, search }) => (
      <SlackIntegrationDetails
        organizationId={organizationId}
        success={search.success === 'installed'}
        error={search.error}
      />
    ),
  },
  [PLATFORM.DISCORD]: {
    title: 'Discord Integration',
    userSubtitle: 'Connect your Discord server to interact with Kilo',
    organizationSubtitle: organizationName => `Manage Discord integration for ${organizationName}`,
    renderDetails: ({ organizationId, search }) => (
      <DiscordIntegrationDetails
        organizationId={organizationId}
        success={search.success === 'installed'}
        error={search.error}
      />
    ),
  },
  [PLATFORM.LINEAR]: {
    title: 'Linear Integration',
    userSubtitle: 'Connect your Linear workspace so Kilo can respond to @-mentions on issues',
    organizationSubtitle: organizationName => `Manage Linear integration for ${organizationName}`,
    renderDetails: ({ organizationId, search }) => (
      <LinearIntegrationDetails
        organizationId={organizationId}
        success={search.success === 'installed'}
        error={search.error}
      />
    ),
  },
  [PLATFORM.DOLTHUB]: {
    title: 'DoltHub Integration',
    userSubtitle: 'Connect your DoltHub account to query versioned data',
    organizationSubtitle: organizationName => `Manage DoltHub integration for ${organizationName}`,
    renderDetails: ({ organizationId, search }) => (
      <DoltHubIntegrationDetails
        organizationId={organizationId}
        success={search.success === 'installed'}
        error={search.error}
      />
    ),
  },
};

function isIntegrationDetailPlatform(platform: string): platform is IntegrationDetailPlatform {
  return integrationDetailPlatformSet.has(platform);
}

function getIntegrationDetailConfig(platform: string): IntegrationDetailConfig {
  if (!isIntegrationDetailPlatform(platform)) {
    notFound();
  }

  return integrationDetailConfigs[platform];
}

function BackToIntegrationsLink({ href }: { href: string }) {
  return (
    <Link href={href}>
      <Button variant="ghost" size="sm" className="gap-2">
        <ArrowLeft className="h-4 w-4" />
        Back to Integrations
      </Button>
    </Link>
  );
}

function IntegrationDetailsFallback() {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="animate-pulse space-y-4">
          <div className="bg-muted h-20 rounded" />
          <div className="bg-muted h-32 rounded" />
        </div>
      </CardContent>
    </Card>
  );
}

function SuspendedIntegrationDetails(props: {
  config: IntegrationDetailConfig;
  search: Awaited<IntegrationDetailSearchParams>;
  organizationId?: string;
  organizationName?: string;
}) {
  return (
    <Suspense fallback={<IntegrationDetailsFallback />}>
      {props.config.renderDetails({
        organizationId: props.organizationId,
        organizationName: props.organizationName,
        search: props.search,
      })}
    </Suspense>
  );
}

export async function UserIntegrationDetailPage({
  platform,
  searchParams,
}: {
  platform: string;
  searchParams: IntegrationDetailSearchParams;
}) {
  const config = getIntegrationDetailConfig(platform);
  await getUserFromAuthOrRedirect('/users/sign_in');
  const search = await searchParams;

  return (
    <PageLayout
      title={config.title}
      subtitle={config.userSubtitle}
      headerActions={<BackToIntegrationsLink href="/integrations" />}
    >
      <SuspendedIntegrationDetails config={config} search={search} />
    </PageLayout>
  );
}

export async function OrganizationIntegrationDetailPage({
  params,
  platform,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  platform: string;
  searchParams: IntegrationDetailSearchParams;
}) {
  const config = getIntegrationDetailConfig(platform);
  const search = await searchParams;

  return (
    <OrganizationByPageLayout
      params={params}
      render={({ organization }) => (
        <>
          <div className="space-y-4">
            <BackToIntegrationsLink href={`/organizations/${organization.id}/integrations`} />
            <SetPageTitle title={config.title} />
            <p className="text-muted-foreground">
              {config.organizationSubtitle(organization.name)}
            </p>
          </div>

          <SuspendedIntegrationDetails
            config={config}
            organizationId={organization.id}
            organizationName={organization.name}
            search={search}
          />
        </>
      )}
    />
  );
}
