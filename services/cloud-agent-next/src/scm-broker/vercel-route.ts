import type { Hono } from 'hono';
import { logger } from '../logger.js';
import type { HonoContext } from '../hono-context.js';
import type { Env } from '../types.js';
import { isSafeSandboxId } from '../shared/control-plane-credential.js';
import { admitVercelScmForwardAtLocator } from './vercel-admission.js';
import { forwardResolvedScmCapability } from './managed-forwarding.js';
import { forwardUnmanagedScmRequest } from './unmanaged-forwarding.js';

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

function upstreamRequest(request: Request, target: URL): Request {
  const headers = new Headers(request.headers);
  const connectionHeaders = (headers.get('connection') ?? '').split(',').map(value => value.trim());
  for (const name of [...headers.keys()]) {
    if (
      name.startsWith('vercel-') ||
      name.startsWith('x-vercel-') ||
      name.startsWith('x-forwarded-') ||
      [
        'forwarded',
        'connection',
        'keep-alive',
        'proxy-authorization',
        'proxy-authenticate',
        'te',
        'trailer',
        'transfer-encoding',
        'upgrade',
      ].includes(name) ||
      connectionHeaders.some(header => header.toLowerCase() === name)
    )
      headers.delete(name);
  }
  headers.set('Host', target.host);
  return new Request(target, new Request(request, { headers, redirect: 'manual' }));
}

export async function handleVercelScmForward(
  request: Request,
  env: Env,
  sandboxId: string,
  admit = admitVercelScmForwardAtLocator
): Promise<Response> {
  const target = originalTarget(request.headers);
  const oidcToken = request.headers.get('vercel-sandbox-oidc-token');
  if (!target || !oidcToken || !isSafeSandboxId(sandboxId))
    return Response.json({ code: 'invalid_request' }, { status: 401 });
  try {
    const admission = await admit(env, sandboxId, {
      oidcToken,
      target: { url: target.href, method: request.method },
      authorization: {
        ...(request.headers.has('authorization')
          ? { authorization: request.headers.get('authorization') ?? '' }
          : {}),
        ...(request.headers.has('private-token')
          ? { privateToken: request.headers.get('private-token') ?? '' }
          : {}),
      },
    });
    if (!admission.ok) {
      logger
        .withFields({ sandboxId, code: admission.code, status: admission.status })
        .warn('Vercel SCM forwarding admission rejected');
      return Response.json(
        { code: admission.code },
        {
          status: admission.status,
          ...(admission.retryAfter
            ? { headers: { 'Retry-After': String(admission.retryAfter) } }
            : {}),
        }
      );
    }
    const upstream = upstreamRequest(request, target);
    if (admission.authority.type === 'unmanaged') return await forwardUnmanagedScmRequest(upstream);
    return await forwardResolvedScmCapability(
      upstream,
      env.GIT_TOKEN_SERVICE,
      { provider: admission.authority.provider, capability: admission.authority.capability },
      admission.authority.outboundContainerId,
      sandboxId
    );
  } catch {
    return Response.json({ code: 'forwarding_unavailable' }, { status: 503 });
  }
}

export function registerVercelScmBrokerRoute(app: Hono<HonoContext>): void {
  for (const path of ['/scm/vercel/:sandboxId', '/scm/vercel/:sandboxId/*']) {
    app.all(path, context =>
      handleVercelScmForward(context.req.raw, context.env, context.req.param('sandboxId') ?? '')
    );
  }
}
