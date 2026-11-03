import { notFound } from 'next/navigation';
import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { OrganizationGuardrailsPage } from '@/components/organizations/guardrails/OrganizationGuardrailsPage';
import { isKiloEncryptEnabled } from '@/lib/organizations/kilo-encrypt';

export default async function GuardrailsPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <OrganizationByPageLayout
      params={params}
      roles={['owner', 'admin']}
      render={({ role, organization }) => {
        if (!isKiloEncryptEnabled(organization.settings)) notFound();
        return <OrganizationGuardrailsPage organizationId={organization.id} role={role} />;
      }}
    />
  );
}
