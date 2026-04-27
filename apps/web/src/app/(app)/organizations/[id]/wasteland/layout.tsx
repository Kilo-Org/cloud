import { notFound } from 'next/navigation';
import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { isWastelandEnabled } from '@/lib/wasteland/feature-flags';

/**
 * Feature-flag gate for the org-scoped wasteland route tree.
 *
 * Every descendant page (the wasteland list, `new/`, and every
 * `[wastelandId]/*` sub-page) inherits this gate automatically.
 * Personal-scoped routes handle the same check per-page; consolidating
 * it here for org routes matches the usual layout-as-auth-boundary
 * pattern and avoids drift when new sub-routes are added.
 *
 * `isWastelandEnabled` returns true for kilo admins and in non-production
 * environments; in production it checks the `wasteland-access` PostHog
 * flag for the current user.
 */
export default async function OrgWastelandGateLayout({
  params,
  children,
}: {
  params: Promise<{ id: string }>;
  children: React.ReactNode;
}) {
  const { id } = await params;
  const user = await getUserFromAuthOrRedirect(
    `/users/sign_in?callbackPath=/organizations/${id}/wasteland`
  );
  if (!(await isWastelandEnabled(user.id, { isAdmin: user.is_admin }))) {
    return notFound();
  }
  return <>{children}</>;
}
