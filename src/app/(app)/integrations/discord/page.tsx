import { Suspense } from 'react';
import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { DiscordIntegrationDetails } from '@/components/integrations/DiscordIntegrationDetails';
import { UserDiscordProvider } from '@/components/integrations/UserDiscordProvider';
import { Button } from '@/components/ui/button';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { PageLayout } from '@/components/PageLayout';

export default async function UserDiscordIntegrationPage({
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
      title="Discord Integration"
      subtitle="Connect your Discord server to interact with Kilo"
      headerActions={
        <Link href="/integrations">
          <Button variant="ghost" size="sm" className="gap-2">
            <ArrowLeft className="h-4 w-4" />
            Back to Integrations
          </Button>
        </Link>
      }
    >
      <UserDiscordProvider>
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
            success={search.success === 'installed'}
            error={search.error}
          />
        </Suspense>
      </UserDiscordProvider>
    </PageLayout>
  );
}
