'use client';

import AdminPage from '@/app/admin/components/AdminPage';
import { BreadcrumbItem, BreadcrumbPage } from '@/components/ui/breadcrumb';
import { ClusterStatusCard } from '@/app/admin/components/CodeIndexing/ClusterStatusCard';
import { OrganizationIndexesTable } from '@/app/admin/components/CodeIndexing/OrganizationIndexesTable';
import { UserIndexesTable } from '@/app/admin/components/CodeIndexing/UserIndexesTable';

export function CodeIndexingTable() {
  const breadcrumbs = (
    <>
      <BreadcrumbItem>
        <BreadcrumbPage>Managed Indexing</BreadcrumbPage>
      </BreadcrumbItem>
    </>
  );

  return (
    <AdminPage breadcrumbs={breadcrumbs}>
      <div className="flex max-w-max flex-col gap-y-8">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Admin: Managed Indexing</h2>
        </div>

        <ClusterStatusCard />
        <OrganizationIndexesTable />
        <UserIndexesTable />
      </div>
    </AdminPage>
  );
}
