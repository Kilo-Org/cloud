import { z } from 'zod';
import { getKiloApiBaseUrl } from './auth';
import { createConversationErrorEvent } from './agent-conversation';
import type { ConversationErrorEvent, ErrorRetryKind } from './agent-conversation';
import {
  KiloGatewayHttpError,
  KiloGatewayStreamStalledError,
} from './kilo-gateway-chat-stream-client';

/** What the user is told about an error, and whether repeating the request can work. */
// eslint-disable-next-line typescript-eslint/consistent-type-definitions -- AGENTS.md prefers type over interface in new code.
export type DescribedFetchError = {
  readonly action?: { readonly href: string; readonly label: string };
  readonly detail?: string;
  readonly retryable: boolean;
  readonly title: string;
};

const UNREACHABLE_TITLE = "Kilo couldn't reach the server. Check your connection.";
const BUSY_TITLE = 'The server is busy. Try again in a moment.';
const STALLED_TITLE = 'Kilo stopped responding.';
const TRUNCATED_TITLE = "The model's reply was cut short.";
const SIGNED_OUT_TITLE = 'Kilo could not accept your sign-in. Sign in again, then retry.';
const OUT_OF_CREDITS_TITLE = "You're out of credits.";
const REJECTED_TITLE = 'Kilo rejected this request.';
const GENERIC_TITLE = 'Something went wrong. Try again in a moment.';

// Server error bodies carry the reason the user needs (a rejected key, a missing model); keep it short and one line.
const MAX_DETAIL_CHARS = 200;

const detailTextSchema = z.string();
const detailListSchema = z.array(z.unknown());
const detailRecordSchema = z.record(z.string(), z.unknown());

const toDetail = (value: unknown): string | undefined => {
  const text = detailTextSchema.safeParse(value);
  if (text.success) {
    const trimmed = text.data.trim();
    return trimmed === '' ? undefined : trimmed.slice(0, MAX_DETAIL_CHARS);
  }

  const list = detailListSchema.safeParse(value);
  if (list.success) {
    for (const part of list.data) {
      const detail = toDetail(part);
      if (detail !== undefined) {
        return detail;
      }
    }
    return undefined;
  }

  const record = detailRecordSchema.safeParse(value);
  if (!record.success) {
    return undefined;
  }

  // The gateway nests its reason as `error.message`; a plain body carries `message` or `detail`.
  return (
    toDetail(record.data['message']) ??
    toDetail(record.data['error']) ??
    toDetail(record.data['detail'])
  );
};

const describeStatus = (status: number, body: unknown): DescribedFetchError => {
  const detail = toDetail(body);

  if (status === 401 || status === 403) {
    return {
      ...(detail === undefined ? {} : { detail }),
      retryable: false,
      title: SIGNED_OUT_TITLE,
    };
  }

  if (status === 402) {
    return {
      action: {
        href: `${getKiloApiBaseUrl().replace(/\/+$/, '')}/credits`,
        label: 'Add credits',
      },
      ...(detail === undefined ? {} : { detail }),
      retryable: false,
      title: OUT_OF_CREDITS_TITLE,
    };
  }

  if (status === 408 || status === 429 || status >= 500) {
    return { ...(detail === undefined ? {} : { detail }), retryable: true, title: BUSY_TITLE };
  }

  if (status >= 400) {
    return { ...(detail === undefined ? {} : { detail }), retryable: false, title: REJECTED_TITLE };
  }

  return { ...(detail === undefined ? {} : { detail }), retryable: true, title: GENERIC_TITLE };
};

/**
 * Maps a failed request to copy the user can act on. `status`/`body` are for callers holding a response
 * rather than a parsed error; when the error carries them, those win.
 */
export const describeFetchError = (
  error: unknown,
  status?: number,
  body?: unknown
): DescribedFetchError => {
  if (error instanceof KiloGatewayHttpError) {
    return describeStatus(error.status, error.body ?? body);
  }

  if (status !== undefined) {
    return describeStatus(status, body);
  }

  if (error instanceof KiloGatewayStreamStalledError) {
    return { retryable: true, title: STALLED_TITLE };
  }

  if (error instanceof Error && error.name === 'TruncatedCompletionError') {
    return { retryable: true, title: TRUNCATED_TITLE };
  }

  // A fetch network failure surfaces as TypeError('Failed to fetch'); tRPC wraps that TypeError in a TRPCClientError, so the message is the only shared signal.
  if (
    error instanceof TypeError ||
    (error instanceof Error && error.message.toLowerCase().includes('failed to fetch'))
  ) {
    return { retryable: true, title: UNREACHABLE_TITLE };
  }

  return { retryable: true, title: GENERIC_TITLE };
};

const toErrorEvent = (error: unknown, retry: ErrorRetryKind): ConversationErrorEvent => {
  const described = describeFetchError(error);

  return createConversationErrorEvent({
    ...(described.action === undefined ? {} : { action: described.action }),
    ...(described.detail === undefined ? {} : { detail: described.detail }),
    ...(described.retryable ? { retry } : {}),
    title: described.title,
  });
};

/** A turn that ended in a failure the user must see, instead of assistant text. */
export const createTurnErrorEvent = (error: unknown): ConversationErrorEvent =>
  toErrorEvent(error, 'turn');

/** A failed "Compact now", surfaced in the conversation with a retry. */
export const createCompactionErrorEvent = (error: unknown): ConversationErrorEvent =>
  toErrorEvent(error, 'compaction');
