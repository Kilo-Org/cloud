import { Suspense } from 'react';
import AdminPage from '../components/AdminPage';
import { BreadcrumbItem, BreadcrumbPage } from '@/components/ui/breadcrumb';
import { IpClustersTable } from './IpClustersTable';

const breadcrumbs = (
  <>
    <BreadcrumbItem>
      <BreadcrumbPage>IP Clusters</BreadcrumbPage>
    </BreadcrumbItem>
  </>
);

export default function IpClustersPage() {
  return (
    <AdminPage breadcrumbs={breadcrumbs}>
      <Suspense fallback={<div>Loading IP clusters...</div>}>
        <IpClustersTable />
      </Suspense>
    </AdminPage>
  );
}
