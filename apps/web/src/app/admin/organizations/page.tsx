import { Suspense } from 'react';
import { OrganizationsTable } from '../components/OrganizationsTable';

export default async function OrganizationsPage() {
  return (
    <Suspense fallback={<div>Loading organizations...</div>}>
      <OrganizationsTable />
    </Suspense>
  );
}
