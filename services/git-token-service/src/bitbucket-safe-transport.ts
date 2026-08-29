export const BITBUCKET_API_ROOT = 'https://api.bitbucket.org/2.0';
export const BITBUCKET_MAX_RESPONSE_BYTES = 1_000_000;
export const BITBUCKET_REQUEST_TIMEOUT_MS = 10_000;
export const BITBUCKET_MAX_REQUEST_TIMEOUT_MS = 30_000;
export const BITBUCKET_INTERACTIVE_REQUEST_MAX_BYTES = 256_000;

export type BitbucketApiErrorCode =
  | 'invalid_request'
  | 'request_failed'
  | 'request_timed_out'
  | 'transport_failed'
  | 'authentication_rejected'
  | 'insufficient_permissions'
  | 'not_found'
  | 'rate_limited'
  | 'provider_unavailable'
  | 'redirect_rejected'
  | 'invalid_response'
  | 'workspace_mismatch'
  | 'invalid_pagination'
  | 'page_limit_exceeded'
  | 'item_limit_exceeded'
  | 'response_too_large';

export class BitbucketApiError extends Error {
  constructor(readonly code: BitbucketApiErrorCode) {
    super(code);
    this.name = 'BitbucketApiError';
  }
}

// Keep the legacy error union closed: the existing credential resolver classifies every member.
export class BitbucketInteractiveError extends Error {
  constructor(readonly code: BitbucketApiErrorCode | 'request_too_large' | 'conflict') {
    super(code);
    this.name = 'BitbucketInteractiveError';
  }
}

export function hasNonVisibleAscii(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x21 || code > 0x7e) return true;
  }
  return false;
}

export function assertBitbucketRequestSize(body: string, maxBytes: number): void {
  if (new TextEncoder().encode(body).byteLength > maxBytes) {
    throw new BitbucketInteractiveError('request_too_large');
  }
}

// Bitbucket Cloud has a fixed origin. Never resolve a client-selected host or follow a redirect.
export function assertBitbucketUrl(value: string, resourcePath: string): URL {
  try {
    const url = new URL(value);
    if (
      !value.startsWith(`${BITBUCKET_API_ROOT}/`) ||
      value.includes('#') ||
      hasNonVisibleAscii(value) ||
      /%(?![\da-f]{2})/i.test(value) ||
      url.href !== value ||
      url.pathname !== resourcePath
    ) {
      throw new Error('unsafe_url');
    }
    return url;
  } catch {
    throw new BitbucketApiError('invalid_request');
  }
}

export type BitbucketTransportOptions = {
  accessToken: string;
  resourcePath: string;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: string;
  accept?: string;
  maxRequestBytes?: number;
};

export async function fetchBitbucket(
  endpoint: string,
  options: BitbucketTransportOptions
): Promise<{ response: Response; signal: AbortSignal }> {
  assertBitbucketUrl(endpoint, options.resourcePath);
  const timeout = options.requestTimeoutMs ?? BITBUCKET_REQUEST_TIMEOUT_MS;
  if (
    !options.accessToken ||
    hasNonVisibleAscii(options.accessToken) ||
    !Number.isInteger(timeout) ||
    timeout <= 0 ||
    timeout > BITBUCKET_MAX_REQUEST_TIMEOUT_MS
  ) {
    throw new BitbucketApiError('invalid_request');
  }
  // Existing endpoints keep their 16,000-byte limit. Only interactive calls opt into the larger envelope.
  if (options.body !== undefined)
    assertBitbucketRequestSize(options.body, options.maxRequestBytes ?? 16_000);
  const signal = AbortSignal.timeout(timeout);
  let response: Response;
  try {
    response = await (options.fetch ?? globalThis.fetch)(endpoint, {
      ...(options.method ? { method: options.method } : {}),
      ...(options.body === undefined ? {} : { body: options.body }),
      headers: {
        Accept: options.accept ?? 'application/json',
        Authorization: `Bearer ${options.accessToken}`,
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      redirect: 'manual',
      signal,
    });
  } catch {
    throw new BitbucketApiError(signal.aborted ? 'request_timed_out' : 'transport_failed');
  }
  if (
    (response.status >= 300 && response.status < 400) ||
    response.redirected ||
    (response.url !== '' && response.url !== endpoint)
  ) {
    void response.body?.cancel().catch(() => undefined);
    throw new BitbucketApiError('redirect_rejected');
  }
  return { response, signal };
}

// Callers retain status and schema policy; this reader also bounds text and SDK stream responses.
export async function readBoundedBitbucketBody(
  response: Response,
  signal: AbortSignal,
  allowEmpty = false
): Promise<Uint8Array<ArrayBuffer>> {
  const contentLength = response.headers.get('Content-Length');
  if (contentLength) {
    if (!/^[0-9]+$/.test(contentLength)) throw new BitbucketApiError('invalid_response');
    if (Number(contentLength) > BITBUCKET_MAX_RESPONSE_BYTES) {
      void response.body?.cancel().catch(() => undefined);
      throw new BitbucketApiError('response_too_large');
    }
  }
  if (!response.body) {
    if (allowEmpty) return new Uint8Array();
    throw new BitbucketApiError('invalid_response');
  }
  const reader = response.body.getReader();
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', abort, { once: true });
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      if (signal.aborted) throw new BitbucketApiError('request_timed_out');
      const chunk = await reader.read();
      if (signal.aborted) throw new BitbucketApiError('request_timed_out');
      if (chunk.done) break;
      const value: unknown = chunk.value;
      if (!(value instanceof Uint8Array)) throw new BitbucketApiError('invalid_response');
      totalBytes += value.byteLength;
      if (totalBytes > BITBUCKET_MAX_RESPONSE_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw new BitbucketApiError('response_too_large');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof BitbucketApiError) throw new BitbucketApiError(error.code);
    throw new BitbucketApiError(signal.aborted ? 'request_timed_out' : 'invalid_response');
  } finally {
    signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
