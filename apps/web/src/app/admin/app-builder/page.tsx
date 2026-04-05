import { Suspense } from 'react';
import AdminPage from '../components/AdminPage';
import { BreadcrumbItem, BreadcrumbPage } from '@/components/ui/breadcrumb';
import { AppBuilderProjectsTable } from '../components/AppBuilder/AppBuilderProjectsTable';

const breadcrumbs = (
  <>
    <BreadcrumbItem>
      <BreadcrumbPage>App Builder Projects</BreadcrumbPage>
    </BreadcrumbItem>
  </>
);

export default async function AppBuilderPage() {
  return (
    <AdminPage breadcrumbs={breadcrumbs}>
      <Suspense fallback={<div>Loading App Builder projects...</div>}>
        <AppBuilderProjectsTable />
      </Suspense>
    </AdminPage>
  );
}
