import { API_BASE_URL } from '@/lib/config';
import { LocalAccessDeniedError } from '@/lib/local-access';
import {
  type AcceptedWorkReceipt,
  assertTransportOwner,
  dispatchAcceptedWork,
  type MobileActionAdmission,
} from '@/lib/local-access-transport';

/**
 * The single Kilo gateway entry point for the quick-chat surface. Every call
 * to the gateway for this chat lives here so the request shape (feature
 * header, no tools, stream-only) is one place to review.
 */

export type QuickChatGatewayMessage = {
  role: 'user' | 'assistant';
  content: string;
};

export type QuickChatCompletionInput = {
  model: string;
  messages: QuickChatGatewayMessage[];
  organizationId: string | null | undefined;
  authToken: string;
  admission: MobileActionAdmission;
  turnId: string;
  onDispatch: (receipt: AcceptedWorkReceipt) => void;
  signal?: AbortSignal;
};

/** Header set for the gateway chat-completions request. */
type QuickChatRequestHeaders = {
  Authorization: string;
  'Content-Type': string;
  'X-KILOCODE-FEATURE': string;
  'X-KiloCode-OrganizationId'?: string;
};

/** One parsed SSE `data:` line: a content delta (or null) plus the done marker. */
export type SseParseResult = {
  content: string | null;
  done: boolean;
};

const GATEWAY_CHAT_COMPLETIONS_PATH = '/api/gateway/chat/completions';
const SSE_DONE_PAYLOAD = '[DONE]';

/**
 * Stream a chat completion from the Kilo gateway. Yields each
 * `choices[0].delta.content` string until the stream sends `[DONE]` or the
 * caller's `signal` aborts. The caller owns the auth token: obtain it with
 * `getAuthTokenForRequest` and pass it in — nothing here mints a token.
 */
export async function* streamQuickChatCompletion({
  model,
  messages,
  organizationId,
  authToken,
  admission,
  turnId,
  onDispatch,
  signal,
}: QuickChatCompletionInput): AsyncGenerator<string> {
  const headers: QuickChatRequestHeaders = {
    Authorization: `Bearer ${authToken}`,
    'Content-Type': 'application/json',
    'X-KILOCODE-FEATURE': 'quick-chat',
  };
  if (organizationId && organizationId !== '') {
    headers['X-KiloCode-OrganizationId'] = organizationId;
  }

  if (admission.lease.organizationId !== (organizationId ?? null)) {
    throw new LocalAccessDeniedError('context');
  }
  const init = {
    method: 'POST',
    headers,
    // No `tools` key: quick-chat is a plain completion, never a tool loop.
    body: JSON.stringify({ model, messages, stream: true }),
    signal,
  };
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException('Aborted', 'AbortError');
  }
  // eslint-disable-next-line typescript-eslint/promise-function-async -- a synchronous native dispatch failure must not issue a receipt
  function dispatch() {
    return fetch(`${API_BASE_URL}${GATEWAY_CHAT_COMPLETIONS_PATH}`, init);
  }
  const dispatched = dispatchAcceptedWork(
    admission,
    { kind: 'quick-chat-turn', workId: turnId },
    dispatch
  );
  onDispatch(dispatched.receipt);
  const response = await dispatched.result;
  assertTransportOwner(admission.owner);
  if (!response.ok) {
    throw new Error(`Gateway request failed with status ${response.status}`);
  }
  if (!response.body) {
    throw new Error('Gateway returned an empty stream');
  }

  for await (const delta of readSseContent(response.body, signal)) {
    assertTransportOwner(admission.owner);
    yield delta;
  }
  assertTransportOwner(admission.owner);
}

/**
 * Parse one SSE `data:` line. Returns the content delta (or null) and whether
 * the line is the terminal `[DONE]` marker. Non-data lines and malformed JSON
 * are skipped without throwing, so a stray keep-alive comment or an unrelated
 * event never breaks the stream.
 */
export function parseSseDataLine(line: string): SseParseResult {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) {
    return { content: null, done: false };
  }
  const payload = trimmed.slice('data:'.length).trim();
  if (payload === '') {
    return { content: null, done: false };
  }
  if (payload === SSE_DONE_PAYLOAD) {
    return { content: null, done: true };
  }
  try {
    const parsed = JSON.parse(payload) as {
      choices?: { delta?: { content?: unknown } }[];
    };
    const content = parsed.choices?.[0]?.delta?.content;
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- untrusted gateway SSE payload; the delta content must be narrowed at the stream boundary before it enters the transcript
    return { content: typeof content === 'string' ? content : null, done: false };
  } catch {
    return { content: null, done: false };
  }
}

/**
 * Read an SSE response body and yield every content delta until `[DONE]` or
 * an abort. Lines split across chunk boundaries are buffered so a partial
 * `data:` event is still parsed whole.
 */
async function* readSseContent(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    // eslint-disable-next-line no-unmodified-loop-condition -- `signal.aborted` is external state flipped by the caller's AbortController, not a loop-local variable
    while (!signal?.aborted) {
      // eslint-disable-next-line no-await-in-loop -- streaming reads are sequential; each read depends on the previous chunk
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const result = parseSseDataLine(line);
        if (result.done) {
          return;
        }
        if (result.content !== null) {
          yield result.content;
        }
      }
    }
    // Flush the last line when the stream ended without a trailing newline.
    const trailing = buffer + decoder.decode();
    if (trailing.trim() !== '') {
      const result = parseSseDataLine(trailing);
      if (result.content !== null) {
        yield result.content;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
