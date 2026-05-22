import { getUserFromAuthOrRedirect } from '@/lib/user/server';

/**
 * Do NOT hard-code a `callbackPath` on the sign-in URL — the layout
 * wraps many descendant routes, and a literal callback here would send
 * users back to the parent list after sign-in regardless of which
 * page they originally requested. Passing the default lets
 * `appendCallbackPath` read `x-pathname` from headers and preserve the
 * actual destination.
 */
export default async function OrgWastelandGateLayout({ children }: { children: React.ReactNode }) {
  await getUserFromAuthOrRedirect();
  return <>{children}</>;
}
