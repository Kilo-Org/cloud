import { type CloudStatus, type SdkStatusMessageCode } from '@kilocode/cloud-agent-sdk';

import { i18n } from '@/i18n';

import {
  isRetryableTerminalFailure,
  sessionStatusErrorMessage,
  statusCopyKeyForCode,
} from '@/components/agents/session-terminal-error';

/** The status indicator fields the reason resolver reads. */
type ComposerStatusIndicator = {
  type?: 'error' | 'warning' | 'info' | 'progress';
  message: string;
  code?: SdkStatusMessageCode;
};

export type ComposerSendDisabledReasonInput = {
  /** The session's live send capability (`manager.atoms.canSend`). */
  canSend: boolean;
  /**
   * Whether the session resolved read-only (`manager.atoms.isReadOnly`). The
   * SDK latches `canSend` false for a read-only session, so without this the
   * reason collapses to the generic unresolved/connecting line and tells the
   * reader a permanently read-only session will become ready. Omit when the
   * caller cannot know it.
   */
  isReadOnly?: boolean;
  /** The load failure from the session error atom, or null. */
  error: string | null;
  /** The active status line, or null when the session has none. */
  statusIndicator: ComposerStatusIndicator | null;
  /** Cloud infrastructure status, or null before it is known. */
  cloudStatus: CloudStatus | null;
  /**
   * Transcript length. A terminal error on a session with no messages is the
   * session-load failure the reader is being asked to Retry, not a runtime
   * failure of a running session. Omit when the caller cannot know it.
   */
  messageCount?: number;
};

/**
 * How the reason line reads. `error` paints it in the destructive tone — a
 * genuine failure the reader must act on. `neutral` keeps it in the status
 * tone, so a phase like "Setting up environment…" or the generic not-ready
 * line does not read as a failure.
 */
export type ComposerSendDisabledReasonTone = 'error' | 'neutral';

type ResolvedComposerSendDisabledReason = {
  message: string;
  tone: ComposerSendDisabledReasonTone;
};

/**
 * Status codes whose line is a progress phase, not a failure, so the reason
 * beside send stays in the neutral status tone. Every other code (connection
 * lost, delivery failed, commit failed, failed to stop) is a failure.
 */
const NEUTRAL_STATUS_CODES = new Set<SdkStatusMessageCode>([
  'setting-up-environment',
  'wrapping-up',
  'committing',
  'committed',
  'session-stopped',
]);

/**
 * Resolve the reason line and its tone together, so the two can never
 * disagree. See `resolveComposerSendDisabledReason` for the contract.
 */
