import { type SdkStatusMessageCode, type SessionStatusIndicator } from '@kilocode/cloud-agent-sdk';

import { i18n } from '@/i18n';
import { type QueryErrorVariant } from '@/components/query-error';

import { type MessageFailure } from './message-failure-state';
import { isSafeFailureMessage } from './safe-failure-messages';

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
 * The catalog copy for each code the SDK writes itself. The SDK ships the
 * locale-free `code` beside its English `message`, so the app renders the
 * reader's own language instead of the SDK's fixed English line. Codes the SDK
 * only attaches to text it forwards from the Durable Object or the transport
 * are absent here and fall to the classifier below.
 */
const STATUS_COPY_KEY_BY_CODE = {
  'agent-connection-lost': 'agentChat.sessionConnection.connectionLost',
  'session-stopped': 'agentChat.session.stopped',
  'setting-up-environment': 'agentChat.composer.preparingPlaceholder',
  'wrapping-up': 'agentChat.composer.finalizingPlaceholder',
  committing: 'agentChat.session.committing',
  committed: 'agentChat.session.committed',
  'commit-failed': 'agentChat.session.commitFailed',
  'message-delivery-failed': 'agentChat.messageFailure.deliveryTitle',
  'failed-to-stop-execution': 'agentChat.session.failedToStopExecution',
} satisfies Partial<Record<SdkStatusMessageCode, string>>;

/** The catalog key for a code that labels an SDK-written line, or undefined. */
export function statusCopyKeyForCode(code: SdkStatusMessageCode): string | undefined {
  return STATUS_COPY_KEY_BY_CODE[code as keyof typeof STATUS_COPY_KEY_BY_CODE];
}

/**
 * The terminal-error class for a code, mirroring `classifyTerminalError`'s
 * answer for the same failure. A code whose failure the classifier cannot name
 * is `'unknown'`, exactly as its message-text counterpart is. Codes that carry
 * their own catalog copy (`STATUS_COPY_KEY_BY_CODE`) name no class because the
 * status line renders the copy directly.
 */
const ERROR_CLASS_BY_CODE = {
  'not-authorized': 'permission',
  'insufficient-credits': 'credits',
  'previous-task-in-progress': 'busy',
  'selected-model-unavailable': 'model',
  'service-unavailable': 'unavailable',
  'service-temporarily-unavailable': 'unavailable',
  'connection-lost': 'transient',
  'connection-failed': 'transient',
  'generic-error': 'transient',
  'child-session-not-found': 'gone',
  'session-terminated': 'unknown',
} satisfies Partial<Record<SdkStatusMessageCode, TerminalErrorClass>>;

/** The class for a coded failure, or undefined when the code has catalog copy. */
function errorClassForCode(code: SdkStatusMessageCode): TerminalErrorClass | undefined {
  return ERROR_CLASS_BY_CODE[code as keyof typeof ERROR_CLASS_BY_CODE];
}

/**
 * The reader's own copy for a session error in the transcript's status slot
 * (session-status-indicator.tsx). A code the SDK attaches to its own fixed copy
 * maps straight to catalog copy; a code for a failure the app can name maps to
 * the same class its message text would. Everything else is text the SDK
 * forwards — a provider's or the transport's English string — so it goes
 * through the classifier: the reader sees translated copy, never the raw
 * string. An unrecognized string is still a failed agent run, so it gets the
 * assistant-failure line rather than a generic one.
 *
 * The Durable Object's safe failure projection is already the reader's copy, so
 * the indicator shows it as-is.
 */
export function sessionStatusErrorMessage(input: {
  message: string;
  code?: SdkStatusMessageCode;
}): string {
  const { message: raw, code } = input;
  if (code !== undefined) {
    const copyKey = statusCopyKeyForCode(code);
    if (copyKey !== undefined) {
      return i18n.t(copyKey);
    }
  }
  if (DELIVERY_FAILED_INDICATORS.has(raw)) {
    return i18n.t('agentChat.messageFailure.deliveryTitle');
  }
  if (isSafeFailureMessage(raw)) {
    // The DO writes the credits failure as safe copy with a lowercase phrase;
    // the reader still gets the actionable credits line.
    return classifyTerminalError(raw) === 'credits' ? messageForClass('credits') : raw;
  }
  const codedClass = code === undefined ? undefined : errorClassForCode(code);
  const cls = codedClass ?? classifyTerminalError(raw);
  return cls === 'unknown'
    ? i18n.t('agentChat.messageFailure.assistantFailed')
    : messageForClass(cls);
}

