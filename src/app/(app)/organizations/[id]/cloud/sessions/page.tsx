import { Suspense } from 'react';
import { SessionsPageContent } from '@/app/(app)/cloud/sessions/SessionsPageContent';
import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';

export default async function OrganizationSessionsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return (
    <OrganizationByPageLayout
      params={params}
      render={() => (
        <Suspense
          fallback={<div className="flex h-screen items-center justify-center">Loading...</div>}
        >
          <SessionsPageContent />
        </Suspense>
      )}
    />
  );
}
