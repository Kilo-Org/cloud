import { Suspense } from 'react';
import AdminPage from '../components/AdminPage';
import { BreadcrumbItem, BreadcrumbPage } from '@/components/ui/breadcrumb';
import { CliSessionsV2Table } from '../components/CliSessionsV2/CliSessionsV2Table';

const breadcrumbs = (
  <>
    <BreadcrumbItem>
      <BreadcrumbPage>CLI Sessions V2</BreadcrumbPage>
    </BreadcrumbItem>
  </>
);

export default async function CliSessionsV2Page() {
  return (
    <AdminPage breadcrumbs={breadcrumbs}>
      <Suspense fallback={<div>Loading CLI sessions...</div>}>
        <CliSessionsV2Table />
      </Suspense>
    </AdminPage>
  );
}
