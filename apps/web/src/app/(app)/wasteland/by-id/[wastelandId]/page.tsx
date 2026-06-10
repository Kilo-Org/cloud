import { getUserFromAuthOrRedirect } from '@/lib/user/server';
import { redirect } from 'next/navigation';
import { resolveWastelandUpstreamForUser } from '@/lib/wasteland/server-resolve';

export default async function WastelandDashboardPage({
  params,
}: {
  params: Promise<{ wastelandId: string }>;
}) {
  const { wastelandId } = await params;
  const user = await getUserFromAuthOrRedirect(
    `/users/sign_in?callbackPath=/wasteland/${wastelandId}`
  );

  // M2.8: prefer the M2.2 owner/repo URL when the wasteland has an upstream
  // set. If we can't resolve it (no upstream, lookup failure), fall back to
  // the legacy `/wanted` view — the next.config.mjs rewrite keeps that path
  // working.
  const upstream = await resolveWastelandUpstreamForUser(user, wastelandId);
  if (upstream) {
    redirect(`/wasteland/${upstream.owner}/${upstream.repo}`);
  }
  redirect(`/wasteland/${wastelandId}/wanted`);
}
