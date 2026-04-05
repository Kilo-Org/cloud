'use client';

import { useRouter } from 'next/navigation';
import { PlatformCard } from '@/app/(app)/organizations/[id]/integrations/components/PlatformCard';
import { buildPlatforms, PLATFORM_DEFINITIONS } from '@/lib/integrations/platform-definitions';
import { Card, CardContent } from '@/components/ui/card';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';

type IntegrationsHubProps = {
  organizationId?: string;
};

export function IntegrationsHub({ organizationId }: IntegrationsHubProps) {
  const router = useRouter();
  const trpc = useTRPC();
  const input = organizationId ? { organizationId } : undefined;

  // Fetch all installation statuses via tRPC.
  // These individual useQuery calls are automatically batched into a single HTTP request
  // by tRPC's built-in batching (httpBatchLink), so no manual parallelization is needed.
  const { data: githubInstallation, isLoading: githubLoading } = useQuery(
    trpc.githubApps.getInstallation.queryOptions(input)
  );
  const { data: slackInstallation, isLoading: slackLoading } = useQuery(
    trpc.slack.getInstallation.queryOptions(input)
  );
  const { data: discordInstallation, isLoading: discordLoading } = useQuery(
    trpc.discord.getInstallation.queryOptions(input)
  );
  const { data: gitlabInstallation, isLoading: gitlabLoading } = useQuery(
    trpc.gitlab.getInstallation.queryOptions(input)
  );

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

  const platforms = buildPlatforms(
    {
      github: githubInstallation,
      slack: slackInstallation,
      discord: discordInstallation,
      gitlab: gitlabInstallation,
    },
    organizationId
  );

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
