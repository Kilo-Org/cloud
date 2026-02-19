import { Suspense } from 'react';
import AdminPage from '../components/AdminPage';
import { BreadcrumbItem, BreadcrumbPage } from '@/components/ui/breadcrumb';
import { KiloclawInstancesPage } from '../components/KiloclawInstances/KiloclawInstancesPage';

const breadcrumbs = (
  <>
    <BreadcrumbItem>
      <BreadcrumbPage>KiloClaw Instances</BreadcrumbPage>
    </BreadcrumbItem>
  </>
);

export default async function KiloclawInstancesAdminPage() {
  return (
    <AdminPage breadcrumbs={breadcrumbs}>
      <Suspense fallback={<div>Loading KiloClaw instances...</div>}>
        <KiloclawInstancesPage />
      </Suspense>
    </AdminPage>
  );
}
