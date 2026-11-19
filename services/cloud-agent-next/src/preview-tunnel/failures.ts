import {
  PREVIEW_NOT_LISTENING_TEXT,
  PREVIEW_NOT_READY_TEXT,
  PREVIEW_NOT_RUNNING_TEXT,
  PREVIEW_RESERVED_PORT_TEXT,
  PREVIEW_UNAVAILABLE_TEXT,
  PREVIEW_UPSTREAM_TIMEOUT_TEXT,
} from '../preview/container-port-fetch.js';
import type { PreviewTunnelResetCode } from '../shared/preview-tunnel-protocol.js';

export const PREVIEW_OUTDATED_RUNTIME_TEXT =
  'Preview needs a newer sandbox runtime. It works after the sandbox restarts.';
export const PREVIEW_TOO_MANY_STREAMS_TEXT = 'Too many open preview requests';
export const PREVIEW_BAD_RESPONSE_TEXT =
  'The server on that port sent a response that preview cannot pass on';
export const PREVIEW_REQUEST_TOO_LARGE_TEXT = 'Preview request headers are too large';
export const PREVIEW_UNSUPPORTED_REQUEST_TEXT = 'Preview cannot pass on this request';

export type PreviewTunnelFailure =
  | 'not_running'
  | 'not_ready'
  | 'outdated'
  | 'unavailable'
  | 'busy'
  | 'reserved'
  | 'not_listening'
  | 'timeout'
  | 'bad_response'
  | 'request_too_large'
  | 'unsupported_request';

const FAILURES: Record<
  PreviewTunnelFailure,
  { status: number; text: string; retryAfter: boolean }
> = {
  not_running: { status: 503, text: PREVIEW_NOT_RUNNING_TEXT, retryAfter: false },
  not_ready: { status: 503, text: PREVIEW_NOT_READY_TEXT, retryAfter: true },
  outdated: { status: 409, text: PREVIEW_OUTDATED_RUNTIME_TEXT, retryAfter: false },
  unavailable: { status: 503, text: PREVIEW_UNAVAILABLE_TEXT, retryAfter: true },
  busy: { status: 503, text: PREVIEW_TOO_MANY_STREAMS_TEXT, retryAfter: true },
  reserved: { status: 403, text: PREVIEW_RESERVED_PORT_TEXT, retryAfter: false },
  not_listening: { status: 502, text: PREVIEW_NOT_LISTENING_TEXT, retryAfter: false },
  timeout: { status: 504, text: PREVIEW_UPSTREAM_TIMEOUT_TEXT, retryAfter: false },
  bad_response: { status: 502, text: PREVIEW_BAD_RESPONSE_TEXT, retryAfter: false },
  request_too_large: { status: 431, text: PREVIEW_REQUEST_TOO_LARGE_TEXT, retryAfter: false },
  unsupported_request: { status: 400, text: PREVIEW_UNSUPPORTED_REQUEST_TEXT, retryAfter: false },
};

export function previewTunnelFailureResponse(failure: PreviewTunnelFailure): Response {
  const { status, text, retryAfter } = FAILURES[failure];
  const headers = new Headers({ 'Content-Type': 'text/plain; charset=utf-8' });
  if (retryAfter) headers.set('Retry-After', '1');
  return new Response(text, { status, headers });
}

/** The answer for a stream that the wrapper reset before its head. */
export function failureForReset(code: PreviewTunnelResetCode): PreviewTunnelFailure {
  switch (code) {
    case 'reserved':
    case 'not_listening':
    case 'timeout':
    case 'bad_response':
    case 'busy':
      return code;
    case 'cancelled':
    case 'protocol':
      return 'unavailable';
  }
}
