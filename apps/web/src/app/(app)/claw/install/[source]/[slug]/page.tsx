import { notFound, redirect } from 'next/navigation';
import { TRPCError } from '@trpc/server';
import { getUserFromAuthOrRedirect } from '@/lib/user/server';
import { requireKiloClawAccess } from '@/lib/kiloclaw/access-gate';
import { fetchInstallPayload } from '@/lib/kiloclaw/install';
import { INSTALL_SOURCES, isInstallSource } from '@/lib/kiloclaw/install-sources';
import { InstallClient } from './InstallClient';

type InstallPageProps = {
  params: Promise<{ source: string; slug: string }>;
};

/**
 * One-click install preview for a signed source payload (ClawByte today,
 * more sources later). Rendered as a Server Component — loading this page
 * does NO install work. The actual chat dispatch happens only on an explicit
 * Install click in `InstallClient`, which fires the `installFromSource` POST
 * mutation. That split is load-bearing: a GET must never dispatch, or a
 * third-party page could pop a prompt into a user's chat just by getting
 * them to load the URL (CSRF / lure-a-click).
 *
 * Gating, in order:
 * 1. Auth — the parent claw layout (`getUserFromAuthOrRedirect`) bounces
 *    unauth users to sign-in; `callbackPath` preserves this pathname so they
 *    return here after signing in. We call it again to get the user id.
 * 2. Active paid access — fetching + verifying the signed byte is paid-user
 *    compute (outbound HTTP + Ed25519 verify). A logged-in user without an
 *    active subscription/trial must NOT be able to trigger it, so we gate
 *    before the fetch and route no-access users into the subscribe/provision
 *    funnel (`/claw/new`) instead of pulling the byte.
 * 3. Payload fetch + verify — only after the access gate passes.
 *
 * Unknown source / unsigned byte / failed verification / slug mismatch →
 * `notFound()` (404). All cases logged in detail by `fetchInstallPayload`.
 */
export default async function InstallPage({ params }: InstallPageProps) {
  const { source, slug } = await params;
  if (!isInstallSource(source)) notFound();

  const user = await getUserFromAuthOrRedirect();

  try {
    await requireKiloClawAccess(user.id);
  } catch (err) {
    // No active subscription/trial → don't pull the byte. Send them to the
    // subscribe/provision flow (which presents the marketing/sign-up page).
    // We intentionally don't persist install intent across that flow; the user
    // installs again from the byte page once they're set up.
    if (err instanceof TRPCError && err.code === 'FORBIDDEN') {
      redirect('/claw/new');
    }
    throw err;
  }

  const payload = await fetchInstallPayload(source, slug);
  if (!payload) notFound();

  return (
    <InstallClient source={source} sourceLabel={INSTALL_SOURCES[source].label} payload={payload} />
  );
}
