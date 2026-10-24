import { Suspense } from 'react';
import AdminPage from '../components/AdminPage';
import { InternalBotUsers } from '../components/InternalBotUsers';
import { BreadcrumbItem, BreadcrumbPage } from '@/components/ui/breadcrumb';

const breadcrumbs = (
  <>
    <BreadcrumbItem>
      <BreadcrumbPage>Internal Bot Users</BreadcrumbPage>
    </BreadcrumbItem>
  </>
);

export default async function InternalBotUsersPage() {
  return (
    <AdminPage breadcrumbs={breadcrumbs}>
      <div className="flex w-full flex-col gap-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-bold">Internal Bot Users</h2>
        </div>
        <Suspense fallback={<div>Loading internal bot users...</div>}>
          <InternalBotUsers />
        </Suspense>
      </div>
    </AdminPage>
  );
}
