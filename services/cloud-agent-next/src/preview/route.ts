import { getSandbox } from '@cloudflare/sandbox';
import {
  PREVIEW_SESSION_LIFETIME_SECONDS,
  mintPreviewSessionToken,
  resolveSecret,
  validatePreviewEntryTicket,
  validatePreviewSessionToken,
  type PreviewClaims,
} from '../auth.js';
import type {
  PreviewProviderCoordinates,
  ResolvedPreviewTarget,
} from '../control-plane/sandbox/preview-target.js';
import { requireCurrentSessionAccess, projectSessionAccessHttpError } from '../session-access.js';
import { getSandboxSessionStub } from '../sandbox-session/session-stub.js';
import {
  PREVIEW_MARKER_ALLOCATION_HEADER,
  PREVIEW_MARKER_PORT_HEADER,
  filterPreviewRequestHeaders,
  previewCookieName,
  rewritePreviewLocation,
  sanitizePreviewResponseHeaders,
  type PreviewHeader,
} from '../shared/preview-headers.js';
import { getSandboxNamespace } from '../sandbox-id.js';
import type { Env } from '../types.js';
import { isPreviewEnabled, matchPreviewHost, previewLabel, type PreviewHostMatch } from './host.js';
import { PREVIEW_NOT_RUNNING_TEXT, PREVIEW_SESSION_MISSING_TEXT } from './container-port-fetch.js';
import { isPreviewReservedPath, previewReturnPath } from './return-path.js';
import { previewUpstreamHost, previewUpstreamUrl } from './upstream.js';

export const PREVIEW_ENTER_PATH = '/.kilo-preview/enter';
/** Worker-host path the web app links to; it redirects to the preview host. */
export const PREVIEW_OPEN_PATH = '/preview/open';

// Bound the per-request header work before the access query and the DO calls.
export const PREVIEW_HEADER_MAX_COUNT = 40;
export const PREVIEW_HEADER_NAME_MAX_LENGTH = 128;
export const PREVIEW_HEADER_VALUE_MAX_LENGTH = 8_192;

export type PreviewSessionStub = {
  resolvePreviewTarget(): Promise<ResolvedPreviewTarget>;
};

export type PreviewRouteDeps = {
  validateAccess: (input: {
    env: Env;
    userId: string;
    cloudAgentSessionId: string;
    expectedOrganizationId: string | null;
  }) => Promise<void>;
  getSessionStub: (env: Env, userId: string, sessionId: string) => PreviewSessionStub;
  fetchUpstream: (
    env: Env,
    coordinates: PreviewProviderCoordinates,
    request: Request
  ) => Promise<Response>;
};

async function defaultFetchUpstream(
  env: Env,
  coordinates: PreviewProviderCoordinates,
  request: Request
): Promise<Response> {
  if (coordinates.provider === 'cloudflare') {
    const sandbox = getSandbox(
      getSandboxNamespace(env, coordinates.allocationName, {
        managedScmContainment: coordinates.containment,
      }),
      coordinates.allocationName
    );
    return sandbox.fetch(request);
  }
  const stub = env.SANDBOX_CONTAINERS.getByName(coordinates.logicalSandboxId);
  return stub.fetch(request);
}

const defaultPreviewRouteDeps: PreviewRouteDeps = {
  validateAccess: async ({ env, userId, cloudAgentSessionId, expectedOrganizationId }) => {
    await requireCurrentSessionAccess({
      env,
      kiloUserId: userId,
      cloudAgentSessionId,
      expectedOrganizationId,
    });
  },
  getSessionStub: (env, userId, sessionId) => getSandboxSessionStub(env, userId, sessionId),
  fetchUpstream: defaultFetchUpstream,
};

function fixed(status: number, message: string, retryAfter = false): Response {
  const headers = new Headers({ 'Content-Type': 'text/plain; charset=utf-8' });
  if (retryAfter) headers.set('Retry-After', '1');
  return new Response(message, { status, headers });
}

function entryResponse(status: number, message: string, retryAfter = false): Response {
  const response = fixed(status, message, retryAfter);
  response.headers.set('Referrer-Policy', 'no-referrer');
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

function accessErrorResponse(error: unknown): Response {
  const projected = projectSessionAccessHttpError(error);
  return projected.status === 403
    ? fixed(403, 'Session access denied')
    : fixed(503, 'Session access is temporarily unavailable');
}

function readPreviewCookie(header: string | null, secure: boolean): string | null {
  if (!header) return null;
  const name = previewCookieName(secure);
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    if (value.length > 0) return value;
  }
  return null;
}

