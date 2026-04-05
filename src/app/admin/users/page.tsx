import { Suspense } from 'react';
import { UsersTable } from '../components/UsersTable';
import AdminPage from '../components/AdminPage';
import { BreadcrumbItem, BreadcrumbPage } from '@/components/ui/breadcrumb';

const breadcrumbs = (
  <>
    <BreadcrumbItem>
      <BreadcrumbPage>Users</BreadcrumbPage>
    </BreadcrumbItem>
  </>
);

export default async function UsersPage() {
  return (
    <AdminPage breadcrumbs={breadcrumbs}>
      <Suspense fallback={<div>Loading users...</div>}>
        <UsersTable />
      </Suspense>
    </AdminPage>
  );
}
