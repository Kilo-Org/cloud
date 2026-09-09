import { notFound } from 'next/navigation';

import { VercelComputeSettings } from '@/components/integrations/cloud/VercelComputeSettings';
import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';

export default async function OrganizationVercelComputePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return (
    <OrganizationByPageLayout
      params={params}
      render={({ organization, role, isGlobalAdmin }) => {
        if (!isGlobalAdmin && role !== 'owner' && role !== 'admin') notFound();
        return <VercelComputeSettings organizationId={organization.id} />;
      }}
    />
  );
}
