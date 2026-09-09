import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowRight, Cloud } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { SetPageTitle } from '@/components/SetPageTitle';

export default async function OrganizationCloudIntegrationsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return (
    <OrganizationByPageLayout
      params={params}
      render={({ organization, role, isGlobalAdmin }) => {
        if (!isGlobalAdmin && role !== 'owner' && role !== 'admin') notFound();

        return (
          <>
            <div className="space-y-2">
              <SetPageTitle title="Cloud" />
              <p className="text-muted-foreground">
                Choose a provider for {organization.name} Cloud Agent compute.
              </p>
            </div>

            <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
              <Card className="flex flex-col justify-between">
                <CardHeader>
                  <div className="flex items-start gap-3">
                    <div className="shrink-0 rounded-lg border p-2">
                      <Cloud className="h-6 w-6" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <CardTitle>Vercel</CardTitle>
                      <CardDescription className="mt-2">
                        Run Cloud Agent on your organization&apos;s Vercel account.
                      </CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <Button variant="outline" className="group w-full" asChild>
                    <Link href={`/organizations/${organization.id}/integrations/cloud/vercel`}>
                      Configure Vercel
                      <ArrowRight className="ml-2 h-4 w-4 transition-transform group-hover:translate-x-1" />
                    </Link>
                  </Button>
                </CardContent>
              </Card>
            </div>
          </>
        );
      }}
    />
  );
}
