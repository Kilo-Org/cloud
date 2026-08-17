import type { ReactNode } from 'react';
import { and, eq, isNull } from 'drizzle-orm';
import { redirect } from 'next/navigation';

import { organizations } from '@kilocode/db/schema';
import { ORGANIZATION_BILLING_ROLES } from '@kilocode/app-shared/organizations';
import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { db } from '@/lib/drizzle';

async function AuthorizedSubOrganizationsLayout({
  organizationId,
  parentOrganizationId,
  children,
}: {
  organizationId: string;
  parentOrganizationId: string | null;
  children: ReactNode;
}) {
  if (parentOrganizationId !== null) redirect(`/organizations/${organizationId}`);

  const [child] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(
      and(
        eq(organizations.parent_organization_id, organizationId),
        isNull(organizations.deleted_at)
      )
    )
    .limit(1);
  if (!child) redirect(`/organizations/${organizationId}`);

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
