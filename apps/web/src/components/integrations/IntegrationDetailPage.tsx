import 'server-only';

import { Suspense, type ReactNode } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { getUserFromAuthOrRedirect } from '@/lib/user/server';
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

type DetailRenderProps = {
  organizationId?: string;
  search: Awaited<IntegrationDetailSearchParams>;
};

type IntegrationDetailRegistryEntry = {
  title: string;
  userSubtitle: string;
  organizationSubtitle: (organizationName: string) => string;
  render: (props: DetailRenderProps) => Promise<ReactNode>;
};

const integrationDetailRegistry = {
  [PLATFORM.GITHUB]: {
    title: 'GitHub Integration',
    userSubtitle: 'Set up personal repository access and optional Cloud Agent attribution',
    organizationSubtitle: organizationName =>
      `Manage repository access for ${organizationName} and link your personal identity.`,
    render: async ({ organizationId, search }) => {
      const { GitHubIntegrationDetails } =
        await import('@/components/integrations/GitHubIntegrationDetails');
      return (
        <GitHubIntegrationDetails
          organizationId={organizationId}
          success={search.success === 'installed'}
          userConnectionSuccess={search.success === 'user_connected'}
          error={search.error}
          pendingApproval={search.pending_approval === 'true'}
          existingPendingOrg={search.org}
        />
      );
    },
  },
  [PLATFORM.GITLAB]: {
    title: 'GitLab Integration',
    userSubtitle: 'Manage your personal GitLab integration',
    organizationSubtitle: organizationName =>
      `Manage GitLab OAuth integration for ${organizationName}`,
    render: async ({ organizationId, search }) => {
      const { GitLabIntegrationDetails } =
        await import('@/components/integrations/GitLabIntegrationDetails');
      return (
        <GitLabIntegrationDetails
          organizationId={organizationId}
          success={search.success === 'connected'}
          error={search.error}
        />
      );
    },
  },
  [PLATFORM.SLACK]: {
    title: 'Slack Integration',
    userSubtitle: 'Connect your Slack workspace to receive notifications',
    organizationSubtitle: organizationName => `Manage Slack integration for ${organizationName}`,
    render: async ({ organizationId, search }) => {
      const { SlackIntegrationDetails } =
        await import('@/components/integrations/SlackIntegrationDetails');
      return (
        <SlackIntegrationDetails
          organizationId={organizationId}
          success={search.success === 'installed'}
          error={search.error}
        />
      );
    },
  },
  [PLATFORM.DISCORD]: {
    title: 'Discord Integration',
    userSubtitle: 'Connect your Discord server to interact with Kilo',
    organizationSubtitle: organizationName => `Manage Discord integration for ${organizationName}`,
    render: async ({ organizationId, search }) => {
      const { DiscordIntegrationDetails } =
        await import('@/components/integrations/DiscordIntegrationDetails');
      return (
        <DiscordIntegrationDetails
          organizationId={organizationId}
          success={search.success === 'installed'}
          error={search.error}
        />
      );
    },
  },
  [PLATFORM.LINEAR]: {
    title: 'Linear Integration',
    userSubtitle: 'Connect your Linear workspace so Kilo can respond to @-mentions on issues',
    organizationSubtitle: organizationName => `Manage Linear integration for ${organizationName}`,
    render: async ({ organizationId, search }) => {
      const { LinearIntegrationDetails } =
        await import('@/components/integrations/LinearIntegrationDetails');
      return (
        <LinearIntegrationDetails
          organizationId={organizationId}
          success={search.success === 'installed'}
          error={search.error}
        />
      );
    },
  },
  [PLATFORM.DOLTHUB]: {
    title: 'DoltHub Integration',
    userSubtitle: 'Connect your DoltHub account to query versioned data',
    organizationSubtitle: organizationName => `Manage DoltHub integration for ${organizationName}`,
    render: async ({ organizationId, search }) => {
      const { DoltHubIntegrationDetails } =
        await import('@/components/integrations/DoltHubIntegrationDetails');
      return (
        <DoltHubIntegrationDetails
          organizationId={organizationId}
          success={search.success === 'installed'}
          error={search.error}
        />
      );
    },
  },
} satisfies Record<string, IntegrationDetailRegistryEntry>;

type IntegrationDetailPlatform = keyof typeof integrationDetailRegistry;

const integrationDetailPlatformSet: ReadonlySet<string> = new Set(
  Object.keys(integrationDetailRegistry)
);

function isIntegrationDetailPlatform(platform: string): platform is IntegrationDetailPlatform {
  return integrationDetailPlatformSet.has(platform);
}

function getIntegrationDetailPlatform(platform: string): IntegrationDetailPlatform {
  if (!isIntegrationDetailPlatform(platform)) {
    notFound();
  }

  return platform;
}

function getIntegrationDetailEntry(
  platform: IntegrationDetailPlatform
): IntegrationDetailRegistryEntry {
  return integrationDetailRegistry[platform];
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
  search,
}: DetailRenderProps & { platform: IntegrationDetailPlatform }) {
  return getIntegrationDetailEntry(platform).render({ organizationId, search });
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
  const entry = getIntegrationDetailEntry(detailPlatform);
  await getUserFromAuthOrRedirect('/users/sign_in');
  const search = await searchParams;

  return (
    <PageLayout
      title={entry.title}
      subtitle={entry.userSubtitle}
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
  const entry = getIntegrationDetailEntry(detailPlatform);
  const search = await searchParams;

  return (
    <OrganizationByPageLayout
      params={params}
      render={({ organization }) => (
        <>
          <div className="space-y-4">
            <BackToIntegrationsLink href={`/organizations/${organization.id}/integrations`} />
            <SetPageTitle title={entry.title} />
            <p className="text-muted-foreground">{entry.organizationSubtitle(organization.name)}</p>
          </div>

          <SuspendedIntegrationDetails
            platform={detailPlatform}
            organizationId={organization.id}
            search={search}
          />
        </>
      )}
    />
  );
}
