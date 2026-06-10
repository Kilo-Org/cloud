'use client';

import { useRouter } from 'next/navigation';
import {
  PlatformCard,
  type GitHubIdentityStatus,
} from '@/app/(app)/organizations/[id]/integrations/components/PlatformCard';
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

  const { data: installationStatuses, isLoading: installationStatusesLoading } = useQuery(
    trpc.platformIntegrations.listSetupStatus.queryOptions(input)
  );
  const { data: githubAuthorization, isLoading: githubAuthorizationLoading } = useQuery({
    ...trpc.githubApps.getUserAuthorization.queryOptions(),
    enabled: !organizationId,
  });

  const isLoading = installationStatusesLoading || (!organizationId && githubAuthorizationLoading);

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

  const platforms = buildPlatforms(installationStatuses ?? [], organizationId);

  const handleNavigate = (platformId: string) => {
    const platform = platforms.find(p => p.id === platformId);
    if (platform?.route) {
      router.push(platform.route);
    }
  };

  const githubIdentityStatus: GitHubIdentityStatus | undefined = organizationId
    ? undefined
    : githubAuthorization?.connected
      ? 'connected'
      : githubAuthorization?.revoked
        ? 'revoked'
        : undefined;

  return (
    <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
      {platforms.map(platform => (
        <PlatformCard
          key={platform.id}
          platform={platform}
          githubIdentityStatus={platform.id === 'github' ? githubIdentityStatus : undefined}
          onNavigate={handleNavigate}
        />
      ))}
    </div>
  );
}
