import { Suspense } from 'react';
import { OrganizationsTable } from '../../components/OrganizationsTable';

export default async function TrialOrganizationsPage() {
  return (
    <Suspense fallback={<div>Loading trial organizations...</div>}>
      <OrganizationsTable mode="trial" showMetrics={false} showStripeStatus={false} />
    </Suspense>
  );
}
