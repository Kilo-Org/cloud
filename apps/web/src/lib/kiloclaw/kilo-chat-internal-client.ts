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
 * Two env vars are required at runtime:
 * - `KILO_CHAT_INTERNAL_URL` — server-only destination for the internal
 *   call. Preferred so the key + prompt destination is never sourced from a
 *   browser-exposed `NEXT_PUBLIC_*` var. Falls back to
 *   `NEXT_PUBLIC_KILO_CHAT_URL` (with a warning) until the new var is
 *   provisioned on every project; a follow-up drops the fallback.
 * - `INTERNAL_API_SECRET` — shared secret with kilo-chat's Secrets Store
 *   binding. Already used by other cloud → service integrations.
 */

// Origins the internal API key may be sent to. The destination comes from
// deploy config (KILO_CHAT_INTERNAL_URL, or the NEXT_PUBLIC_KILO_CHAT_URL
// fallback), so this is defense in depth: a misconfigured or tampered value
// must not be able to forward the key (and the prompt) to an unexpected host.
// `chat.kiloapps.io` is the single deployed
// kilo-chat origin (services/kilo-chat/wrangler.jsonc). Loopback covers local
// dev on any port (KILO_PORT_OFFSET can shift it). Add new deployed origins
// here if kilo-chat ever gains a staging domain.
function isAllowedKiloChatOrigin(url: URL): boolean {
  if (url.protocol === 'https:' && url.hostname === 'chat.kiloapps.io') return true;
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return true;
  return false;
}

function getKiloChatBaseUrl(): string {
  // Prefer the server-only KILO_CHAT_INTERNAL_URL so the internal-call
  // destination is never sourced from a browser-exposed NEXT_PUBLIC_* var.
  // Migration-safe fallback to NEXT_PUBLIC_KILO_CHAT_URL (with a warning) so an
  // environment that has not provisioned the new var yet keeps working rather
  // than repeating a wrong-config outage; a follow-up removes the fallback once
  // KILO_CHAT_INTERNAL_URL is confirmed on every project. Read process.env
  // directly rather than importing from `@/lib/constants`: those constants are
  // marked required at import time, which crashes test setups if a var is
  // unset. This server-only client should fail loudly only when actually called.
  let raw = process.env.KILO_CHAT_INTERNAL_URL;
  let source = 'KILO_CHAT_INTERNAL_URL';
  if (!raw) {
    raw = process.env.NEXT_PUBLIC_KILO_CHAT_URL;
    source = 'NEXT_PUBLIC_KILO_CHAT_URL';
    if (raw) {
      console.warn(
        'KILO_CHAT_INTERNAL_URL is not set; falling back to NEXT_PUBLIC_KILO_CHAT_URL for the kilo-chat internal call. Set KILO_CHAT_INTERNAL_URL to remove this fallback.'
      );
    }
  }
  if (!raw) {
    throw new Error(
      'Neither KILO_CHAT_INTERNAL_URL nor NEXT_PUBLIC_KILO_CHAT_URL is configured, cannot reach kilo-chat internal routes'
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${source} is not a valid URL: ${raw}`);
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
