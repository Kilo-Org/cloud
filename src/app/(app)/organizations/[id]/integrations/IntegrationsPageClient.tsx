'use client';

import { useRouter } from 'next/navigation';
import { PlatformCard } from './components/PlatformCard';
import {
  buildPlatformsForOrg,
  PLATFORM_DEFINITIONS,
} from '@/lib/integrations/platform-definitions';
import { Card, CardContent } from '@/components/ui/card';
import { OrgGitHubAppsProvider } from '@/components/integrations/OrgGitHubAppsProvider';
import { useGitHubAppsQueries } from '@/components/integrations/GitHubAppsContext';
import { OrgSlackProvider } from '@/components/integrations/OrgSlackProvider';
import { useSlackQueries } from '@/components/integrations/SlackContext';
import { OrgDiscordProvider } from '@/components/integrations/OrgDiscordProvider';
import { useDiscordQueries } from '@/components/integrations/DiscordContext';
import { OrgGitLabProvider } from '@/components/integrations/OrgGitLabProvider';
import { useGitLabQueries } from '@/components/integrations/GitLabContext';

type IntegrationsPageClientProps = {
  organizationId: string;
};

function IntegrationsPageContent({ organizationId }: IntegrationsPageClientProps) {
  const router = useRouter();
  const { queries: githubQueries } = useGitHubAppsQueries();
  const { queries: slackQueries } = useSlackQueries();
  const { queries: discordQueries } = useDiscordQueries();
  const { queries: gitlabQueries } = useGitLabQueries();

  // Fetch GitHub App installation status
  const { data: githubInstallation, isLoading: githubLoading } = githubQueries.getInstallation();

  // Fetch Slack installation status
  const { data: slackInstallation, isLoading: slackLoading } = slackQueries.getInstallation();

  // Fetch Discord installation status
  const { data: discordInstallation, isLoading: discordLoading } = discordQueries.getInstallation();

  // Fetch GitLab installation status
  const { data: gitlabInstallation, isLoading: gitlabLoading } = gitlabQueries.getInstallation();

  const isLoading = githubLoading || slackLoading || discordLoading || gitlabLoading;

  if (isLoading) {
    return (
      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {PLATFORM_DEFINITIONS.map((_, i) => (
          <Card key={i}>
            <CardContent className="pt-6">
              <div className="animate-pulse space-y-4">
                <div className="bg-muted h-20 rounded" />
                <div className="bg-muted h-12 rounded" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  const platforms = buildPlatformsForOrg(organizationId, {
    github: githubInstallation,
    slack: slackInstallation,
    discord: discordInstallation,
    gitlab: gitlabInstallation,
  });

  const handleNavigate = (platformId: string) => {
    const platform = platforms.find(p => p.id === platformId);
    if (platform?.route) {
      router.push(platform.route);
    }
  };

  return (
    <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
      {platforms.map(platform => (
        <PlatformCard key={platform.id} platform={platform} onNavigate={handleNavigate} />
      ))}
    </div>
  );
}

export function IntegrationsPageClient({ organizationId }: IntegrationsPageClientProps) {
  return (
    <OrgGitHubAppsProvider organizationId={organizationId}>
      <OrgSlackProvider organizationId={organizationId}>
        <OrgDiscordProvider organizationId={organizationId}>
          <OrgGitLabProvider organizationId={organizationId}>
            <IntegrationsPageContent organizationId={organizationId} />
          </OrgGitLabProvider>
        </OrgDiscordProvider>
      </OrgSlackProvider>
    </OrgGitHubAppsProvider>
  );
}
