import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { AuditLogsPage } from './AuditLogsPage';

export default async function OrganizationAuditLogsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return (
    <OrganizationByPageLayout
      params={params}
      render={({ role, organization }) => (
        <AuditLogsPage organizationId={organization.id} role={role} />
      )}
    />
  );
}
