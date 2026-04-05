import AdminPage from '@/app/admin/components/AdminPage';
import {
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { TownInspectorDashboard } from './TownInspectorDashboard';

export default async function TownInspectorPage({
  params,
}: {
  params: Promise<{ townId: string }>;
}) {
  const { townId } = await params;

  const breadcrumbs = (
    <>
      <BreadcrumbItem>
        <BreadcrumbLink href="/admin/gastown">Gas Town</BreadcrumbLink>
      </BreadcrumbItem>
      <BreadcrumbSeparator />
      <BreadcrumbItem>
        <BreadcrumbPage>Town {townId.slice(0, 8)}…</BreadcrumbPage>
      </BreadcrumbItem>
    </>
  );

  return (
    <AdminPage breadcrumbs={breadcrumbs}>
      <TownInspectorDashboard townId={townId} />
    </AdminPage>
  );
}
