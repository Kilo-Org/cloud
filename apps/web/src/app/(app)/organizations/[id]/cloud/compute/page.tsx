import { notFound } from 'next/navigation';
import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { VercelComputeSettings } from './VercelComputeSettings';

export default async function OrganizationComputePage({
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
