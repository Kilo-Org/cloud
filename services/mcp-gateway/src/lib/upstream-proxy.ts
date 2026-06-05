import { buildUpstreamHeaders, createGatewayError, GatewayErrorCode } from '@kilocode/mcp-gateway';
import type { MCPGatewayEnv } from '../types';
import { validateRedirectTarget } from './url-policy';

const hopByHopResponseHeaders = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const unsafeResponseHeaders = new Set(['set-cookie', 'set-cookie2']);

function validatedQuery(searchParams: URLSearchParams): URLSearchParams {
  const result = new URLSearchParams();
  for (const [name, value] of searchParams.entries()) {
    if (!name || name.length > 200 || value.length > 4_096) {
      throw createGatewayError(GatewayErrorCode.InvalidRequest, 'Invalid query parameter', 400);
    }
    result.append(name, value);
  }
  return result;
}

function validateDescendantPath(descendantPath: string | null): string | null {
  if (!descendantPath) return null;
  for (const rawSegment of descendantPath.split('/')) {
    if (rawSegment.length === 0) continue;
    let decoded: string;
    try {
      decoded = decodeURIComponent(rawSegment);
    } catch {
      throw createGatewayError(GatewayErrorCode.InvalidRequest, 'Invalid descendant path', 400);
    }
    if (decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\')) {
      throw createGatewayError(GatewayErrorCode.InvalidRequest, 'Invalid descendant path', 400);
    }
  }
  return descendantPath;
}

function combinePath(remotePath: string, descendantPath: string | null): string {
  if (!descendantPath) return remotePath;
  const base = remotePath.endsWith('/') ? remotePath.slice(0, -1) : remotePath;
  return `${base}${descendantPath}`;
}

function sanitizedResponseHeaders(headers: Headers): Headers {
  const result = new Headers(headers);
  for (const name of [...hopByHopResponseHeaders, ...unsafeResponseHeaders]) {
    result.delete(name);
  }
  return result;
}

export async function proxyUpstream(params: {
  env: MCPGatewayEnv['Bindings'];
  request: Request;
  remoteUrl: string;
  descendantPath: string | null;
  pathPassthrough: boolean;
  staticHeaders?: Record<string, string>;
  auxiliaryHeaders?: Record<string, string>;
  providerAuthorization?: string;
  fetchImpl?: typeof fetch;
}) {
  const fetchImpl = params.fetchImpl ?? fetch;
  if (params.descendantPath && !params.pathPassthrough) {
    throw createGatewayError(GatewayErrorCode.Forbidden, 'Path passthrough is disabled', 403);
  }
  const remote = await validateRedirectTarget(params.remoteUrl, fetchImpl);
  const descendantPath = validateDescendantPath(params.descendantPath);
  const upstream = new URL(remote.toString());
  upstream.pathname = combinePath(remote.pathname, descendantPath);
  upstream.search = validatedQuery(new URL(params.request.url).searchParams).toString();

  const staticHeaderEntries = params.staticHeaders
    ? Object.entries(params.staticHeaders)
    : undefined;
  const auxiliaryHeaderEntries = params.auxiliaryHeaders
    ? Object.entries(params.auxiliaryHeaders)
    : undefined;
  const headers = buildUpstreamHeaders({
    source: params.request.headers,
    auxiliaryHeaders: auxiliaryHeaderEntries,
    staticCredentialHeaders: staticHeaderEntries,
    providerAuthorization: params.providerAuthorization,
  });
  const init: RequestInit = {
    method: params.request.method,
    headers,
    body:
      params.request.method === 'GET' || params.request.method === 'HEAD'
        ? undefined
        : params.request.body,
    redirect: 'manual',
  };
  const response = await fetchImpl(upstream.toString(), init);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: sanitizedResponseHeaders(response.headers),
  });
}
