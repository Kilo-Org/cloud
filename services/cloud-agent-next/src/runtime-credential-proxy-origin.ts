import { Buffer } from 'node:buffer';
import { resolveSecret, type SecretBinding } from './auth.js';
import { runtimeCredentialProxyFacadeBaseUrl } from './runtime-credential-proxy.js';

/**
 * Proof that a runtime credential proxy request left through the egress of the
 * sandbox that owns its handle. The platform adds it outside the sandbox: the
 * Cloudflare Containers outbound handler sets it, and on Vercel the network
 * policy injects it. Sandbox processes never see the value, so a handle copied
 * out of a sandbox cannot be used from elsewhere.
 */
export const RUNTIME_PROXY_ORIGIN_HEADER = 'x-kilo-runtime-proxy-origin';

const PROOF_CONTEXT = 'kilo-runtime-proxy-origin:v1:';
const encoder = new TextEncoder();

type OriginEnv = { NEXTAUTH_SECRET?: SecretBinding };

/**
 * The proof for one sandbox egress: a keyed MAC over its outbound id (the
 * Containers outbound container id, or the logical sandbox id on Vercel). The
 * id alone is derivable from the sandbox id, so it is never the proof itself.
 */
export async function runtimeProxyOriginProof(
  env: OriginEnv,
  outboundId: string
): Promise<string | null> {
  const secret = await resolveSecret(env.NEXTAUTH_SECRET);
  if (!secret) return null;
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(PROOF_CONTEXT + outboundId));
  return Buffer.from(mac).toString('base64url');
}

/** Facade routes are the `/api/` paths under the facade base; other Worker routes are not. */
function isFacadeRequest(url: URL, facade: string | null): boolean {
  if (facade === null) return false;
  const base = new URL(facade);
  return (
    url.origin === base.origin &&
    url.pathname.startsWith(`${base.pathname.replace(/\/+$/, '')}/api/`)
  );
}

/**
 * Replaces any sandbox-supplied origin header, and adds this sandbox's proof
 * only to runtime credential proxy facade requests, which strip it upstream.
 */
export async function withRuntimeProxyOrigin(
  request: Request,
  env: OriginEnv & { WORKER_URL?: string },
  outboundId: string
): Promise<Request> {
  const facade = env.WORKER_URL ? runtimeCredentialProxyFacadeBaseUrl(env.WORKER_URL) : null;
  const toFacade = isFacadeRequest(new URL(request.url), facade);
  if (!toFacade && !request.headers.has(RUNTIME_PROXY_ORIGIN_HEADER)) return request;
  const headers = new Headers(request.headers);
  headers.delete(RUNTIME_PROXY_ORIGIN_HEADER);
  const proof = toFacade ? await runtimeProxyOriginProof(env, outboundId) : null;
  if (proof !== null) headers.set(RUNTIME_PROXY_ORIGIN_HEADER, proof);
  return new Request(request, { headers });
}
