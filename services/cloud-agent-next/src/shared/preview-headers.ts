import { isPreviewLoopbackHostname } from './preview-loopback.js';

export type PreviewHeader = { name: string; value: string };

export const PREVIEW_COOKIE_NAME = 'kilo_preview';
export const PREVIEW_HOST_COOKIE_NAME = '__Host-kilo_preview';
export const PREVIEW_MARKER_PREFIX = 'x-kilo-preview-';
export const PREVIEW_MARKER_PORT_HEADER = `${PREVIEW_MARKER_PREFIX}port`;
export const PREVIEW_MARKER_ALLOCATION_HEADER = `${PREVIEW_MARKER_PREFIX}allocation`;

export function previewCookieName(secure: boolean): string {
  return secure ? PREVIEW_HOST_COOKIE_NAME : PREVIEW_COOKIE_NAME;
}

const PREVIEW_COOKIE_NAMES = new Set([
  PREVIEW_COOKIE_NAME.toLowerCase(),
  PREVIEW_HOST_COOKIE_NAME.toLowerCase(),
]);

export function isPreviewCookieName(name: string): boolean {
  return PREVIEW_COOKIE_NAMES.has(name.trim().toLowerCase());
}

const DROPPED_REQUEST_HEADERS = new Set([
  'authorization',
  'host',
  'connection',
  'content-length',
  'keep-alive',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'referer',
  'forwarded',
  'true-client-ip',
  'x-real-ip',
  'cdn-loop',
  'accept-encoding',
]);

const DROPPED_REQUEST_HEADER_PREFIXES = [
  'proxy-',
  'sec-websocket-',
  'x-kilo-facade-',
  'x-forwarded-',
  'cf-',
  PREVIEW_MARKER_PREFIX,
];

const WEBSOCKET_REQUEST_HEADERS = new Set(['upgrade', 'connection']);

const DROPPED_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'clear-site-data',
]);

function isDroppedRequestHeader(name: string): boolean {
  return (
    DROPPED_REQUEST_HEADERS.has(name) ||
    DROPPED_REQUEST_HEADER_PREFIXES.some(prefix => name.startsWith(prefix))
  );
}

function isWebSocketRequestHeader(name: string): boolean {
  return WEBSOCKET_REQUEST_HEADERS.has(name) || name.startsWith('sec-websocket-');
}

function filteredCookieHeader(values: string[]): string | undefined {
  const kept: string[] = [];
  for (const value of values) {
    for (const part of value.split(';')) {
      const trimmed = part.trim();
      if (trimmed.length === 0) continue;
      if (isPreviewCookieName(trimmed.split('=')[0] ?? '')) continue;
      kept.push(trimmed);
    }
  }
  return kept.length > 0 ? kept.join('; ') : undefined;
}

export function stripPreviewMarkerHeaders(headers: Headers): Headers {
  const stripped = new Headers(headers);
  for (const name of [...stripped.keys()]) {
    if (name.toLowerCase().startsWith(PREVIEW_MARKER_PREFIX)) stripped.delete(name);
  }
  return stripped;
}

/** Drops client-supplied preview markers; returns the same request when there are none. */
export function withoutPreviewMarkers(request: Request): Request {
  for (const name of request.headers.keys()) {
    if (name.toLowerCase().startsWith(PREVIEW_MARKER_PREFIX)) {
      return new Request(request, { headers: stripPreviewMarkerHeaders(request.headers) });
    }
  }
  return request;
}

export function filterPreviewRequestHeaders(
  pairs: readonly PreviewHeader[],
  options: { websocket: boolean }
): PreviewHeader[] {
  const headers: PreviewHeader[] = [];
  const cookies: string[] = [];
  for (const { name, value } of pairs) {
    const lower = name.toLowerCase();
    if (options.websocket && isWebSocketRequestHeader(lower)) {
      headers.push({ name, value });
      continue;
    }
    if (isDroppedRequestHeader(lower)) continue;
    if (lower === 'cookie') {
      cookies.push(value);
      continue;
    }
    headers.push({ name, value });
  }
  const cookie = filteredCookieHeader(cookies);
  if (cookie !== undefined) headers.push({ name: 'Cookie', value: cookie });
  return headers;
}

function cookieName(cookie: string): string {
  return cookie.split(';')[0]?.split('=')[0]?.trim() ?? '';
}

function sanitizeSetCookie(cookie: string, secure: boolean): string | undefined {
  if (isPreviewCookieName(cookieName(cookie))) return undefined;
  const kept = cookie.split(';').filter((part, index) => {
    if (index === 0) return true;
    const attribute = part.split('=')[0]?.trim().toLowerCase();
    if (attribute === 'domain') return false;
    return secure || attribute !== 'secure';
  });
  return kept.join(';');
}

export function sanitizePreviewResponseHeaders(
  pairs: readonly PreviewHeader[],
  options: { secure: boolean }
): PreviewHeader[] {
  const headers: PreviewHeader[] = [];
  for (const { name, value } of pairs) {
    const lower = name.toLowerCase();
    if (DROPPED_RESPONSE_HEADERS.has(lower)) continue;
    if (lower === 'set-cookie') {
      const rewritten = sanitizeSetCookie(value, options.secure);
      if (rewritten !== undefined) headers.push({ name, value: rewritten });
      continue;
    }
    headers.push({ name, value });
  }
  return headers;
}

export function rewritePreviewLocation(value: string, port: number, origin: string): string {
  if (!value.startsWith('//') && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value;
  let url: URL;
  try {
    url = new URL(value, `http://localhost:${port}`);
  } catch {
    return value;
  }
  if (!isPreviewLoopbackHostname(url.hostname) || url.port !== String(port)) return value;
  try {
    return new URL(`${url.pathname}${url.search}${url.hash}`, origin).toString();
  } catch {
    return value;
  }
}
