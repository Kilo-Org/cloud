import { hasDuplicateQueryParameters } from '../shared/http-query.js';
import { publicCloudAgentDirectory } from './public-sdk-projection.js';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function facadeError(status: number, code: string, message: string): Response {
  return Response.json({ error: code, message }, { status });
}

export function unsupportedRouteResponse(): Response {
  return facadeError(501, 'KILO_ROUTE_UNSUPPORTED', 'Kilo facade route is not supported');
}

export function missingRootKiloSessionResponse(): Response {
  return facadeError(404, 'KILO_SESSION_NOT_FOUND', 'Cloud Agent root Kilo session was not found');
}

export function pendingSessionSnapshotResponse(): Response {
  const response = facadeError(
    503,
    'KILO_SESSION_SNAPSHOT_PENDING',
    'Cloud Agent Kilo session snapshot is not available yet'
  );
  response.headers.set('Retry-After', '1');
  return response;
}

export function retryableSessionReadResponse(): Response {
  const response = facadeError(
    503,
    'KILO_SESSION_READ_RETRYABLE',
    'Persisted Kilo session data is temporarily unavailable; retry the request'
  );
  response.headers.set('Retry-After', '1');
  return response;
}

export function invalidPersistedSessionDataResponse(entity: 'session' | 'messages'): Response {
  return facadeError(502, 'KILO_UPSTREAM_RESPONSE_INVALID', `Kilo ${entity} response is not valid`);
}

export function liveRuntimeUnavailableResponse(): Response {
  const response = facadeError(
    503,
    'KILO_LIVE_RUNTIME_UNAVAILABLE',
    'Live Kilo runtime is not available for this session'
  );
  response.headers.set('Retry-After', '1');
  return response;
}

export function invalidUpstreamResponse(message = 'Kilo upstream response is not valid'): Response {
  return facadeError(502, 'KILO_UPSTREAM_RESPONSE_INVALID', message);
}

export function invalidInteractionRequestBodyResponse(): Response {
  return facadeError(
    400,
    'KILO_INTERACTION_BODY_INVALID',
    'Kilo interaction request body is not valid'
  );
}

export function missingInteractionRequestResponse(): Response {
  return facadeError(
    404,
    'KILO_INTERACTION_REQUEST_NOT_FOUND',
    'Kilo interaction request was not found'
  );
}

export function duplicateQueryParametersResponse(): Response {
  return facadeError(400, 'KILO_QUERY_INVALID', 'Query parameters must be unique');
}

export function unsupportedSessionSelectorResponse(): Response {
  return facadeError(
    400,
    'KILO_SESSION_SELECTOR_UNSUPPORTED',
    'Only the matching public Cloud Agent session directory selector is supported'
  );
}

export function kiloRelativePath(pathname: string): string {
  if (pathname === '/kilo') return '/';
  return pathname.startsWith('/kilo/') ? pathname.slice('/kilo'.length) : pathname;
}

export function parseRootSessionRoute(kiloPath: string): {
  encodedKiloSessionId: string;
  kiloSessionId: string;
} | null {
  const match = /^\/session\/([^/]+)(?:\/.*)?$/.exec(kiloPath);
  if (!match?.[1]) return null;
  try {
    return { encodedKiloSessionId: match[1], kiloSessionId: decodeURIComponent(match[1]) };
  } catch {
    return null;
  }
}

export function parsePublicSessionDirectory(directory: string): string | null {
  const match = /^\/cloud-agent\/sessions\/([^/]+)$/.exec(directory);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

export function isSessionIngestKiloSessionId(kiloSessionId: string): boolean {
  return kiloSessionId.startsWith('ses_') && kiloSessionId.length === 30;
}

export function validateIdScopedSelectors(
  url: URL,
  kiloSessionId: string,
  paginationKeys: Set<string>
): Response | null {
  for (const key of url.searchParams.keys()) {
    if (paginationKeys.has(key)) continue;
    if (key !== 'directory') return unsupportedSessionSelectorResponse();
  }
  if (hasDuplicateQueryParameters(url.searchParams)) {
    return duplicateQueryParametersResponse();
  }
  const directory = url.searchParams.get('directory');
  if (directory !== null && directory !== publicCloudAgentDirectory(kiloSessionId)) {
    return unsupportedSessionSelectorResponse();
  }
  return null;
}

export async function readBoundedBody(
  response: Response,
  maximumBytes: number
): Promise<Uint8Array | null> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    const value: unknown = chunk.value;
    if (!(value instanceof Uint8Array) || byteLength + value.byteLength > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
    byteLength += value.byteLength;
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
