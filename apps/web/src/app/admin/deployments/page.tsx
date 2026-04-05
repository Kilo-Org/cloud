import { Suspense } from 'react';
import AdminPage from '../components/AdminPage';
import { BreadcrumbItem, BreadcrumbPage } from '@/components/ui/breadcrumb';
import { DeploymentsTable } from '../components/Deployments/DeploymentsTable';

const breadcrumbs = (
  <>
    <BreadcrumbItem>
      <BreadcrumbPage>Deployments</BreadcrumbPage>
    </BreadcrumbItem>
  </>
);

export default async function DeploymentsPage() {
  return (
    <AdminPage breadcrumbs={breadcrumbs}>
      <Suspense fallback={<div>Loading deployments...</div>}>
        <DeploymentsTable />
      </Suspense>
    </AdminPage>
  );
}
