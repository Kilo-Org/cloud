import { getUserFromAuthOrRedirect } from '@/lib/user/server';
import { RepoLayoutShell } from './_components/RepoLayoutShell';

/**
 * Server-side gate for the per-wasteland routes. Mirrors the legacy
 * `[wastelandId]` layout but anchored on `<owner>/<repo>`.
 *
 * Note: the plan eventually wants this layout to render for an
 * unauthenticated visitor (anonymous-browse path). For M2.2 we still
 * require auth at the boundary because the worker tRPC requires a JWT
 * minted from the session cookie. Anonymous browse is deferred to a
 * later milestone (see `NotConnectedShell` for the disabled CTA).
 *
 * The legacy UUID-keyed tree lives under `/wasteland/by-id/[wastelandId]`
 * so the new owner/repo tree can own the cleaner two-segment URL
 * shape directly. Legacy `/wasteland/<uuid>/<rest>` URLs are rewritten
 * to `/wasteland/by-id/<uuid>/<rest>` by the root middleware.
 */
export default async function WastelandRepoLayout({
  params,
  children,
}: {
  params: Promise<{ owner: string; repo: string }>;
  children: React.ReactNode;
}) {
  const { owner, repo } = await params;
  await getUserFromAuthOrRedirect(`/users/sign_in?callbackPath=/wasteland/${owner}/${repo}`);

  return (
    <RepoLayoutShell owner={owner} repo={repo}>
      {children}
    </RepoLayoutShell>
  );
}
