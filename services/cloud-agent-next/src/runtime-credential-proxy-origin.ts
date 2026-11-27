import { Buffer } from 'node:buffer';
import {
  CLOUD_AGENT_SESSION_SYNC_ORIGIN,
  RUNTIME_PROXY_ORIGIN_HEADER,
} from '@kilocode/worker-utils/cloud-agent-session-sync';
import { readCloudAgentNextSecret, type CloudAgentNextSecretsEnv } from './secrets.js';
import { logger } from './logger.js';
import { runtimeCredentialProxyFacadeBaseUrl } from './runtime-credential-proxy.js';

/**
 * Proof that a runtime credential proxy request left through the egress of the
 * sandbox that owns its handle. The platform adds it outside the sandbox: the
 * Cloudflare Containers outbound handler sets it, and on Vercel the network
 * policy injects it. Sandbox processes never see the value, so a handle copied
 * out of a sandbox cannot be used from elsewhere.
 */
export { RUNTIME_PROXY_ORIGIN_HEADER };

const PROOF_CONTEXT = 'kilo-runtime-proxy-origin:v1:';
const encoder = new TextEncoder();
/** A proof is an unpadded base64url HMAC-SHA256 (32 bytes). */
const PROOF_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Reads a received proof. A value that is not exactly one well-formed proof,
 * such as a duplicated header joined as `a, b`, counts as absent.
 */
export function parseRuntimeProxyOriginProof(value: unknown): string | undefined {
  return typeof value === 'string' && PROOF_PATTERN.test(value) ? value : undefined;
}

type OriginEnv = CloudAgentNextSecretsEnv;

/**
 * The proof for one sandbox egress: a keyed MAC over its outbound id (the
 * Containers outbound container id, or the logical sandbox id on Vercel). The
 * id alone is derivable from the sandbox id, so it is never the proof itself.
 */
export async function runtimeProxyOriginProof(
  env: OriginEnv,
  outboundId: string
): Promise<string | null> {
  const secret = await readCloudAgentNextSecret(env, 'NEXTAUTH_SECRET').catch(() => null);
  if (!secret) {
    // Egress then sends no proof; make that visible before readers require it.
    logger
      .withFields({
        logTag: 'runtime_proxy_origin_proof_unavailable',
        reason: 'secret_unavailable',
      })
      .warn('Runtime proxy origin proof unavailable');
    return null;
  }
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
 * only to runtime credential proxy facade and Session Sync requests.
 */
export async function withRuntimeProxyOrigin(
  request: Request,
  env: OriginEnv & { WORKER_URL?: string },
  outboundId: string
): Promise<Request> {
  const facade = env.WORKER_URL ? runtimeCredentialProxyFacadeBaseUrl(env.WORKER_URL) : null;
  const url = new URL(request.url);
  const needsProof =
    isFacadeRequest(url, facade) ||
    (url.origin === CLOUD_AGENT_SESSION_SYNC_ORIGIN && url.pathname.startsWith('/v1/'));
  if (!needsProof && !request.headers.has(RUNTIME_PROXY_ORIGIN_HEADER)) return request;
  const headers = new Headers(request.headers);
  headers.delete(RUNTIME_PROXY_ORIGIN_HEADER);
  const proof = needsProof ? await runtimeProxyOriginProof(env, outboundId) : null;
  if (proof !== null) headers.set(RUNTIME_PROXY_ORIGIN_HEADER, proof);
  return new Request(request, { headers });
}
