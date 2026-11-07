import type { Hono } from 'hono';
import type { HonoContext } from './hono-context.js';
import { isSafeSandboxId } from './shared/control-plane-credential.js';
import {
  configuredVercelRuntimeProxyForwardUrl,
  VERCEL_RUNTIME_PROXY_OIDC_HEADER,
  VERCEL_RUNTIME_PROXY_PATH_PREFIX,
  type RuntimeCredentialProxyOrigin,
} from './runtime-credential-proxy-origin.js';
import {
  forwardRuntimeCredentialProxy,
  matchRuntimeCredentialProxyRequest,
  runtimeProxyOriginRequiredResponse,
} from './runtime-credential-proxy-forwarding.js';
import type { Env } from './types.js';

/**
 * Vercel forwards the sandbox's original request and preserves its URL in these
 * headers, exactly like the SCM broker. The logical sandbox in the route is the
 * OIDC audience binding, never request-supplied authority.
 */
function originalTarget(headers: Headers): URL | null {
  const host = headers.get('vercel-forwarded-host');
  const scheme = headers.get('vercel-forwarded-scheme');
  const port = headers.get('vercel-forwarded-port');
  const path = headers.get('vercel-forwarded-path');
  if (
    scheme !== 'https' ||
    !host ||
    !/^[a-zA-Z0-9.-]+$/.test(host) ||
    !port ||
    !/^[1-9]\d{0,4}$/.test(port) ||
    Number(port) > 65535 ||
    !path?.startsWith('/') ||
    path.length > 16 * 1024 ||
    /[\\#]/.test(path) ||
    Array.from(path).some(
      character => character.charCodeAt(0) <= 0x20 || character.charCodeAt(0) === 0x7f
    )
  )
    return null;
  try {
    const url = new URL(`https://${host}:${port}${path}`);
    return url.hostname === host.toLowerCase() && url.href.length <= 16 * 1024 ? url : null;
  } catch {
    return null;
  }
}

export async function handleVercelRuntimeCredentialProxy(
  request: Request,
  env: Env,
  logicalSandboxId: string
): Promise<Response> {
  if (!isSafeSandboxId(logicalSandboxId)) return new Response('Not found', { status: 404 });
  const forwardUrl = configuredVercelRuntimeProxyForwardUrl(env, logicalSandboxId);
  if (!forwardUrl) return new Response('Not found', { status: 404 });
  let requestOrigin: string;
  let configuredOrigin: string;
  try {
    requestOrigin = new URL(request.url).origin;
    configuredOrigin = new URL(forwardUrl).origin;
  } catch {
    return runtimeProxyOriginRequiredResponse();
  }
  // Only the exact configured Worker authority may serve a forwardURL. A
  // provider header cannot turn a foreign host into a trusted adapter.
  if (requestOrigin !== configuredOrigin) return runtimeProxyOriginRequiredResponse();
  const oidcToken = request.headers.get(VERCEL_RUNTIME_PROXY_OIDC_HEADER);
  if (!oidcToken) return runtimeProxyOriginRequiredResponse();
  const target = originalTarget(request.headers);
  if (!target) return new Response('Unauthorized', { status: 401 });
  const matched = await matchRuntimeCredentialProxyRequest(
    new Request(target, { method: request.method }),
    env
  );
  if (!matched) return new Response('Not found', { status: 404 });
  const origin: RuntimeCredentialProxyOrigin = {
    type: 'vercel',
    oidcToken,
    logicalSandboxId,
  };
  return forwardRuntimeCredentialProxy(request, env, matched, origin);
}

export function registerVercelRuntimeCredentialProxyRoute(app: Hono<HonoContext>): void {
  for (const path of [
    `${VERCEL_RUNTIME_PROXY_PATH_PREFIX}/:logicalSandboxId`,
    `${VERCEL_RUNTIME_PROXY_PATH_PREFIX}/:logicalSandboxId/*`,
  ]) {
    app.all(path, context =>
      handleVercelRuntimeCredentialProxy(
        context.req.raw,
        context.env,
        context.req.param('logicalSandboxId') ?? ''
      )
    );
  }
}
