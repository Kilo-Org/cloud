import 'server-only';
import {
  postMessageAsUserResultSchema,
  type PostMessageAsUserParams,
  type PostMessageAsUserResult,
} from '@kilocode/kilo-chat';
import { INTERNAL_API_SECRET } from '@/lib/config.server';

// 5s is well above kilo-chat's expected p99 for postMessageAsUser
// (~ a single DO RPC + a sendMessage) and well below Vercel's outer
// serverless function timeout, so a stuck request fails fast with a
// typed `internal` result instead of cascading into the wider request.
const POST_MESSAGE_AS_USER_TIMEOUT_MS = 5_000;

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

// Origins the internal API key may be sent to. The destination comes from
// NEXT_PUBLIC_KILO_CHAT_URL (deploy config), so this is defense in depth: a
// misconfigured or tampered value must not be able to forward the key (and the
// prompt) to an unexpected host. `chat.kiloapps.io` is the single deployed
// kilo-chat origin (services/kilo-chat/wrangler.jsonc). Loopback covers local
// dev on any port (KILO_PORT_OFFSET can shift it). Add new deployed origins
// here if kilo-chat ever gains a staging domain.
function isAllowedKiloChatOrigin(url: URL): boolean {
  if (url.protocol === 'https:' && url.hostname === 'chat.kiloapps.io') return true;
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return true;
  return false;
}

function getKiloChatBaseUrl(): string {
  // Read process.env directly rather than importing KILO_CHAT_URL from
  // `@/lib/constants`: that constant is marked required at import time, which
  // crashes test setups if the var is unset. This server-only client should
  // fail loudly only when it is actually called.
  const raw = process.env.NEXT_PUBLIC_KILO_CHAT_URL;
  if (!raw) {
    throw new Error(
      'NEXT_PUBLIC_KILO_CHAT_URL is not configured, cannot reach kilo-chat internal routes'
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`NEXT_PUBLIC_KILO_CHAT_URL is not a valid URL: ${raw}`);
  }
  if (!isAllowedKiloChatOrigin(parsed)) {
    throw new Error(
      `Refusing to send the internal API key: ${parsed.origin} is not an allowed kilo-chat origin`
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
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-api-key': INTERNAL_API_SECRET,
      },
      body: JSON.stringify(params),
      // Internal-only call between services; no caching.
      cache: 'no-store',
      // Never follow redirects on a request that carries the internal API key:
      // a misconfigured or redirecting destination must not be able to forward
      // the secret (and the prompt) to another origin. A redirect fails here
      // and surfaces as a typed `internal` result below.
      redirect: 'error',
      signal: AbortSignal.timeout(POST_MESSAGE_AS_USER_TIMEOUT_MS),
    });
  } catch (err) {
    // AbortSignal.timeout fires with a TimeoutError DOMException. Map to a
    // typed `internal` result so callers don't have to know about fetch's
    // abort/network failure modes; same shape regardless of cause.
    const isTimeout = err instanceof Error && err.name === 'TimeoutError';
    return {
      ok: false,
      code: 'internal',
      error: isTimeout
        ? `kilo-chat /internal/v1/post-message-as-user timed out after ${POST_MESSAGE_AS_USER_TIMEOUT_MS}ms`
        : `kilo-chat /internal/v1/post-message-as-user fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

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

  const parsed = postMessageAsUserResultSchema.safeParse(body);
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
