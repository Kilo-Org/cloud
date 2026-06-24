'use client';

import { useParams } from 'next/navigation';
import { PageLayout } from '@/components/PageLayout';
import { OrganizationSetupWizard } from '@/components/organizations/welcome/OrganizationSetupWizard';

export default function OrganizationStartPage() {
  const { id } = useParams<{ id: string }>();

  return (
    <PageLayout title="Organization setup">
      <OrganizationSetupWizard organizationId={id} />
    </PageLayout>
  );
}
