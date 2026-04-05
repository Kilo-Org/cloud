import { Suspense } from 'react';
import AdminPage from '@/app/admin/components/AdminPage';
import {
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { AIAttributionDebug } from './AIAttributionDebug';

const breadcrumbs = (
  <>
    <BreadcrumbItem>
      <BreadcrumbLink href="/admin/debug">Debug</BreadcrumbLink>
    </BreadcrumbItem>
    <BreadcrumbSeparator />
    <BreadcrumbItem>
      <BreadcrumbPage>AI Attribution</BreadcrumbPage>
    </BreadcrumbItem>
  </>
);

export default async function AdminDebugAIAttributionPage() {
  return (
    <AdminPage breadcrumbs={breadcrumbs}>
      <Suspense fallback={<div>Loading...</div>}>
        <AIAttributionDebug />
      </Suspense>
    </AdminPage>
  );
}
