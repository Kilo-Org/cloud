import { Suspense } from 'react';
import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { SlackIntegrationDetails } from '@/components/integrations/SlackIntegrationDetails';
import { Button } from '@/components/ui/button';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { PageLayout } from '@/components/PageLayout';

export default async function UserSlackReinstallPage({
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
      title="Reinstall Slack Integration"
      subtitle="Refresh Slack permissions for Kilo Bot"
      headerActions={
        <Link href="/integrations/slack">
          <Button variant="ghost" size="sm" className="gap-2">
            <ArrowLeft className="h-4 w-4" />
            Back to Slack Integration
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
        <SlackIntegrationDetails
          success={search.success === 'installed'}
          error={search.error}
          mode="reinstall"
        />
      </Suspense>
    </PageLayout>
  );
}
