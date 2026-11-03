import { Suspense } from 'react';
import { requireAdminPage, AdminStepUpGate } from '@/lib/admin/require-admin-page';
import { KiloclawInstanceDetail } from '../../components/KiloclawInstances/KiloclawInstanceDetail';

export default async function KiloclawInstanceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const adminAccess = await requireAdminPage();
  if (!adminAccess.user) {
    return <AdminStepUpGate requirement={adminAccess.stepUp} />;
  }

  const { id } = await params;
  const instanceId = decodeURIComponent(id);

  return (
    <Suspense fallback={<div>Loading instance details...</div>}>
      <KiloclawInstanceDetail instanceId={instanceId} />
    </Suspense>
  );
}