function headersWithinCaps(headers: readonly PreviewHeader[]): boolean {
  let count = 0;
  for (const { name, value } of headers) {
    count += 1;
    if (count > PREVIEW_HEADER_MAX_COUNT) return false;
    if (name.length > PREVIEW_HEADER_NAME_MAX_LENGTH) return false;
    if (value.length > PREVIEW_HEADER_VALUE_MAX_LENGTH) return false;
  }
  return true;
}

/**
 * The Worker derives the label from the verified claims alone; it must name the
 * request host. A match also proves the port and that the session is `workspace_`.
 */
function claimsMatchHost(claims: PreviewClaims, match: PreviewHostMatch): boolean {
  return previewLabel(claims.cloudAgentSessionId, claims.port) === match.label;
}

/**
 * `GET /preview/open?ticket=[&path=]` on the Worker host. The Worker owns the
 * suffix and the label, so the web app never builds a preview hostname. This hop
 * only verifies the ticket and passes `path` on; the entry on the preview host
 * runs the access check and validates `path` where it redirects.
 */
export async function handlePreviewOpen(request: Request, env: Env): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    return entryResponse(405, 'Method not allowed');
  }
  const suffix = env.PREVIEW_HOST_SUFFIX;
  if (!isPreviewEnabled(suffix)) {
    return entryResponse(404, 'Preview is not configured');
  }
  const url = new URL(request.url);
  const ticket = url.searchParams.get('ticket');
  const validated = validatePreviewEntryTicket(ticket, await resolveSecret(env.NEXTAUTH_SECRET));
  const label = validated.success
    ? previewLabel(validated.claims.cloudAgentSessionId, validated.claims.port)
    : null;
  if (ticket === null || label === null) {
    return entryResponse(401, 'Preview ticket is missing or invalid');
  }
  const entry = new URL(PREVIEW_ENTER_PATH, url);
  entry.hostname = `${label}.${suffix}`;
  const params = new URLSearchParams({ ticket });
  const path = url.searchParams.get('path');
  if (path !== null) params.set('path', path);
  entry.search = params.toString();
  return new Response(null, {
    status: 303,
    headers: {
      Location: entry.toString(),
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
    },
  });
}

async function handleEntry(
  request: Request,
  env: Env,
  match: PreviewHostMatch,
  deps: PreviewRouteDeps
): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    return entryResponse(405, 'Method not allowed');
  }
  const url = new URL(request.url);
  const secret = await resolveSecret(env.NEXTAUTH_SECRET);
  const ticket = validatePreviewEntryTicket(url.searchParams.get('ticket'), secret);
  if (!ticket.success || secret === null || !claimsMatchHost(ticket.claims, match)) {
    return entryResponse(401, 'Preview ticket is missing or invalid');
  }
  const claims = ticket.claims;
  try {
    await deps.validateAccess({
      env,
      userId: claims.userId,
      cloudAgentSessionId: claims.cloudAgentSessionId,
      expectedOrganizationId: claims.organizationId ?? null,
    });
  } catch (error) {
    const projected = accessErrorResponse(error);
    return entryResponse(projected.status, await projected.text());
  }

  const sessionToken = mintPreviewSessionToken(claims, secret);
  const cookie = [
    `${previewCookieName(url.protocol === 'https:')}=${sessionToken}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${PREVIEW_SESSION_LIFETIME_SECONDS}`,
  ];
  if (url.protocol === 'https:') cookie.push('Secure');
  return new Response(null, {
    status: 303,
    headers: {
      Location: previewReturnPath(url.searchParams.get('path')),
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
      'Set-Cookie': cookie.join('; '),
    },
  });
}

function upstreamRequest(
  request: Request,
  port: number,
  forwarded: readonly PreviewHeader[],
  coordinates: PreviewProviderCoordinates
): Request {
  const url = new URL(request.url);
  const headers = new Headers();
  for (const { name, value } of forwarded) {
    headers.append(name, value);
  }
  headers.delete('Origin');
  headers.set('Origin', `http://localhost:${port}`);
  headers.set('Host', previewUpstreamHost(port));
  headers.set(PREVIEW_MARKER_PORT_HEADER, String(port));
  if (coordinates.provider === 'cloudflare-containers') {
    headers.set(PREVIEW_MARKER_ALLOCATION_HEADER, coordinates.allocationRef);
  }
  const method = request.method.toUpperCase();
  const init: RequestInit & { duplex?: 'half' } = {
    method: request.method,
    headers,
    redirect: 'manual',
  };
  if (request.body !== null && method !== 'GET' && method !== 'HEAD') {
    init.body = request.body;
    init.duplex = 'half';
  }
  return new Request(previewUpstreamUrl(url.pathname, url.search, port), init);
}

