import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { getUserFromAuthOrRedirect } from '@kilocode/web-shared/lib/user/server';
import { PageLayout } from '@/components/PageLayout';
import { Button } from '@/components/ui/button';
import { AiRequestsClient } from '@/components/usage-requests/AiRequestsClient';

export default async function AiRequestsPage() {
  await getUserFromAuthOrRedirect('/users/sign_in?callbackPath=/usage/requests');

  return (
    <PageLayout
      title="AI requests"
      subtitle="Individual AI requests from your personal account, with the key used and the amount charged to your credits."
      headerActions={
        <Button asChild variant="ghost" size="sm">
          <Link href="/usage">
            <ArrowLeft aria-hidden />
            Usage
          </Link>
        </Button>
      }
    >
      <AiRequestsClient />
    </PageLayout>
  );
}