function resolveReason(
  input: ComposerSendDisabledReasonInput
): ResolvedComposerSendDisabledReason | null {
  if (input.canSend) {
    return null;
  }
  // The error atom covers two situations: the transport's failed load (the
  // session behind the full-screen Retry, which has no transcript) and a live
  // service error on a loaded transcript ('Connection to agent lost'). Only
  // the empty-transcript case is the load failure the reader can Retry; a
  // loaded transcript keeps its own cannot-send reason, so the reader is never
  // told a running session could not be loaded.
  if (input.error !== null && (input.messageCount ?? 0) === 0) {
    return { message: i18n.t('agentChat.composer.sessionLoadFailed'), tone: 'error' };
  }
  const { cloudStatus } = input;
  if (cloudStatus?.type === 'preparing') {
    return { message: i18n.t('agentChat.composer.preparingPlaceholder'), tone: 'neutral' };
  }
  if (cloudStatus?.type === 'finalizing') {
    return { message: i18n.t('agentChat.composer.finalizingPlaceholder'), tone: 'neutral' };
  }
  const indicator = input.statusIndicator;
  if (indicator === null) {
    // A read-only session is a permanent fact, not a transient
    // unresolved/connecting transport: the SDK latches `canSend` false and the
    // reader sees the read-only banner and continue affordance. Name read-only
    // here so the reason never reads as "not ready yet" on a session that can
    // never send. It stays below the load-error and phase branches, so a
    // read-only session that also carries one of those keeps that reason.
    if (input.isReadOnly === true) {
      return { message: i18n.t('agentChat.session.readOnly'), tone: 'neutral' };
    }
    // Nothing more specific to say: the session is unresolved or connecting.
    return { message: i18n.t('agentChat.composer.sendUnavailable'), tone: 'neutral' };
  }
  // A code the SDK writes itself carries its own catalog copy (connection
  // lost, stopped, delivery failed, setting up, wrapping up, committing,
  // committed, commit failed, failed to stop).
  const statusCopyKey =
    indicator.code === undefined ? undefined : statusCopyKeyForCode(indicator.code);
  if (statusCopyKey !== undefined) {
    return {
      message: i18n.t(statusCopyKey),
      tone:
        indicator.code !== undefined && NEUTRAL_STATUS_CODES.has(indicator.code)
          ? 'neutral'
          : 'error',
    };
  }
  // A terminal error with no message (and no code) is the failed load behind
  // the full-screen Retry. A terminal error on a transcript with no messages is
  // that same load failure only when a Retry can recover it (transient, busy,
  // or a service outage). A non-retryable class (not authorized, insufficient
  // credits, selected model unavailable, session gone) is the full-screen error
  // whose Retry the UI withholds, so the reason states that class instead of
  // instructing an action the screen does not provide.
  const isTerminalError = indicator.type === undefined || indicator.type === 'error';
  if (isTerminalError) {
    const isUncodedEmptyMessage = indicator.code === undefined && indicator.message.trim() === '';
    const retryable = isRetryableTerminalFailure({
      message: indicator.message,
      code: indicator.code,
    });
    if (isUncodedEmptyMessage || (input.messageCount === 0 && retryable)) {
      return { message: i18n.t('agentChat.composer.sessionLoadFailed'), tone: 'error' };
    }
  }
  // Resolve through the transcript's own status surface
  // (`sessionStatusErrorMessage`) so the reason beside Send and the transcript
  // never disagree: a recognized class gets its catalog copy, the Durable
  // Object's safe failure projection passes through, and an unrecognized
  // runtime failure gets the assistant-failure line. Classifying through
  // `describeTerminalFailure` would give that last case the page-load line,
  // which contradicts the loaded transcript this reason is rendered on.
  return { message: sessionStatusErrorMessage(indicator), tone: 'error' };
}

/**
 * One line stating why the send control cannot send right now, for the line
 * beside it. Returns null only while the session can send; every cannot-send
 * state resolves catalog copy so the control never reads as a bare disabled
 * arrow. The reader's own language comes from `i18n`, and the returned string
 * is the same one the input row exposes to screen readers.
 *
 * Precedence matches the surfaces the reader already sees: a failed load (the
 * error atom on an empty transcript, or a retryable terminal error on an empty
 * transcript) points at Retry; a non-retryable terminal error on an empty
 * transcript states its own class, matching the full-screen error that offers
 * no Retry; Cloud setup and teardown state their phase; a status line with its
 * own catalog copy states it; any other terminal failure gets the class copy
 * the transcript's status indicator renders; a read-only session names
 * read-only instead of the generic not-ready line; and every other
 * unresolved/connecting session gets the generic line.
 */
export function resolveComposerSendDisabledReason(
  input: ComposerSendDisabledReasonInput
): string | null {
  return resolveReason(input)?.message ?? null;
}

/**
 * The tone the reason line should render in, paired with
 * `resolveComposerSendDisabledReason`. A phase or the generic not-ready line
 * resolves to `neutral`; a genuine failure resolves to `error`. Null only
 * while the session can send.
 */
export function resolveComposerSendDisabledReasonTone(
  input: ComposerSendDisabledReasonInput
): ComposerSendDisabledReasonTone | null {
  return resolveReason(input)?.tone ?? null;
}
