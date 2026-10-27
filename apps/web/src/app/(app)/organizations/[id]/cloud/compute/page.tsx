import { notFound, redirect } from 'next/navigation';
import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';

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
        redirect(`/organizations/${organization.id}/cloud?settings=compute`);
      }}
    />
  );
}
