import { Suspense } from 'react';
import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { GitHubIntegrationDetails } from '@/components/integrations/GitHubIntegrationDetails';
import { Button } from '@/components/ui/button';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { PageLayout } from '@/components/PageLayout';

export default async function UserGitHubIntegrationPage({
  searchParams,
}: {
  searchParams: Promise<{
    success?: string;
    error?: string;
    pending_approval?: string;
    org?: string;
  }>;
}) {
  await getUserFromAuthOrRedirect('/users/sign_in');
  const search = await searchParams;

  return (
    <PageLayout
      title="GitHub Integration"
      subtitle="Manage your personal GitHub App installation"
      headerActions={
        <Link href="/integrations">
          <Button variant="ghost" size="sm" className="gap-2">
            <ArrowLeft className="h-4 w-4" />
            Back to Integrations
          </Button>
        </Link>
      }
    >
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
        <GitHubIntegrationDetails
          success={search.success === 'installed'}
          error={search.error}
          pendingApproval={search.pending_approval === 'true'}
          existingPendingOrg={search.org}
        />
      </Suspense>
    </PageLayout>
  );
}
