import 'server-only';

import { Suspense } from 'react';
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
};

const integrationDetailPlatformSet: ReadonlySet<string> = new Set(INTEGRATION_DETAIL_PLATFORMS);

const integrationDetailConfigs: Record<IntegrationDetailPlatform, IntegrationDetailConfig> = {
  [PLATFORM.GITHUB]: {
    title: 'GitHub Integration',
    userSubtitle: 'Manage your personal GitHub App installation',
    organizationSubtitle: organizationName =>
      `Manage GitHub App installation for ${organizationName}`,
  },
  [PLATFORM.GITLAB]: {
    title: 'GitLab Integration',
    userSubtitle: 'Manage your personal GitLab integration',
    organizationSubtitle: organizationName =>
      `Manage GitLab OAuth integration for ${organizationName}`,
  },
  [PLATFORM.SLACK]: {
    title: 'Slack Integration',
    userSubtitle: 'Connect your Slack workspace to receive notifications',
    organizationSubtitle: organizationName => `Manage Slack integration for ${organizationName}`,
  },
  [PLATFORM.DISCORD]: {
    title: 'Discord Integration',
    userSubtitle: 'Connect your Discord server to interact with Kilo',
    organizationSubtitle: organizationName => `Manage Discord integration for ${organizationName}`,
  },
  [PLATFORM.LINEAR]: {
    title: 'Linear Integration',
    userSubtitle: 'Connect your Linear workspace so Kilo can respond to @-mentions on issues',
    organizationSubtitle: organizationName => `Manage Linear integration for ${organizationName}`,
  },
  [PLATFORM.DOLTHUB]: {
    title: 'DoltHub Integration',
    userSubtitle: 'Connect your DoltHub account to query versioned data',
    organizationSubtitle: organizationName => `Manage DoltHub integration for ${organizationName}`,
  },
};

function isIntegrationDetailPlatform(platform: string): platform is IntegrationDetailPlatform {
  return integrationDetailPlatformSet.has(platform);
}

function getIntegrationDetailPlatform(platform: string): IntegrationDetailPlatform {
  if (!isIntegrationDetailPlatform(platform)) {
    notFound();
  }

  return platform;
}

function getIntegrationDetailConfig(platform: IntegrationDetailPlatform): IntegrationDetailConfig {
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

async function PlatformIntegrationDetails({
  platform,
  organizationId,
  organizationName,
  search,
}: DetailRenderProps & { platform: IntegrationDetailPlatform }) {
  switch (platform) {
    case PLATFORM.GITHUB: {
      const { GitHubIntegrationDetails } =
        await import('@/components/integrations/GitHubIntegrationDetails');
      return (
        <GitHubIntegrationDetails
          organizationId={organizationId}
          organizationName={organizationName}
          success={search.success === 'installed'}
          error={search.error}
          pendingApproval={search.pending_approval === 'true'}
          existingPendingOrg={search.org}
        />
      );
    }
    case PLATFORM.GITLAB: {
      const { GitLabIntegrationDetails } =
        await import('@/components/integrations/GitLabIntegrationDetails');
      return (
        <GitLabIntegrationDetails
          organizationId={organizationId}
          organizationName={organizationName}
          success={search.success === 'connected'}
          error={search.error}
        />
      );
    }
    case PLATFORM.SLACK: {
      const { SlackIntegrationDetails } =
        await import('@/components/integrations/SlackIntegrationDetails');
      return (
        <SlackIntegrationDetails
          organizationId={organizationId}
          success={search.success === 'installed'}
          error={search.error}
        />
      );
    }
    case PLATFORM.DISCORD: {
      const { DiscordIntegrationDetails } =
        await import('@/components/integrations/DiscordIntegrationDetails');
      return (
        <DiscordIntegrationDetails
          organizationId={organizationId}
          success={search.success === 'installed'}
          error={search.error}
        />
      );
    }
    case PLATFORM.LINEAR: {
      const { LinearIntegrationDetails } =
        await import('@/components/integrations/LinearIntegrationDetails');
      return (
        <LinearIntegrationDetails
          organizationId={organizationId}
          success={search.success === 'installed'}
          error={search.error}
        />
      );
    }
    case PLATFORM.DOLTHUB: {
      const { DoltHubIntegrationDetails } =
        await import('@/components/integrations/DoltHubIntegrationDetails');
      return (
        <DoltHubIntegrationDetails
          organizationId={organizationId}
          success={search.success === 'installed'}
          error={search.error}
        />
      );
    }
  }
}

function SuspendedIntegrationDetails(
  props: DetailRenderProps & { platform: IntegrationDetailPlatform }
) {
  return (
    <Suspense fallback={<IntegrationDetailsFallback />}>
      <PlatformIntegrationDetails {...props} />
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
  const detailPlatform = getIntegrationDetailPlatform(platform);
  const config = getIntegrationDetailConfig(detailPlatform);
  await getUserFromAuthOrRedirect('/users/sign_in');
  const search = await searchParams;

  return (
    <PageLayout
      title={config.title}
      subtitle={config.userSubtitle}
      headerActions={<BackToIntegrationsLink href="/integrations" />}
    >
      <SuspendedIntegrationDetails platform={detailPlatform} search={search} />
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
  const detailPlatform = getIntegrationDetailPlatform(platform);
  const config = getIntegrationDetailConfig(detailPlatform);
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
            platform={detailPlatform}
            organizationId={organization.id}
            organizationName={organization.name}
            search={search}
          />
        </>
      )}
    />
  );
}
