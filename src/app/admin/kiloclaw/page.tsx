import { Suspense } from 'react';
import AdminPage from '../components/AdminPage';
import { BreadcrumbItem, BreadcrumbPage } from '@/components/ui/breadcrumb';
import { KiloclawDashboard } from '../components/KiloclawDashboard';

const breadcrumbs = (
  <>
    <BreadcrumbItem>
      <BreadcrumbPage>KiloClaw</BreadcrumbPage>
    </BreadcrumbItem>
  </>
);

export default async function KiloclawAdminPage() {
  return (
    <AdminPage breadcrumbs={breadcrumbs}>
      <Suspense fallback={<div>Loading KiloClaw...</div>}>
        <KiloclawDashboard />
      </Suspense>
    </AdminPage>
  );
}
