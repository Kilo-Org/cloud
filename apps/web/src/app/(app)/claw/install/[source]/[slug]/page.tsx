import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { TRPCError } from '@trpc/server';
import { getUserFromAuthOrRedirect } from '@/lib/user/server';
import { requireKiloClawAccess } from '@/lib/kiloclaw/access-gate';
import { dispatchInstallFromSource } from '@/lib/kiloclaw/install-dispatch';
import { isInstallSource } from '@/lib/kiloclaw/install-sources';

type InstallPageProps = {
  params: Promise<{ source: string; slug: string }>;
};

/**
 * One-click install for a signed source payload (ClawByte today, more
 * sources later). The user clicks "Try in KiloClaw" on kilo.ai, lands
 * here, and the server dispatches the byte's prompt into their kiloclaw
 * chat as a user-turn before redirecting to /claw/chat.
 *
 * No client component, no button, no second click — the install URL IS
 * the click. If we ever want a "review the prompt before running it"
 * gate, that lands on the chat/agent side later, not here.
 *
 * Auth + access:
 * - Parent claw layout's getUserFromAuthOrRedirect bounces unauth users
 *   to sign-in (pathname preserved by callbackPath, so they return
 *   here after signing in).
 * - requireKiloClawAccess throws TRPCError FORBIDDEN if the user has no
 *   active KiloClaw subscription/trial.
 *
 * Outcomes:
 * - Verified payload + active instance → as-user dispatch + redirect to
 *   /claw/chat.
 * - Verified payload + no instance yet → set pending_install cookie,
 *   redirect to /claw/new so provisioning can run; the chat page
 *   consumes the cookie once chat is ready.
 * - Unknown source / unsigned byte / failed verification / slug mismatch
 *   → notFound() (404). All cases logged in detail by the fetcher.
 */
export default async function InstallPage({ params }: InstallPageProps) {
  const { source, slug } = await params;
  if (!isInstallSource(source)) notFound();

  const user = await getUserFromAuthOrRedirect();
  await requireKiloClawAccess(user.id);

  let result: Awaited<ReturnType<typeof dispatchInstallFromSource>>;
  try {
    result = await dispatchInstallFromSource({ userId: user.id, source, slug });
  } catch (err) {
    if (err instanceof TRPCError && err.code === 'NOT_FOUND') notFound();
    // Let everything else bubble to Next.js's error boundary so we don't
    // mask a real misconfiguration as a missing byte.
    throw err;
  }

  if (result.ok) {
    redirect('/claw/chat');
  }

  // result.ok === false, code === 'no_instance' — the user is entitled to
  // install but hasn't provisioned a kiloclaw yet (or the runtime sandbox
  // isn't reporting yet). Stash the install intent in a cookie and send
  // them through provisioning; the chat page picks it up afterwards.
  const cookieStore = await cookies();
  cookieStore.set('pending_install', JSON.stringify({ source, slug }), {
    path: '/claw',
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 60 * 60, // 1h — generous enough for provisioning, short
    // enough that a stale cookie isn't redispatched days later.
  });
  redirect('/claw/new');
}
