import { Suspense } from 'react';
import { IntegrationsPageClient } from './IntegrationsPageClient';
import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { SetPageTitle } from '@/components/SetPageTitle';
import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { notFound } from 'next/navigation';
import { ENABLE_DEPLOY_FEATURE } from '@/lib/constants';

export default async function IntegrationsPage({ params }: { params: Promise<{ id: string }> }) {
  await getUserFromAuthOrRedirect('/users/sign_in');

  if (!ENABLE_DEPLOY_FEATURE) {
    return notFound();
  }

  return (
    <OrganizationByPageLayout
      params={params}
      render={({ organization }) => (
        <>
          <SetPageTitle title="Integrations" />
          <p className="text-muted-foreground">
            Connect and manage platform integrations for {organization.name}
          </p>

          <Suspense fallback={<div>Loading...</div>}>
            <IntegrationsPageClient organizationId={organization.id} />
          </Suspense>
        </>
      )}
    />
  );
}
