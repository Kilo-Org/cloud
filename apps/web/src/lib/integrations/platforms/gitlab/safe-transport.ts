import 'server-only';

import * as http from 'http';
import * as https from 'https';
import {
  normalizeGitLabInstanceUrl,
  resolveGitLabUrlSafely,
  type GitLabResolvedUrl,
} from './instance-url';

const MAX_GITLAB_REDIRECTS = 5;
export const MAX_GITLAB_RESPONSE_BYTES = 10 * 1024 * 1024;
export const GITLAB_REQUEST_TIMEOUT_MS = 30_000;

export class GitLabTransportError extends Error {
  constructor(
    public readonly code: 'unsafe_url' | 'redirect' | 'request_too_large' | 'response_too_large',
    message: string
  ) {
    super(message);
    this.name = 'GitLabTransportError';
  }
}

type GitLabTransportPolicy = {
  instanceUrl: string;
  maxRequestBytes: number;
  rejectRedirects: boolean;
  resourceUrl?: string;
};

export function assertGitLabTransportUrl(url: URL, instanceUrl: string): void {
  const instance = new URL(normalizeGitLabInstanceUrl(instanceUrl));
  const basePath = instance.pathname.replace(/\/+$/, '');
  if (
    url.origin !== instance.origin ||
    url.username ||
    url.password ||
    url.hash ||
    !url.pathname.startsWith(`${basePath}/`) ||
    decodeURIComponent(url.pathname)
      .split(/[\\/]/)
      .some(segment => segment === '..' || segment === '.')
  ) {
    throw new GitLabTransportError(
      'unsafe_url',
      'GitLab request is outside the authorized instance'
    );
  }
}

export function assertGitLabRequestBodySize(
  body: BodyInit | null | undefined,
  maxBytes: number
): void {
  const buffer = bodyInitToBuffer(body);
  if (buffer && buffer.byteLength > maxBytes) {
    throw new GitLabTransportError('request_too_large', 'GitLab request exceeded size limit');
  }
}

// The old adapter keeps its redirect contract. Interactive requests supply an exact instance policy.
export async function fetchGitLab(
  url: string,
  init?: RequestInit,
  policy?: GitLabTransportPolicy,
  redirectCount = 0
): Promise<Response> {
  if (policy) {
    const target = new URL(url);
    assertGitLabTransportUrl(target, policy.instanceUrl);
    if (policy.resourceUrl !== undefined && target.href !== policy.resourceUrl) {
      throw new GitLabTransportError(
        'unsafe_url',
        'GitLab redirect changed the authorized resource'
      );
    }
    assertGitLabRequestBodySize(init?.body, policy.maxRequestBytes);
    if (redirectCount === 0) {
      const timeout = AbortSignal.timeout(GITLAB_REQUEST_TIMEOUT_MS);
      init = {
        ...init,
        signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
      };
    }
  }
  const response = await fetchGitLabOnce(url, init, Boolean(policy));
  if (!isGitLabRedirect(response.status)) return response;

  if (policy?.rejectRedirects) {
    throw new GitLabTransportError('redirect', 'GitLab mutation redirects are not followed');
  }
  const location = response.headers.get('location');
  if (!location) return response;
  if (redirectCount >= MAX_GITLAB_REDIRECTS) {
    throw new Error('GitLab request exceeded redirect limit');
  }

  const redirectUrl = new URL(location, url).toString();
  return fetchGitLab(
    redirectUrl,
    buildRedirectRequestInit(init, response.status, url, redirectUrl),
    policy,
    redirectCount + 1
  );
}

async function fetchGitLabOnce(
  url: string,
  init: RequestInit | undefined,
  bounded: boolean
): Promise<Response> {
  const resolvedUrl = await resolveGitLabUrlSafely(url);
  if (!resolvedUrl.address) {
    const response = await fetch(url, { ...init, redirect: 'manual' });
    return bounded ? readBoundedResponse(response) : response;
  }
  return fetchGitLabBoundToAddress({ ...resolvedUrl, address: resolvedUrl.address }, init, bounded);
}

