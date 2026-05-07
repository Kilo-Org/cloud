import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { KILOCLAW_API_URL } from '@/lib/config.server';
import { generateApiToken, TOKEN_EXPIRY } from '@/lib/tokens';

/**
 * POST /api/kiloclaw/clawmetry/[instanceId]
 *
 * One-shot endpoint backing the "View Observability Dashboard" button. Does
 * two things on the user's KiloClaw instance and returns the dashboard URL
 * the browser should open in a new tab:
 *
 *   1. POST `/_kilo/clawmetry-start-sync` — spawns the sync daemon (idempotent)
 *   2. GET  `/_kilo/clawmetry-dashboard-url` — reads the self-decrypting URL
 *
 * Both calls go through the existing per-instance worker proxy
 * (`{KILOCLAW_API_URL}/i/{instanceId}/...`) which already handles JWT auth,
 * access control, and the gateway-token signing for the controller.
 *
 * The returned URL contains the AES-256-GCM enc_key in its `#fragment` —
 * that fragment is meaningful only to the browser (servers never see it).
 * The browser stashes the key in localStorage and decrypts ClawMetry
 * events client-side.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ instanceId: string }> }) {
  const { instanceId } = await params;
  if (!instanceId || !/^[A-Za-z0-9_-]+$/.test(instanceId)) {
    return NextResponse.json({ error: 'Invalid instance ID' }, { status: 400 });
  }

  const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });
  if (authFailedResponse) return authFailedResponse;

  if (!KILOCLAW_API_URL) {
    return NextResponse.json({ error: 'KiloClaw not configured' }, { status: 503 });
  }

  const token = generateApiToken(user, undefined, { expiresIn: TOKEN_EXPIRY.fiveMinutes });
  const proxyBase = `${KILOCLAW_API_URL}/i/${encodeURIComponent(instanceId)}`;
  const headers = { Authorization: `Bearer ${token}` };

  // 1. Start the sync daemon — idempotent. Failure here is non-fatal; we
  //    still try to return the dashboard URL so the user can at least see
  //    historical data (or an empty dashboard with a clear error state).
  try {
    const startRes = await fetch(`${proxyBase}/_kilo/clawmetry-start-sync`, {
      method: 'POST',
      headers,
    });
    if (!startRes.ok && startRes.status !== 404) {
      console.warn(`[clawmetry] start-sync returned ${startRes.status} for instance ${instanceId}`);
    }
  } catch (err) {
    console.warn(`[clawmetry] start-sync error for instance ${instanceId}:`, err);
  }

  // 2. Fetch the self-decrypting dashboard URL.
  let urlRes: Response;
  try {
    urlRes = await fetch(`${proxyBase}/_kilo/clawmetry-dashboard-url`, { headers });
  } catch (err) {
    console.error(`[clawmetry] dashboard-url fetch failed for instance ${instanceId}:`, err);
    return NextResponse.json({ error: 'Failed to reach instance' }, { status: 502 });
  }

  if (urlRes.status === 404) {
    return NextResponse.json(
      {
        error:
          'ClawMetry not provisioned on this instance — try redeploying or check KILOCLAW_CLAWMETRY_DISABLED env var',
      },
      { status: 404 }
    );
  }
  if (!urlRes.ok) {
    return NextResponse.json(
      { error: `Instance returned ${urlRes.status}` },
      { status: urlRes.status }
    );
  }

  const body = (await urlRes.json()) as { url?: string };
  if (!body.url) {
    return NextResponse.json({ error: 'Instance returned no dashboard URL' }, { status: 502 });
  }

  return NextResponse.json({ url: body.url });
}
