import { redirect } from 'next/navigation';

export default async function OrgWastelandDashboardPage({
  params,
}: {
  params: Promise<{ id: string; wastelandId: string }>;
}) {
  const { id, wastelandId } = await params;
  redirect(`/organizations/${id}/wasteland/${wastelandId}/wanted`);
}