function sanitizedResponse(
  response: Response,
  port: number,
  origin: string,
  secure: boolean
): Response {
  const pairs: PreviewHeader[] = [];
  let sawSetCookie = false;
  for (const [name, value] of response.headers) {
    if (name.toLowerCase() === 'set-cookie') {
      if (sawSetCookie) continue;
      sawSetCookie = true;
      for (const cookie of response.headers.getSetCookie()) pairs.push({ name, value: cookie });
      continue;
    }
    pairs.push({ name, value });
  }
  const headers = new Headers();
  for (const { name, value } of sanitizePreviewResponseHeaders(pairs, { secure })) {
    headers.append(
      name,
      name.toLowerCase() === 'location' ? rewritePreviewLocation(value, port, origin) : value
    );
  }
  headers.append('Content-Security-Policy', "frame-ancestors 'none'");
  headers.set('X-Frame-Options', 'DENY');
  if (response.webSocket !== null && response.webSocket !== undefined) {
    return new Response(null, { status: response.status, headers, webSocket: response.webSocket });
  }
  return new Response(response.body, { status: response.status, headers });
}

function unavailableTargetResponse(
  target: Exclude<ResolvedPreviewTarget, { status: 'ok' }>
): Response {
  switch (target.status) {
    case 'ineligible':
      return fixed(409, 'Preview is only available for interactive Cloud Agent sessions');
    case 'unsupported_provider':
      return fixed(409, 'Preview is not available for this sandbox provider');
    case 'not_ready':
      return fixed(503, 'The sandbox is not ready', true);
    case 'not_running':
      return fixed(503, PREVIEW_NOT_RUNNING_TEXT);
  }
}

async function handleProxy(
  request: Request,
  env: Env,
  match: PreviewHostMatch,
  deps: PreviewRouteDeps
): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method === 'TRACE' || method === 'CONNECT') {
    return fixed(405, 'Method not allowed');
  }
  const websocket = request.headers.get('Upgrade')?.toLowerCase() === 'websocket';
  const forwarded = filterPreviewRequestHeaders(
    [...request.headers].map(([name, value]) => ({ name, value })),
    { websocket }
  );
  if (!headersWithinCaps(forwarded)) {
    return fixed(431, 'Preview request headers are too large');
  }
  const url = new URL(request.url);
  if (isPreviewReservedPath(url.pathname)) {
    return fixed(404, 'Not found');
  }

  const origin = request.headers.get('Origin');
  if ((websocket || (method !== 'GET' && method !== 'HEAD')) && origin !== url.origin) {
    return fixed(403, 'Cross-origin preview request rejected');
  }

  const secure = url.protocol === 'https:';
  const secret = await resolveSecret(env.NEXTAUTH_SECRET);
  const session = validatePreviewSessionToken(
    readPreviewCookie(request.headers.get('Cookie'), secure),
    secret
  );
  if (!session.success || !claimsMatchHost(session.claims, match)) {
    return fixed(401, PREVIEW_SESSION_MISSING_TEXT);
  }
  const claims = session.claims;

  try {
    await deps.validateAccess({
      env,
      userId: claims.userId,
      cloudAgentSessionId: claims.cloudAgentSessionId,
      expectedOrganizationId: claims.organizationId ?? null,
    });
  } catch (error) {
    return accessErrorResponse(error);
  }

  let target: ResolvedPreviewTarget;
  try {
    target = await deps
      .getSessionStub(env, claims.userId, claims.cloudAgentSessionId)
      .resolvePreviewTarget();
  } catch {
    return fixed(503, 'Preview is temporarily unavailable', true);
  }
  if (target.status !== 'ok') return unavailableTargetResponse(target);
  // The physical DO refuses reserved ports before it touches the container.
  const coordinates = target.coordinates;

  let response: Response;
  try {
    response = await deps.fetchUpstream(
      env,
      coordinates,
      upstreamRequest(request, claims.port, forwarded, coordinates)
    );
  } catch {
    return fixed(503, 'Preview is temporarily unavailable', true);
  }
  return sanitizedResponse(response, claims.port, url.origin, secure);
}

export async function handlePreviewRequest(
  request: Request,
  env: Env,
  deps: PreviewRouteDeps = defaultPreviewRouteDeps
): Promise<Response> {
  const url = new URL(request.url);
  const match = matchPreviewHost(url.hostname, env.PREVIEW_HOST_SUFFIX);
  if (match === null) return fixed(404, 'Not found');
  if (url.pathname === PREVIEW_ENTER_PATH) {
    return handleEntry(request, env, match, deps);
  }
  return handleProxy(request, env, match, deps);
}
