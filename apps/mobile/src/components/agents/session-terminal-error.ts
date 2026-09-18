import { i18n } from '@/i18n';
import { type QueryErrorVariant } from '@/components/query-error';

import { sdkMessageCopy } from './sdk-message-copy';

/**
 * Terminal error class for a session startup failure. The session manager's
 * fetch-fail path stores only a formatted message string on the status
 * indicator — there is no tRPC code to read — so the class is derived from
 * the message text.
 */
export type TerminalErrorClass =
  | 'permission'
  | 'credits'
  | 'busy'
  | 'model'
  | 'gone'
  | 'unavailable'
  | 'transient'
  | 'unknown';

/**
 * Classify a terminal session error message. Matches the session manager's
 * `formatError` output strings, which are English and never translated —
 * the class is what the screen renders its own copy from. Unknown text is
 * `'unknown'`, which shows the generic message and offers no retry (safer
 * than a fake one).
 *
 * The credits phrase is matched case-insensitively: the Durable Object's safe
 * projection writes `Assistant request failed: insufficient credits`
 * (lowercase), while the session manager's `formatError` writes
 * `Insufficient credits` (capitalized).
 *
 * The two service strings are matched in full rather than on "unavailable":
 * the selected-model error carries that word too, and calling it a service
 * outage would offer a Retry that cannot succeed until the model changes.
 * Order still matters — "Service is temporarily unavailable. Please retry in
 * a moment." satisfies both the unavailable and the transient test.
 */
export function classifyTerminalError(message: string): TerminalErrorClass {
  if (message.includes('not authorized')) {
    return 'permission';
  }
  if (message.toLowerCase().includes('insufficient credits')) {
    return 'credits';
  }
  if (message.includes('still finishing up')) {
    return 'busy';
  }
  if (message.includes('Selected model is unavailable')) {
    return 'model';
  }
  if (message.includes('no longer available')) {
    return 'gone';
  }
  if (
    message.includes('Service is unavailable right now') ||
    message.includes('Service is temporarily unavailable')
  ) {
    return 'unavailable';
  }
  if (message.includes('retry in a moment')) {
    return 'transient';
  }
  return 'unknown';
}

function variantForClass(cls: TerminalErrorClass): QueryErrorVariant {
  if (cls === 'permission') {
    return 'permission';
  }
  return cls === 'gone' ? 'not-found' : 'server';
}

function titleForClass(cls: TerminalErrorClass): string {
  if (cls === 'permission') {
    return i18n.t('common.accessDenied');
  }
  if (cls === 'gone') {
    return i18n.t('common.notFound');
  }
  return i18n.t('agentChat.session.couldNotLoadThisSession');
}

/** The reader's own copy for a class. The English original goes to Copy only. */
function messageForClass(cls: TerminalErrorClass): string {
  if (cls === 'permission') {
    return i18n.t('queryError.permissionDescription');
  }
  if (cls === 'credits') {
    return i18n.t('agentChat.session.notEnoughCredits');
  }
  if (cls === 'busy') {
    return i18n.t('agentChat.session.previousTaskFinishing');
  }
  if (cls === 'model') {
    return i18n.t('agentChat.session.modelUnavailable');
  }
  if (cls === 'gone') {
    return i18n.t('queryError.notFoundDescription');
  }
  if (cls === 'unavailable') {
    return i18n.t('agentChat.session.serviceUnavailable');
  }
  if (cls === 'transient') {
    return i18n.t('agentChat.session.connectionTrouble');
  }
  return i18n.t('agentChat.session.failedToLoadDetails');
}

/**
 * Waiting or a connection hiccup passes on its own. A denial, an empty wallet,
 * a session that is gone and a model the agent cannot use all need the user to
 * change something first, so they get no Retry.
 */
function retryableClass(cls: TerminalErrorClass): boolean {
  return cls === 'transient' || cls === 'busy' || cls === 'unavailable';
}

/**
 * The SDK's own fixed strings for an exhausted delivery failure. Both are app
 * copy, not provider text, and already have translated copy of their own:
 * `session-manager.ts`'s `onMessageFailed` writes the first for a retry
 * exhaustion, and the status the SDK stores for a failed delivery — the
 * `cloud.message.failed` status plus the normalizer's fallback when that event
 * carries no error — carries the second. The web and extension status
 * indicators render the same second string.
 */
const DELIVERY_FAILED_INDICATORS = new Set([
  'Message failed to deliver',
  'Message delivery failed',
]);

/**
 * The reader's copy the Durable Object writes through its safe failure
 * projection (services/cloud-agent-next/src/session/safe-failure-projection.ts
 * and the assistant failures it re-exports from src/shared/assistant-failure.ts)
 * plus the lines session-service.ts supplies directly. None of them is raw
 * provider text, so the status line shows them as-is. A bounded workspace
 * failure appends its detail to the projection line, so a message that starts
 * with one of these plus ": " is the same copy.
 */
