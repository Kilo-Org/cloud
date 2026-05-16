import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { notFound, redirect } from 'next/navigation';
import { isWastelandEnabled } from '@/lib/wasteland/feature-flags';

export default async function WastelandDashboardPage({
  params,
}: {
  params: Promise<{ wastelandId: string }>;
}) {
  const { wastelandId } = await params;
  const user = await getUserFromAuthOrRedirect(
    `/users/sign_in?callbackPath=/wasteland/${wastelandId}`
  );

  if (!(await isWastelandEnabled(user.id, { isAdmin: user.is_admin }))) {
    return notFound();
  }

  // Redirect to the legacy-shaped URL on purpose. The next.config.mjs
  // `beforeFiles` rewrite catches /wasteland/<uuid>/<rest> and rewrites it
  // to /wasteland/by-id/<uuid>/<rest>, so this path resolves correctly
  // without exposing the `by-id` segment in the browser bar. Keeping the
  // user-visible URL stable preserves links/bookmarks until the M2.8
  // owner/repo cutover.
  redirect(`/wasteland/${wastelandId}/wanted`);
}
