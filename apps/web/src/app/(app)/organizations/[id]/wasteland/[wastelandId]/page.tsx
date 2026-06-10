import { redirect } from 'next/navigation';
import { getUserFromAuthOrRedirect } from '@/lib/user/server';
import { resolveWastelandUpstreamForUser } from '@/lib/wasteland/server-resolve';

export default async function OrgWastelandDashboardPage({
  params,
}: {
  params: Promise<{ id: string; wastelandId: string }>;
}) {
  const { id, wastelandId } = await params;
  const user = await getUserFromAuthOrRedirect(
    `/users/sign_in?callbackPath=/organizations/${id}/wasteland/${wastelandId}`
  );

  // M2.8: org-scoped wasteland routes redirect to the personal-shape
  // owner/repo URLs. Org membership is enforced at the worker layer; the
  // URL doesn't have to encode the org.
  const upstream = await resolveWastelandUpstreamForUser(user, wastelandId);
  if (upstream) {
    redirect(`/wasteland/${upstream.owner}/${upstream.repo}`);
  }
  redirect(`/organizations/${id}/wasteland/${wastelandId}/wanted`);
}
