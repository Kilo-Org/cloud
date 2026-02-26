'use client';

import { useRouter } from 'next/navigation';
import { PlatformCard } from '@/app/(app)/organizations/[id]/integrations/components/PlatformCard';
import {
  buildPlatformsForPersonal,
  PLATFORM_DEFINITIONS,
} from '@/lib/integrations/platform-definitions';
import { Card, CardContent } from '@/components/ui/card';
import { UserGitHubAppsProvider } from '@/components/integrations/UserGitHubAppsProvider';
import { useGitHubAppsQueries } from '@/components/integrations/GitHubAppsContext';
import { UserSlackProvider } from '@/components/integrations/UserSlackProvider';
import { useSlackQueries } from '@/components/integrations/SlackContext';
import { UserDiscordProvider } from '@/components/integrations/UserDiscordProvider';
import { useDiscordQueries } from '@/components/integrations/DiscordContext';
import { UserGitLabProvider } from '@/components/integrations/UserGitLabProvider';
import { useGitLabQueries } from '@/components/integrations/GitLabContext';
import { PageContainer } from '@/components/layouts/PageContainer';

function IntegrationsPageContent() {
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
      <PageContainer>
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
      </PageContainer>
    );
  }

  const platforms = buildPlatformsForPersonal({
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
    <PageContainer>
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-100">Integrations</h1>
        <p className="text-muted-foreground mt-2">
          Connect your development tools and workflows with Kilocode
        </p>
      </div>
      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {platforms.map(platform => (
          <PlatformCard key={platform.id} platform={platform} onNavigate={handleNavigate} />
        ))}
      </div>
    </PageContainer>
  );
}

export function IntegrationsPageClient() {
  return (
    <UserGitHubAppsProvider>
      <UserSlackProvider>
        <UserDiscordProvider>
          <UserGitLabProvider>
            <IntegrationsPageContent />
          </UserGitLabProvider>
        </UserDiscordProvider>
      </UserSlackProvider>
    </UserGitHubAppsProvider>
  );
}
