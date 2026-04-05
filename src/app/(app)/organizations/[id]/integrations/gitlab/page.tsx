import { Suspense } from 'react';
import { GitLabIntegrationDetails } from '@/components/integrations/GitLabIntegrationDetails';
import { Button } from '@/components/ui/button';
import { SetPageTitle } from '@/components/SetPageTitle';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';

export default async function GitLabIntegrationPage({
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
            <SetPageTitle title="GitLab Integration" />
            <p className="text-muted-foreground">
              Manage GitLab OAuth integration for {organization.name}
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
            <GitLabIntegrationDetails
              organizationId={organization.id}
              organizationName={organization.name}
              success={search.success === 'connected'}
              error={search.error}
            />
          </Suspense>
        </>
      )}
    />
  );
}