const SAFE_FAILURE_MESSAGES = new Set([
  // Generic failure codes.
  'Could not connect to the sandbox',
  'Workspace setup failed',
  'Kilo server failed to start',
  'Agent wrapper failed to start',
  'The message could not be delivered',
  'Session metadata is unavailable',
  'No model was selected',
  'Agent wrapper disconnected',
  'Agent wrapper made no execution progress during the watchdog window',
  'Agent wrapper stopped responding',
  'Agent wrapper failed before processing the message',
  'Assistant request failed',
  'Agent wrapper failed while processing the message',
  'No assistant reply was produced',
  'Assistant request failed: insufficient credits',
  'The message was interrupted by the user',
  'The agent container shut down',
  'The message was interrupted',
  'The message failed',
  // Workspace failure subtypes.
  'Repository clone timed out',
  'Repository checkout timed out',
  'Repository authentication failed',
  'Repository request was rate limited',
  'Repository network request failed',
  'Repository data is corrupt',
  'Repository checkout conflict',
  'Requested repository branch was not found',
  'Workspace setup failed: sandbox storage full',
  'Session import timed out',
  'Session import failed',
  'Setup command timed out',
  'Setup command failed',
  // Classified assistant failures.
  'Assistant request was rate limited',
  'Assistant request failed: model not found',
  'Assistant request was not authorized',
  'Assistant service is unavailable',
  'Assistant request timed out',
  'Assistant request was invalid',
  'The model context limit was exceeded',
  'The model output limit was reached',
  'The model provider blocked the response under its content policy',
  'The model response did not match the required format',
  // Lines session-service.ts supplies as `safeFailureMessage`.
  'GitHub repository authentication failed. Check that the GitHub App is installed and has access to this repository.',
  'GitHub credential service is unavailable. Please try again.',
  'GitHub credential resolution failed. Please try again.',
]);

function isSafeFailureMessage(message: string): boolean {
  if (SAFE_FAILURE_MESSAGES.has(message)) {
    return true;
  }
  for (const safe of SAFE_FAILURE_MESSAGES) {
    if (message.startsWith(`${safe}: `)) {
      return true;
    }
  }
  return false;
}

/**
 * The reader's own copy for a session error in the transcript's status slot
 * (session-status-indicator.tsx). A provider's or the transport's own English
 * string never reaches the reader; the classified copy does instead — the same
 * rule `resolveSessionTerminalError` follows for the empty-transcript state. An
 * unrecognized string is still a failed agent run, so it gets the
 * assistant-failure line rather than a generic one.
 *
 * A string the SDK writes itself (`sdkMessageCopy`) resolves to its pinned
 * catalog key, so the reader gets their own language. The Durable Object's safe
 * failure projection is already the reader's copy and has no translated
 * counterpart, so the indicator shows it as-is.
 */
export function sessionStatusErrorMessage(raw: string): string {
  if (DELIVERY_FAILED_INDICATORS.has(raw)) {
    return i18n.t('agentChat.messageFailure.deliveryTitle');
  }
  const mapped = sdkMessageCopy(raw);
  if (mapped !== null) {
    return mapped;
  }
  if (isSafeFailureMessage(raw)) {
    // The DO writes the credits failure as safe copy with a lowercase phrase;
    // the reader still gets the actionable credits line.
    return classifyTerminalError(raw) === 'credits' ? messageForClass('credits') : raw;
  }
  const cls = classifyTerminalError(raw);
  return cls === 'unknown'
    ? i18n.t('agentChat.messageFailure.assistantFailed')
    : messageForClass(cls);
}

/**
 * The terminal error a session must surface, taking precedence over the
 * skeleton. Copy is always offered for a terminal error, regardless of class.
 */
export type SessionTerminalError = {
  variant: QueryErrorVariant;
  title: string;
  message: string;
  retryable: boolean;
  /** The untranslated original, for the clipboard. Empty when there was none. */
  detail: string;
};

/**
 * Resolve the terminal error for a session with no messages. Returns `null`
 * when there is nothing terminal to show (loading, empty, or a live session).
 *
 * Precedence: a populated transcript never shows a terminal error; an
 * `errorAtom` value is a retryable server failure; a `statusIndicator` of type
 * `error` is classified by its message.
 */
export function resolveSessionTerminalError(input: {
  error: string | null;
  statusIndicator: { type: string; message: string } | null;
  messageCount: number;
}): SessionTerminalError | null {
  if (input.messageCount > 0) {
    return null;
  }
  if (input.error !== null) {
    // The atom carries the transport's own English text. Show the reader a
    // translated line and keep the original for the clipboard.
    return {
      variant: 'server',
      title: i18n.t('agentChat.session.couldNotLoadThisSession'),
      message: i18n.t('agentChat.session.failedToLoadDetails'),
      retryable: true,
      detail: input.error,
    };
  }
  if (input.statusIndicator?.type === 'error') {
    const detail = input.statusIndicator.message;
    const cls = classifyTerminalError(detail);
    return {
      variant: variantForClass(cls),
      title: titleForClass(cls),
      message: messageForClass(cls),
      retryable: retryableClass(cls),
      detail,
    };
  }
  return null;
}

/**
 * Build the clipboard text for a terminal error: session id, then what the
 * reader saw, then the untranslated original that support needs.
 */
export function buildTerminalErrorCopyText(input: {
  sessionId: string;
  title: string;
  message: string;
  /** The untranslated original. Omitted when the message already is it. */
  detail?: string;
}): string {
  const { sessionId, title, message, detail } = input;
  return [sessionId, title, message, detail === message ? '' : detail].filter(Boolean).join('\n');
}
