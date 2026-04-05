import AdminPage from '@/app/admin/components/AdminPage';
import {
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { BeadInspectorDashboard } from './BeadInspectorDashboard';

export default async function BeadInspectorPage({
  params,
}: {
  params: Promise<{ townId: string; beadId: string }>;
}) {
  const { townId, beadId } = await params;

  const breadcrumbs = (
    <>
      <BreadcrumbItem>
        <BreadcrumbLink href="/admin/gastown">Gas Town</BreadcrumbLink>
      </BreadcrumbItem>
      <BreadcrumbSeparator />
      <BreadcrumbItem>
        <BreadcrumbLink href={`/admin/gastown/towns/${townId}`}>
          Town {townId.slice(0, 8)}…
        </BreadcrumbLink>
      </BreadcrumbItem>
      <BreadcrumbSeparator />
      <BreadcrumbItem>
        <BreadcrumbPage>Bead {beadId.slice(0, 8)}…</BreadcrumbPage>
      </BreadcrumbItem>
    </>
  );

  return (
    <AdminPage breadcrumbs={breadcrumbs}>
      <BeadInspectorDashboard townId={townId} beadId={beadId} />
    </AdminPage>
  );
}
