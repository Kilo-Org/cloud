import type { EnrichedCapturedRequest } from './webhook-agent-client';

/** One captured request header, reduced to its name and a mask of its value. */
export type ProjectedRequestHeader = {
  name: string;
  valueMask: string;
};

/**
 * Admin-scope view of a captured webhook request.
 *
 * Raw header values, the body and request metadata the admin view does not show
 * stay on the server and never reach the admin client.
 */
export type AdminWebhookRequestSummary = Omit<
  EnrichedCapturedRequest,
  'headers' | 'body' | 'queryString' | 'contentType' | 'sourceIp'
> & {
  headers: ProjectedRequestHeader[];
  bodyByteLength: number;
};

const MAX_MASK_LENGTH = 8;

/**
 * Mask a header value so the admin view shows that the header was captured
 * without disclosing its value.
 */
export function maskHeaderValue(value: string): string {
  if (!value) return '';
  if (value.length <= 4) return '****';
  return '*'.repeat(Math.min(value.length, MAX_MASK_LENGTH));
}

/**
 * Project a captured request into the admin-scope response. The returned object
 * lists every permitted field explicitly, so a new captured-request field stays
 * on the server until it is added here.
 */
export function summarizeRequestForAdmin(
  request: EnrichedCapturedRequest
): AdminWebhookRequestSummary {
  return {
    id: request.id,
    timestamp: request.timestamp,
    method: request.method,
    path: request.path,
    startedAt: request.startedAt,
    completedAt: request.completedAt,
    processStatus: request.processStatus,
    cloudAgentSessionId: request.cloudAgentSessionId,
    kiloSessionId: request.kiloSessionId,
    errorMessage: request.errorMessage,
    triggerSource: request.triggerSource,
    headers: Object.entries(request.headers).map(([name, value]) => ({
      name,
      valueMask: maskHeaderValue(value),
    })),
    bodyByteLength: new TextEncoder().encode(request.body).byteLength,
  };
}
