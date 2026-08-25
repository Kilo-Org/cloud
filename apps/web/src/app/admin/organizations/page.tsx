import { Suspense } from 'react';
import { OrganizationsTable } from '../components/OrganizationsTable';
import { CreateDemoOrganizationButton } from '../components/CreateDemoOrganizationDialog';

export default async function OrganizationsPage() {
  return (
    <Suspense fallback={<div>Loading organizations...</div>}>
      <OrganizationsTable
        defaultStripeStatus="active"
        actions={<CreateDemoOrganizationButton />}
      />
    </Suspense>
  );
}
