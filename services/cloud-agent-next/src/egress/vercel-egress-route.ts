import type { Hono } from 'hono';
import type { HonoContext } from '../hono-context.js';
import { logger } from '../logger.js';
import { classifyScmAuthorization } from '../scm-broker/authorization.js';
import { admitVercelScmForwardAtLocator } from '../scm-broker/vercel-admission.js';
import {
  forwardAdmissionDenied,
  forwardAdmittedScm,
  handleVercelScmForward,
  originalTarget,
  scmAuthorization,
  upstreamRequest,
} from '../scm-broker/vercel-route.js';
import { isSafeSandboxId } from '../shared/control-plane-credential.js';
import type { Env } from '../types.js';
import {
  admitSandboxEgressAtLocator,
  createEgressAdmissionCache,
  type SandboxEgressAdmissionPolicy,
} from './egress-admission.js';
import { egressAuditStore, proxySandboxEgress } from './sandbox-egress.js';

export type VercelEgressRouteDependencies = {
  admitEgress: ReturnType<typeof createEgressAdmissionCache>;
  admitScm: typeof admitVercelScmForwardAtLocator;
};

const defaultDependencies: VercelEgressRouteDependencies = {
  admitEgress: createEgressAdmissionCache(),
  admitScm: admitVercelScmForwardAtLocator,
};

function invalidRequest(): Response {
  return Response.json({ code: 'invalid_request' }, { status: 401 });
}

/**
 * Any target that the forwarded headers name, also one that Vercel never
 * forwards (`http`, userinfo, an IPv6 literal). It is used only to audit and
 * refuse that target.
 */
function namedTarget(headers: Headers): URL | null {
  const scheme = headers.get('vercel-forwarded-scheme');
  const host = headers.get('vercel-forwarded-host');
  const port = headers.get('vercel-forwarded-port');
  if (
    (scheme !== 'https' && scheme !== 'http') ||
    !host ||
    host.length > 1024 ||
    /[/\\?#\s]/.test(host) ||
    !port ||
    !/^[1-9]\d{0,4}$/.test(port)
  )
    return null;
  try {
    const url = new URL(`${scheme}://${host}:${port}/`);
    url.username = '';
    url.password = '';
    return url;
  } catch {
    return null;
  }
}

/** A WebSocket upgrade keeps its upgrade headers; every other request loses them. */
function keepWebSocketUpgrade(original: Request, upstream: Request): Request {
  if (original.headers.get('upgrade')?.toLowerCase() !== 'websocket') return upstream;
  const headers = new Headers(upstream.headers);
  headers.set('Upgrade', 'websocket');
  headers.set('Connection', 'Upgrade');
  return new Request(upstream, { headers });
}

async function forwardRestricted(
  request: Request,
  env: Env,
  sandboxId: string,
  oidcToken: string,
  policy: SandboxEgressAdmissionPolicy,
  admitScm: VercelEgressRouteDependencies['admitScm']
): Promise<Response> {
  const exact = originalTarget(request.headers);
  const named = exact ?? namedTarget(request.headers);
  if (!named) return invalidRequest();
  const upstream = exact
    ? keepWebSocketUpgrade(request, upstreamRequest(request, exact))
    : new Request(named, { method: request.method });
  return proxySandboxEgress(
    upstream,
    env,
    {
      // Vercel forwards only HTTPS to listed hosts. Any other target is a forged header: nothing is allowed for it.
      allowlist: exact ? policy.allowlist : [],
      ...(policy.audit === undefined
        ? {}
        : {
            audit: {
              allocationRef: policy.audit.allocationRef,
              store: () => egressAuditStore(env, { logicalSandboxId: sandboxId }),
            },
          }),
    },
    async allowed => {
      const authorization = scmAuthorization(allowed.headers);
      if (classifyScmAuthorization(authorization).type === 'unmanaged') return fetch(allowed);
      const admission = await admitScm(env, sandboxId, {
        oidcToken,
        target: { url: allowed.url, method: allowed.method },
        authorization,
      });
      if (!admission.ok)
        return forwardAdmissionDenied(
          sandboxId,
          admission,
          'Vercel SCM forwarding admission rejected'
        );
      return forwardAdmittedScm(allowed, env, admission.authority);
    }
  );
}

/**
 * The egress route of a Vercel sandbox. Without an egress allowlist it is the
 * managed SCM forward of today. With one, it runs the shared egress proxy core.
 */
export async function handleVercelEgressForward(
  request: Request,
  env: Env,
  sandboxId: string,
  deps: VercelEgressRouteDependencies = defaultDependencies
): Promise<Response> {
  const oidcToken = request.headers.get('vercel-sandbox-oidc-token');
  if (!oidcToken || !isSafeSandboxId(sandboxId)) return invalidRequest();
  try {
    const admission = await deps.admitEgress(sandboxId, oidcToken, () =>
      admitSandboxEgressAtLocator(env, sandboxId, { oidcToken })
    );
    if (!admission.ok)
      return forwardAdmissionDenied(sandboxId, admission, 'Sandbox egress admission rejected');
    if (admission.policy === null)
      return await handleVercelScmForward(request, env, sandboxId, deps.admitScm);
    return await forwardRestricted(
      request,
      env,
      sandboxId,
      oidcToken,
      admission.policy,
      deps.admitScm
    );
  } catch (error) {
    // The message only: the request headers hold the token and the target path can hold a secret.
    logger
      .withFields({ sandboxId, error: error instanceof Error ? error.message : String(error) })
      .error('Sandbox egress forwarding failed');
    return Response.json({ code: 'forwarding_unavailable' }, { status: 503 });
  }
}

/** The path stays `/scm/vercel/:sandboxId`: it is the OIDC audience of live sandboxes. */
const VERCEL_EGRESS_ROUTE = '/scm/vercel/:sandboxId';

/**
 * True for a request to the egress route. Vercel appends the target path and
 * query of the sandbox request to the route path, and they can hold a secret.
 */
export function isVercelEgressPath(pathname: string): boolean {
  return pathname.startsWith('/scm/vercel/');
}

/** The request path that a log line may hold: only the route for an egress request. */
export function loggableRequestPath(pathname: string): string {
  return isVercelEgressPath(pathname) ? VERCEL_EGRESS_ROUTE : pathname;
}

export function registerVercelEgressRoute(
  app: Hono<HonoContext>,
  deps: VercelEgressRouteDependencies = defaultDependencies
): void {
  for (const path of [VERCEL_EGRESS_ROUTE, `${VERCEL_EGRESS_ROUTE}/*`]) {
    app.all(path, context =>
      handleVercelEgressForward(
        context.req.raw,
        context.env,
        context.req.param('sandboxId') ?? '',
        deps
      )
    );
  }
}
