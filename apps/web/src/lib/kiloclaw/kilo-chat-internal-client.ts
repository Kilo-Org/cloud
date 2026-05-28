import 'server-only';
import { z } from 'zod';
import type { PostMessageAsUserParams, PostMessageAsUserResult } from '@kilocode/kilo-chat';
import { INTERNAL_API_SECRET } from '@/lib/config.server';

/**
 * Server-side HTTP client for kilo-chat's `/internal/v1/*` routes.
 *
 * The cloud Next.js app runs on Vercel (not Cloudflare), so it can't reach
 * kilo-chat's `WorkerEntrypoint` RPC via service binding the way other
 * Workers do. This client POSTs over plain HTTPS instead, gated by an
 * `x-internal-api-key` header that kilo-chat's `internalApiMiddleware`
 * timing-safe compares against `INTERNAL_API_SECRET`.
 *
 * Both env vars are required at runtime:
 * - `NEXT_PUBLIC_KILO_CHAT_URL` — already used by the existing public
 *   client-side kilo-chat token flow; we reuse it for the internal path.
 * - `INTERNAL_API_SECRET` — shared secret with kilo-chat's Secrets Store
 *   binding. Already used by other cloud → service integrations.
 */

const okSchema = z.object({
  ok: z.literal(true),
  conversationId: z.string(),
  messageId: z.string(),
  conversationCreated: z.boolean(),
});

const errSchema = z.object({
  ok: z.literal(false),
  code: z.enum(['invalid_request', 'no_conversation', 'forbidden', 'internal']),
  error: z.string(),
});

const responseSchema = z.discriminatedUnion('ok', [okSchema, errSchema]);

function getKiloChatBaseUrl(): string {
  // We deliberately read process.env directly here rather than importing
  // KILO_CHAT_URL from `@/lib/constants` — the constants file marks it as a
  // *required* env var at import time, which causes test setups to crash if
  // the var isn't set. This server-only client should fail loudly only when
  // it's actually called.
  const raw = process.env.NEXT_PUBLIC_KILO_CHAT_URL;
  if (!raw) {
    throw new Error(
      'NEXT_PUBLIC_KILO_CHAT_URL is not configured — cannot reach kilo-chat internal routes'
    );
  }
  return raw.replace(/\/$/, '');
}

export async function postMessageAsUser(
  params: PostMessageAsUserParams
): Promise<PostMessageAsUserResult> {
  if (!INTERNAL_API_SECRET) {
    throw new Error(
      'INTERNAL_API_SECRET is not configured — cannot authenticate to kilo-chat internal routes'
    );
  }

  const url = `${getKiloChatBaseUrl()}/internal/v1/post-message-as-user`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-api-key': INTERNAL_API_SECRET,
    },
    body: JSON.stringify(params),
    // Internal-only call between services; no caching.
    cache: 'no-store',
  });

  // kilo-chat's internal route always returns a JSON body whether the
  // outcome is ok:true (200) or ok:false (400/403/404/500). Parse first,
  // then validate against the discriminated union so callers get a typed
  // result regardless of HTTP status.
  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    throw new Error(
      `kilo-chat /internal/v1/post-message-as-user returned non-JSON response (HTTP ${res.status}): ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const parsed = responseSchema.safeParse(body);
  if (!parsed.success) {
    // Most likely: 403 from `internalApiMiddleware` before reaching the
    // route handler, which returns `{ error: 'Forbidden' }`. Surface that
    // as `forbidden` so callers don't need to know about middleware shapes.
    if (res.status === 403) {
      return { ok: false, code: 'forbidden', error: 'kilo-chat rejected the internal-api-key' };
    }
    throw new Error(
      `kilo-chat /internal/v1/post-message-as-user returned unexpected payload (HTTP ${res.status}): ${parsed.error.message}`
    );
  }

  return parsed.data;
}
