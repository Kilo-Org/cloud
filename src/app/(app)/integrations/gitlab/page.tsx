import { Suspense } from 'react';
import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { GitLabIntegrationDetails } from '@/components/integrations/GitLabIntegrationDetails';
import { UserGitLabProvider } from '@/components/integrations/UserGitLabProvider';
import { Button } from '@/components/ui/button';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { PageLayout } from '@/components/PageLayout';

export default async function UserGitLabIntegrationPage({
  searchParams,
}: {
  searchParams: Promise<{
    success?: string;
    error?: string;
  }>;
}) {
  await getUserFromAuthOrRedirect('/users/sign_in');
  const search = await searchParams;

  return (
    <PageLayout
      title="GitLab Integration"
      subtitle="Manage your personal GitLab integration"
      headerActions={
        <Link href="/integrations">
          <Button variant="ghost" size="sm" className="gap-2">
            <ArrowLeft className="h-4 w-4" />
            Back to Integrations
          </Button>
        </Link>
      }
    >
      <UserGitLabProvider>
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
          <GitLabIntegrationDetails success={search.success === 'connected'} error={search.error} />
        </Suspense>
      </UserGitLabProvider>
    </PageLayout>
  );
}
