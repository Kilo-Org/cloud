import AdminPage from '@/app/admin/components/AdminPage';
import {
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { AgentInspectorDashboard } from './AgentInspectorDashboard';

export default async function AgentInspectorPage({
  params,
}: {
  params: Promise<{ townId: string; agentId: string }>;
}) {
  const { townId, agentId } = await params;

  const breadcrumbs = (
    <>
      <BreadcrumbItem>
        <BreadcrumbLink href="/admin/gastown">Gastown</BreadcrumbLink>
      </BreadcrumbItem>
      <BreadcrumbSeparator />
      <BreadcrumbItem>
        <BreadcrumbLink href={`/admin/gastown/towns/${townId}`}>
          Town {townId.slice(0, 8)}…
        </BreadcrumbLink>
      </BreadcrumbItem>
      <BreadcrumbSeparator />
      <BreadcrumbItem>
        <BreadcrumbPage>Agent {agentId.slice(0, 8)}…</BreadcrumbPage>
      </BreadcrumbItem>
    </>
  );

  return (
    <AdminPage breadcrumbs={breadcrumbs}>
      <AgentInspectorDashboard townId={townId} agentId={agentId} />
    </AdminPage>
  );
}
