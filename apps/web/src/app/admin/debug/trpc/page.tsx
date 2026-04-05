import { TrpcDebug } from '@/app/admin/debug/trpc/TrpcDebug';
import AdminPage from '@/app/admin/components/AdminPage';
import {
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';

const breadcrumbs = (
  <>
    <BreadcrumbItem>
      <BreadcrumbLink href="/admin">Debug</BreadcrumbLink>
    </BreadcrumbItem>
    <BreadcrumbSeparator />
    <BreadcrumbItem>
      <BreadcrumbPage>TRPC</BreadcrumbPage>
    </BreadcrumbItem>
  </>
);

export default async function AdminDebugTrpcPage() {
  return (
    <AdminPage breadcrumbs={breadcrumbs}>
      <TrpcDebug />
    </AdminPage>
  );
}
