import { Suspense } from 'react';
import { DiscordIntegrationDetails } from '@/components/integrations/DiscordIntegrationDetails';
import { Button } from '@/components/ui/button';
import { SetPageTitle } from '@/components/SetPageTitle';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';

export default async function OrgDiscordIntegrationPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    success?: string;
    error?: string;
  }>;
}) {
  const search = await searchParams;

  return (
    <OrganizationByPageLayout
      params={params}
      render={({ organization }) => (
        <>
          <div className="space-y-4">
            <Link href={`/organizations/${organization.id}/integrations`}>
              <Button variant="ghost" size="sm" className="gap-2">
                <ArrowLeft className="h-4 w-4" />
                Back to Integrations
              </Button>
            </Link>
            <SetPageTitle title="Discord Integration" />
            <p className="text-muted-foreground">
              Manage Discord integration for {organization.name}
            </p>
          </div>

          <Suspense
            fallback={
              <Card>
                <CardContent className="pt-6">
                  <div className="animate-pulse space-y-4">
                    <div className="bg-muted h-20 rounded" />
                    <div className="bg-muted h-32 rounded" />
                  </div>
                </CardContent>
              </Card>
            }
          >
            <DiscordIntegrationDetails
              organizationId={organization.id}
              success={search.success === 'installed'}
              error={search.error}
            />
          </Suspense>
        </>
      )}
    />
  );
}
