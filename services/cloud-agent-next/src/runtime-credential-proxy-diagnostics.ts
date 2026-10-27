import { logger } from './logger.js';

/** Stable searchable tag for one failed runtime credential proxy request. */
export const RUNTIME_PROXY_REQUEST_FAILED_LOG_TAG = 'runtime_proxy_request_failed';

/**
 * Closed set of local authorization checks that can reject a runtime credential
 * proxy request before it reaches the upstream gateway. Retained evidence names
 * one bounded stage so a local rejection is distinguishable from an upstream
 * status.
 */
export const RUNTIME_PROXY_REJECTION_STAGES = [
  'handle',
  'context',
  'fence',
  'authorization',
  'grant',
  'token',
  'resolve',
] as const;
export type RuntimeProxyRejectionStage = (typeof RUNTIME_PROXY_REJECTION_STAGES)[number];

/**
 * Opaque correlation IDs already in scope at the proxy decision point. Never a
 * token, credential, URL, hostname, path, user identifier or response body.
 */
export type RuntimeProxyCorrelation = {
  sessionId?: string | null;
  kiloSessionId?: string | null;
  allocationId?: string | null;
  wrapperInstanceId?: string | null;
  connectionId?: string | null;
};

/**
 * Bounded fingerprint of a failed upstream response. It tells which layer
 * produced the status (Vercel firewall, Vercel platform, Cloudflare, or the
 * application) without retaining credentials or response payloads.
 */
export type UpstreamFailureEvidence = {
  upstreamServer?: string;
  upstreamContentType?: string;
  upstreamVercelId?: string;
  upstreamVercelMitigated?: string;
  upstreamVercelError?: string;
  upstreamCfRay?: string;
  upstreamErrorExcerpt?: string;
};

type RuntimeProxyRequestFailure =
  | { upstreamAttempted: false; rejectionStage: RuntimeProxyRejectionStage }
  | { upstreamAttempted: true; upstreamStatus: number; evidence?: UpstreamFailureEvidence };

const EVIDENCE_HEADERS = [
  ['upstreamServer', 'server'],
  ['upstreamContentType', 'content-type'],
  ['upstreamVercelId', 'x-vercel-id'],
  ['upstreamVercelMitigated', 'x-vercel-mitigated'],
  ['upstreamVercelError', 'x-vercel-error'],
  ['upstreamCfRay', 'cf-ray'],
] as const satisfies ReadonlyArray<readonly [keyof UpstreamFailureEvidence, string]>;

const MAX_HEADER_LENGTH = 128;
const MAX_EXCERPT_LENGTH = 160;
const MAX_BODY_BYTES = 2048;
const BODY_READ_TIMEOUT_MS = 500;

function boundedText(value: string, maximumLength: number): string | undefined {
  const collapsed = value
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return collapsed ? collapsed.slice(0, maximumLength) : undefined;
}

function redactCredentials(value: string): string {
  return value
    .replace(/bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]*/g, '[redacted]')
    .replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]');
}

async function readBodyPrefix(response: Response): Promise<string | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>(resolve => {
    timer = setTimeout(() => resolve(null), BODY_READ_TIMEOUT_MS);
  });
  const read = async (): Promise<string> => {
    while (size < MAX_BODY_BYTES) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const bytes = new Uint8Array(chunk.value);
      size += bytes.byteLength;
      text += decoder.decode(bytes, { stream: true });
    }
    return text + decoder.decode();
  };
  try {
    return await Promise.race([read(), timeout]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    reader.cancel().catch(() => {});
  }
}

function errorExcerpt(body: string, contentType: string | null): string | undefined {
  if (contentType?.includes('json')) {
    try {
      const parsed: unknown = JSON.parse(body);
      if (typeof parsed === 'object' && parsed !== null) {
        const record = parsed as Record<string, unknown>;
        const nested =
          typeof record.error === 'object' && record.error !== null
            ? (record.error as Record<string, unknown>).message
            : undefined;
        const message = [record.error, nested, record.message].find(
          (value): value is string => typeof value === 'string'
        );
        if (message) return boundedText(redactCredentials(message), MAX_EXCERPT_LENGTH);
      }
    } catch {
      // A truncated or invalid JSON body falls back to the text excerpt.
    }
  }
  if (contentType?.includes('html')) {
    const title = /<title[^>]*>([^<]*)<\/title>/i.exec(body)?.[1];
    return title ? boundedText(redactCredentials(title), MAX_EXCERPT_LENGTH) : undefined;
  }
  return boundedText(redactCredentials(body), MAX_EXCERPT_LENGTH);
}

/**
 * Reads bounded evidence from a failed upstream response. The body excerpt is
 * read from a clone, only for authentication and authorization statuses, so
 * the caller can still return the original response unchanged.
 */
export async function readUpstreamFailureEvidence(
  response: Response
): Promise<UpstreamFailureEvidence> {
  const evidence: UpstreamFailureEvidence = {};
  for (const [field, header] of EVIDENCE_HEADERS) {
    const value = response.headers.get(header);
    const bounded = value ? boundedText(value, MAX_HEADER_LENGTH) : undefined;
    if (bounded) evidence[field] = bounded;
  }
  if (response.status === 401 || response.status === 403) {
    const body = await readBodyPrefix(response.clone());
    const excerpt = body ? errorExcerpt(body, response.headers.get('content-type')) : undefined;
    if (excerpt) evidence.upstreamErrorExcerpt = excerpt;
  }
  return evidence;
}

/**
 * Emits exactly one bounded diagnostic for a failed runtime credential proxy
 * request: a named local rejection stage, or the upstream HTTP status when the
 * request reached the gateway. Successful requests must not call this.
 */
export function logRuntimeProxyRequestFailed(
  input: RuntimeProxyCorrelation & RuntimeProxyRequestFailure
): void {
  logger
    .withFields({
      logTag: RUNTIME_PROXY_REQUEST_FAILED_LOG_TAG,
      upstreamAttempted: input.upstreamAttempted,
      ...(input.upstreamAttempted
        ? { upstreamStatus: input.upstreamStatus, ...input.evidence }
        : { rejectionStage: input.rejectionStage }),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.kiloSessionId ? { kiloSessionId: input.kiloSessionId } : {}),
      ...(input.allocationId ? { allocationId: input.allocationId } : {}),
      ...(input.wrapperInstanceId ? { wrapperInstanceId: input.wrapperInstanceId } : {}),
      ...(input.connectionId ? { connectionId: input.connectionId } : {}),
    })
    .warn('Runtime credential proxy request failed');
}
