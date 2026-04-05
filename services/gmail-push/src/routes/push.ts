import { Hono } from 'hono';
import { z } from 'zod';
import type { HonoContext } from '../types';
import { validateOidcToken } from '../auth/oidc';

const PubSubMessageIdSchema = z.looseObject({
  message: z.looseObject({
    messageId: z.string(),
  }),
});

export const pushRoute = new Hono<HonoContext>();

// Always return 200 to Pub/Sub — a non-2xx would cause redelivery, but we handle
// retries ourselves via the CF Queue consumer with custom exponential backoff.
// Returning 200 on auth failures, bad payloads, etc. just means "stop retrying".
pushRoute.post('/user/:userId', async c => {
  const userId = c.req.param('userId');

  // Look up the expected OIDC service account email for this user.
  // This prevents cross-project forgery: an attacker with their own GCP project
  // can get Google-signed tokens with a matching audience, but not with the
  // victim's service account email.
  const internalSecret = await c.env.INTERNAL_API_SECRET.get();
  const emailRes = await c.env.KILOCLAW.fetch(
    new Request(
      `https://kiloclaw/api/platform/gmail-oidc-email?userId=${encodeURIComponent(userId)}`,
      { headers: { 'x-internal-api-key': internalSecret } }
    )
  );

  if (!emailRes.ok) {
    console.error(`[gmail-push] OIDC email lookup failed for user ${userId}: ${emailRes.status}`);
    return c.json({ ok: true }, 200);
  }

  const { gmailPushOidcEmail }: { gmailPushOidcEmail: string | null } = await emailRes.json();
  if (!gmailPushOidcEmail) {
    // User has disconnected Gmail — acknowledge so Pub/Sub stops retrying.
    // The watch will expire on its own; no point building a retry backlog.
    console.warn(`[gmail-push] No OIDC email configured for user ${userId}, acking stale delivery`);
    return c.json({ ok: true }, 200);
  }

  // Validate Google OIDC token: issuer, per-user audience, and SA email.
  const perUserAudience = `${c.env.OIDC_AUDIENCE_BASE}/push/user/${encodeURIComponent(userId)}`;
  const oidcResult = await validateOidcToken(
    c.req.header('authorization'),
    perUserAudience,
    gmailPushOidcEmail
  );
  if (!oidcResult.valid) {
    console.warn(`[gmail-push] OIDC validation failed for user ${userId}: ${oidcResult.error}`);
    return c.json({ ok: true }, 200);
  }

  const pubSubBody = await c.req.text();
  if (pubSubBody.length > 65_536) {
    console.warn(`[gmail-push] Oversized payload for user ${userId}: ${pubSubBody.length} bytes`);
    return c.json({ ok: true }, 200);
  }

  // Extract Pub/Sub messageId for idempotency; fall back to a random UUID
  let messageId: string;
  try {
    const parsed = PubSubMessageIdSchema.safeParse(JSON.parse(pubSubBody));
    messageId = parsed.success ? parsed.data.message.messageId : crypto.randomUUID();
  } catch {
    messageId = crypto.randomUUID();
  }

  await c.env.GMAIL_PUSH_QUEUE.send({ userId, pubSubBody, messageId });

  return c.json({ ok: true }, 200);
});
