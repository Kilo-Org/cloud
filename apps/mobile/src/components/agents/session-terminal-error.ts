import { i18n } from '@/i18n';
import { type QueryErrorVariant } from '@/components/query-error';

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
  if (message.includes('Insufficient credits')) {
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
    return i18n.t('agentChat.session.notFound');
  }
  return i18n.t('agentChat.session.couldNotLoadThisSession');
}

/** The reader's own copy for a class. The English original goes to Copy only. */
function messageForClass(cls: TerminalErrorClass): string {
  if (cls === 'permission') {
    return i18n.t('agentChat.session.accessDeniedDescription');
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
    return i18n.t('agentChat.session.notFoundDescription');
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
