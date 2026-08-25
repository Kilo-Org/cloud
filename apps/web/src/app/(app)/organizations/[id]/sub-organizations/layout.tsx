import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';

import { ORGANIZATION_BILLING_ROLES } from '@kilocode/app-shared/organizations';
import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';

export function AuthorizedSubOrganizationsLayout({
  organizationId,
  parentOrganizationId,
  children,
}: {
  organizationId: string;
  parentOrganizationId: string | null;
  children: ReactNode;
}) {
  if (parentOrganizationId !== null) redirect(`/organizations/${organizationId}`);

  return children;
}

export default async function SubOrganizationsLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ id: string }>;
}) {
  return (
    <OrganizationByPageLayout
      params={params}
      roles={ORGANIZATION_BILLING_ROLES}
      render={({ organization }) => (
        <AuthorizedSubOrganizationsLayout
          organizationId={organization.id}
          parentOrganizationId={organization.parent_organization_id}
        >
          {children}
        </AuthorizedSubOrganizationsLayout>
      )}
    />
  );
}
