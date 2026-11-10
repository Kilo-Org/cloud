import { notFound } from 'next/navigation';
import { ORGANIZATION_BILLING_ROLES } from '@kilocode/app-shared/organizations';
import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { RequestLogsPage } from '@/components/organizations/request-logs/RequestLogsPage';
import { isKiloEncryptEnabled } from '@/lib/organizations/kilo-encrypt';
import { isRequestLogsEnabled } from '@/lib/request-logs/availability';

export default async function OrganizationRequestLogsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!(await isRequestLogsEnabled(decodeURIComponent(id)))) notFound();

  return (
    <OrganizationByPageLayout
      params={params}
      fullBleed
      roles={ORGANIZATION_BILLING_ROLES}
      render={({ organization }) => (
        <RequestLogsPage
          organizationId={organization.id}
          enkryptEnabled={isKiloEncryptEnabled(organization.settings)}
        />
      )}
    />
  );
}
