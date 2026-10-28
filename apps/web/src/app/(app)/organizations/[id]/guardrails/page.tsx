import { notFound } from 'next/navigation';
import type { OrganizationRole } from '@kilocode/web-shared/lib/organizations/organization-types';
import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { OrganizationGuardrailsPage } from '@/components/organizations/guardrails/OrganizationGuardrailsPage';
import { isEnkryptGuardrailsFeatureEnabled } from '@/lib/organizations/enkrypt-guardrails-feature';

export default async function GuardrailsPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <OrganizationByPageLayout
      params={params}
      roles={['owner', 'admin']}
      render={({ role, organization }) => (
        <FeatureGatedGuardrailsPage organizationId={organization.id} role={role} />
      )}
    />
  );
}

async function FeatureGatedGuardrailsPage({
  organizationId,
  role,
}: {
  organizationId: string;
  role: OrganizationRole;
}) {
  if (!(await isEnkryptGuardrailsFeatureEnabled(organizationId))) {
    notFound();
  }
  return <OrganizationGuardrailsPage organizationId={organizationId} role={role} />;
}
