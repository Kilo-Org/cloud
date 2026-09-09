'use client';

import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  PlatformCard,
  type GitHubIdentityStatus,
} from '@/app/(app)/organizations/[id]/integrations/components/PlatformCard';
import {
  buildPlatforms,
  getPlatformDefinitionCountForOwner,
} from '@/lib/integrations/platform-definitions';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ArrowRight, Cloud } from 'lucide-react';
import { Button } from '@/components/ui/button';
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
  const cloudVisibilityQuery = useQuery({
    ...(organizationId
      ? trpc.organizations.vercelCompute.getCloudCardVisibility.queryOptions({ organizationId })
      : trpc.vercelCompute.getCloudCardVisibility.queryOptions()),
    retry: false,
    throwOnError: false,
  });
  const isCloudVisible =
    cloudVisibilityQuery.isSuccess && cloudVisibilityQuery.data?.visible === true;

  const isLoading =
    installationStatusesLoading ||
    (!organizationId && githubAuthorizationLoading) ||
    cloudVisibilityQuery.isLoading;

  if (isLoading) {
    return (
      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {Array.from(
          { length: getPlatformDefinitionCountForOwner(organizationId) + 1 },
          (_, index) => (
            <Card key={index}>
              <CardContent className="pt-6">
                <div className="animate-pulse space-y-4">
                  <div className="bg-muted h-20 rounded" />
                  <div className="bg-muted h-12 rounded" />
                </div>
              </CardContent>
            </Card>
          )
        )}
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
  const cloudRoute = organizationId
    ? `/organizations/${organizationId}/integrations/cloud`
    : '/integrations/cloud';

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
      {isCloudVisible && (
        <Card className="flex flex-col justify-between">
          <CardHeader>
            <div className="flex items-start gap-3">
              <div className="shrink-0 rounded-lg border p-2">
                <Cloud className="h-6 w-6" />
              </div>
              <div className="min-w-0 flex-1">
                <CardTitle>Cloud</CardTitle>
                <CardDescription className="mt-2">
                  Run Cloud Agent on your {organizationId ? "organization's" : 'own'} Vercel
                  account.
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <Button variant="outline" className="group w-full" asChild>
              <Link href={cloudRoute}>
                Manage Cloud
                <ArrowRight className="ml-2 h-4 w-4 transition-transform group-hover:translate-x-1" />
              </Link>
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