/**
 * True when the fixed footer's error line would only restate the failure the
 * transcript's last message row already shows. The row owns its failure and its
 * action; a second copy of the same sentence in the footer reads as a glitch,
 * not a designed error state. A line the row does not carry — a classified
 * credits, service or permission failure, or the Durable Object's own safe
 * projection — is kept: the footer is where the reader gets that reason.
 */
export function statusIndicatorDuplicatesMessageFailure(input: {
  indicator: Pick<SessionStatusIndicator, 'type' | 'message' | 'code'>;
  failure: MessageFailure | null;
}): boolean {
  const { indicator, failure } = input;
  if (indicator.type !== 'error' || failure === null) {
    return false;
  }
  const copy = sessionStatusErrorMessage({ message: indicator.message, code: indicator.code });
  // Compare catalog keys, not the resolved copy: `failure` can be captured
  // before an in-place language switch, so its memoized strings may be in the
  // previous language while `copy` is resolved here in the current one.
  if (copy === i18n.t(failure.titleKey)) {
    return true;
  }
  if (failure.detailKey !== null && copy === i18n.t(failure.detailKey)) {
    return true;
  }
  // An agent-execution delivery failure renders the assistant-failure title
  // (message-failure-state.ts) while the SDK's status indicator for it is the
  // delivery-failed line ("Message delivery failed" -> "Failed to deliver",
  // normalizer.ts). The row already states that failed run, so the delivery
  // line would restate it.
  if (
    failure.kind === 'delivery' &&
    failure.titleKey === 'agentChat.messageFailure.assistantTitle' &&
    copy === i18n.t('agentChat.messageFailure.deliveryTitle')
  ) {
    return true;
  }
  // An unclassified status error resolves to the generic assistant line. Any
  // last row that states a failure owns that statement — an assistant row's
  // title says it, and a failed delivery row says it with Retry/Copy — so the
  // footer must not restate it.
  return copy === i18n.t('agentChat.messageFailure.assistantFailed');
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
 * The reader's copy and retryability for a raw SDK error string. The session
 * manager, the Durable Object's failure projection and the transport all write
 * English into the atoms and hydration state, so any surface that wants to show
 * one of those strings runs it through here: the reader gets catalog copy, and
 * `retryable` says whether a Retry can recover the failure. The original stays
 * in `detail` for Clipboard.
 */
export function describeTerminalFailure(message: string): SessionTerminalError {
  const cls = classifyTerminalError(message);
  return {
    variant: variantForClass(cls),
    title: titleForClass(cls),
    message: messageForClass(cls),
    retryable: retryableClass(cls),
    detail: message,
  };
}

/**
 * Whether a terminal failure can recover by retrying. A coded failure names
 * its class directly; an uncoded one is classified from its message. The
 * composer's reason line uses this so a non-retryable failure on an empty
 * transcript (not authorized, insufficient credits, selected model
 * unavailable, session gone) states its own reason instead of telling the
 * reader to Retry an action the full-screen error does not offer.
 */
export function isRetryableTerminalFailure(input: {
  message: string;
  code?: SdkStatusMessageCode;
}): boolean {
  const codedClass = input.code === undefined ? undefined : errorClassForCode(input.code);
  return retryableClass(codedClass ?? classifyTerminalError(input.message));
}

/** The reader's copy and the untranslated original for a runtime failure. */
type SessionRuntimeFailure = {
  message: string;
  detail: string;
};

/**
 * The reader's copy for a session's runtime failure — a failed agent run, not a
 * failed page load. The child sheet's `sessionError` is the same value its
 * transcript banner renders through `sessionStatusErrorMessage`, so the
 * full-screen child error resolves the same copy: a recognized class gets its
 * line, the Durable Object's safe failure projection passes through, and an
 * unrecognized failure gets the assistant-failure line. That last part is why
 * this exists: `describeTerminalFailure`'s fallback names a page-load failure,
 * which is a different failure than the one the user hit. The untranslated
 * original stays in `detail` for Copy.
 */
export function describeSessionRuntimeFailure(message: string): SessionRuntimeFailure {
  return {
    message: sessionStatusErrorMessage({ message }),
    detail: message,
  };
}

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
  statusIndicator: { type: string; message: string; code?: SdkStatusMessageCode } | null;
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
    const code = input.statusIndicator.code;
    // The code names the failure without depending on the English message; a
    // code the app has no class for falls back to the message, through the same
    // classifier the child sheet's error surfaces use.
    const codedClass = code === undefined ? undefined : errorClassForCode(code);
    if (codedClass === undefined) {
      return describeTerminalFailure(detail);
    }
    return {
      variant: variantForClass(codedClass),
      title: titleForClass(codedClass),
      message: messageForClass(codedClass),
      retryable: retryableClass(codedClass),
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
