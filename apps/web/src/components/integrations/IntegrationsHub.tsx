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

  const { data: installationStatuses, isLoading } = useQuery(
    trpc.platformIntegrations.listSetupStatus.queryOptions(input)
  );

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

  return (
    <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
      {platforms.map(platform => (
        <PlatformCard key={platform.id} platform={platform} onNavigate={handleNavigate} />
      ))}
    </div>
  );
}
