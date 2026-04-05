import { Suspense } from 'react';
import { BlacklistedDomains } from '../components/BlacklistedDomains';
import AdminPage from '../components/AdminPage';
import { BreadcrumbItem, BreadcrumbPage } from '@/components/ui/breadcrumb';

const breadcrumbs = (
  <>
    <BreadcrumbItem>
      <BreadcrumbPage>Blacklisted Domains</BreadcrumbPage>
    </BreadcrumbItem>
  </>
);

export default async function BlacklistedDomainsPage() {
  return (
    <AdminPage breadcrumbs={breadcrumbs}>
      <div className="flex w-full flex-col gap-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-bold">Blacklisted Domains</h2>
        </div>

        <Suspense fallback={<div>Loading blacklisted domains...</div>}>
          <BlacklistedDomains />
        </Suspense>
      </div>
    </AdminPage>
  );
}
