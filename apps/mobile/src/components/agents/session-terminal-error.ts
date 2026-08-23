import { i18n } from '@/i18n';
import { type QueryErrorVariant } from '@/components/query-error';

/**
 * Terminal error class for a session startup failure. The session manager's
 * fetch-fail path stores only a formatted message string on the status
 * indicator — there is no tRPC code to read — so the class is derived from
 * the message text.
 */
export type TerminalErrorClass = 'not-found' | 'permission' | 'transient' | 'unknown';

/**
 * Classify a terminal session error message. Matches the session manager's
 * `formatError` output strings. Unknown text is `'unknown'` (permanent — safer
 * than a fake retry).
 */
export function classifyTerminalError(message: string): TerminalErrorClass {
  if (message.includes('not authorized')) {
    return 'permission';
  }
  if (message.includes('Service is unavailable right now')) {
    return 'not-found';
  }
  if (message.includes('retry in a moment')) {
    return 'transient';
  }
  return 'unknown';
}

function variantForClass(cls: TerminalErrorClass): QueryErrorVariant {
  if (cls === 'not-found') {
    return 'not-found';
  }
  if (cls === 'permission') {
    return 'permission';
  }
  return 'server';
}

function titleForClass(cls: TerminalErrorClass): string {
  if (cls === 'not-found') {
    return i18n.t('agentChat.session.notFound');
  }
  if (cls === 'permission') {
    return i18n.t('agentChat.session.accessDenied');
  }
  return i18n.t('agentChat.session.couldNotLoadThisSession');
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
};

/**
 * Resolve the terminal error for a session with no messages. Returns `null`
 * when there is nothing terminal to show (loading, empty, or a live session).
 *
 * Precedence: a populated transcript never shows a terminal error; an
 * `errorAtom` value is a retryable server failure; a `statusIndicator` of type
 * `error` is classified by its message (only `transient` is retryable).
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
    return {
      variant: 'server',
      title: i18n.t('agentChat.session.couldNotLoadThisSession'),
      message: input.error,
      retryable: true,
    };
  }
  if (input.statusIndicator?.type === 'error') {
    const message = input.statusIndicator.message;
    const cls = classifyTerminalError(message);
    return {
      variant: variantForClass(cls),
      title: titleForClass(cls),
      message,
      retryable: cls === 'transient',
    };
  }
  return null;
}

/** Build the clipboard text for a terminal error: session id + title + message. */
export function buildTerminalErrorCopyText(
  sessionId: string,
  title: string,
  message: string
): string {
  return [sessionId, title, message].filter(Boolean).join('\n');
}