async function readBoundedResponse(response: Response): Promise<Response> {
  const contentLength = response.headers.get('content-length');
  if (
    contentLength !== null &&
    (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_GITLAB_RESPONSE_BYTES)
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new GitLabTransportError('response_too_large', 'GitLab response exceeded size limit');
  }
  if (!response.body) return response;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_GITLAB_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new GitLabTransportError('response_too_large', 'GitLab response exceeded size limit');
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  return new Response(Buffer.concat(chunks), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function isGitLabRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function buildRedirectRequestInit(
  init: RequestInit | undefined,
  status: number,
  fromUrl: string,
  toUrl: string
): RequestInit | undefined {
  if (!init) return undefined;
  const headers = new Headers(init.headers);
  const from = new URL(fromUrl);
  const to = new URL(toUrl);
  if (from.protocol === 'https:' && to.protocol === 'http:') {
    throw new Error('GitLab request refused HTTPS-to-HTTP redirect');
  }
  if (from.origin !== to.origin) {
    if ((status === 307 || status === 308) && init.body != null) {
      throw new Error('GitLab request refused cross-origin redirect with request body');
    }
    headers.delete('authorization');
    headers.delete('cookie');
  }
  const method = init.method?.toUpperCase() ?? 'GET';
  if (
    ((status === 301 || status === 302) && method === 'POST') ||
    (status === 303 && method !== 'GET' && method !== 'HEAD')
  ) {
    headers.delete('content-length');
    headers.delete('content-type');
    return { ...init, body: undefined, headers, method: 'GET' };
  }
  return { ...init, headers };
}

function fetchGitLabBoundToAddress(
  { url, address, family }: GitLabResolvedUrl & { address: string },
  init: RequestInit | undefined,
  bounded: boolean
): Promise<Response> {
  const request = url.protocol === 'https:' ? https.request : http.request;
  const headers = headersInitToRecord(init?.headers);
  const body = bodyInitToBuffer(init?.body);
  if (body && !hasHeader(headers, 'content-length')) {
    headers['content-length'] = String(Buffer.byteLength(body));
  }
  return new Promise((resolve, reject) => {
    const req = request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: init?.method ?? 'GET',
        headers,
        family,
        lookup: (_hostname, _options, callback) => callback(null, address, family ?? 0),
        ...(url.protocol === 'https:' ? { servername: url.hostname } : {}),
      },
      response => {
        const chunks: Buffer[] = [];
        let responseBytes = 0;
        response.on('data', chunk => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          responseBytes += buffer.byteLength;
          if (responseBytes > MAX_GITLAB_RESPONSE_BYTES) {
            const error = bounded
              ? new GitLabTransportError(
                  'response_too_large',
                  'GitLab response exceeded size limit'
                )
              : new Error('GitLab response exceeded size limit');
            response.destroy(error);
            req.destroy(error);
            reject(error);
            return;
          }
          chunks.push(buffer);
        });
        response.on('error', reject);
        response.on('end', () => {
          try {
            const status = response.statusCode ?? 500;
            const body = responseStatusForbidsBody(status) ? null : Buffer.concat(chunks);
            resolve(
              new Response(body, {
                status,
                statusText: response.statusMessage,
                headers: responseHeadersToHeaders(response.headers),
              })
            );
          } catch (error) {
            reject(error);
          }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(GITLAB_REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error('GitLab request timed out'));
    });
    const signal = init?.signal;
    if (signal) {
      if (signal.aborted) {
        req.destroy(signal.reason);
        reject(signal.reason);
        return;
      }
      signal.addEventListener(
        'abort',
        () => {
          req.destroy(signal.reason);
          reject(signal.reason);
        },
        { once: true }
      );
    }
    if (body) req.write(body);
    req.end();
  });
}

function headersInitToRecord(headers: HeadersInit | undefined): Record<string, string> {
  const record: Record<string, string> = {};
  new Headers(headers).forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

function hasHeader(headers: Record<string, string>, header: string): boolean {
  const lowerHeader = header.toLowerCase();
  return Object.keys(headers).some(key => key.toLowerCase() === lowerHeader);
}

function bodyInitToBuffer(body: BodyInit | null | undefined): Buffer | undefined {
  if (body == null) return undefined;
  if (typeof body === 'string') return Buffer.from(body);
  if (body instanceof URLSearchParams) return Buffer.from(body.toString());
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }
  throw new Error('Unsupported GitLab request body type');
}

function responseStatusForbidsBody(status: number): boolean {
  return status === 204 || status === 205 || status === 304;
}

function responseHeadersToHeaders(headers: http.IncomingHttpHeaders): Headers {
  const responseHeaders = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) responseHeaders.append(key, item);
    } else if (value !== undefined) {
      responseHeaders.set(key, value);
    }
  }
  return responseHeaders;
}
