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
 *
 * Do NOT hard-code a `callbackPath` on the sign-in URL — the layout
 * wraps many descendant routes, and a literal callback here would send
 * users back to the parent list after sign-in regardless of which
 * page they originally requested. Passing the default lets
 * `appendCallbackPath` read `x-pathname` from headers and preserve the
 * actual destination.
 */
export default async function OrgWastelandGateLayout({ children }: { children: React.ReactNode }) {
  const user = await getUserFromAuthOrRedirect();
  if (!(await isWastelandEnabled(user.id, { isAdmin: user.is_admin }))) {
    return notFound();
  }
  return <>{children}</>;
}
