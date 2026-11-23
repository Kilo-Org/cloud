import { type SessionSnapshotFailureKind } from '@kilocode/cloud-agent-sdk';

import { i18n } from '@/i18n';

import { describeTerminalFailure, type SessionTerminalError } from './session-terminal-error';

/**
 * The sub-agent sheet's copy for the two history kinds a retry cannot recover.
 * Keyed by the kind rather than a fallthrough, so a failure kind added later
 * fails the type check here instead of borrowing unreadable-data wording.
 */
const TERMINAL_HISTORY_COPY = {
  too_large: 'agentChat.childSessionSheet.historyTooLarge',
  invalid_data: 'agentChat.childSessionSheet.historyUnavailable',
} as const satisfies Record<Exclude<SessionSnapshotFailureKind, 'retryable_failure'>, string>;

/**
 * The reader's copy and retryability for a child session's failed first-page
 * load. The typed history kind decides both: a retryable failure names the
 * outage and keeps its Retry, while a terminal kind — an oversize or unreadable
 * stored page — states its own reason and never offers one, because the same
 * read answers the same way every time. A null kind is a failure the read never
 * typed (a dropped transport, or a worker 404 for a gone child), so it
 * classifies from its sentence like any other error. The untranslated original
 * stays in `detail` for Copy.
 *
 * The copy names the child as a sub-agent, matching the child sheet's own
 * surface, instead of borrowing the root transcript's session wording. The
 * title still comes from the session keys: the sheet is a session that failed
 * to open, whatever the reader calls the thing they tapped.
 */
export function describeChildHistoryFailure(state: {
  kind: SessionSnapshotFailureKind | null;
  message: string;
}): SessionTerminalError {
  const { kind, message } = state;
  if (kind == null) {
    return describeTerminalFailure(message);
  }
  return {
    variant: 'server',
    title: i18n.t('agentChat.session.couldNotLoadThisSession'),
    message: i18n.t(
      kind === 'retryable_failure'
        ? 'agentChat.childSessionSheet.historyTemporarilyUnavailable'
        : TERMINAL_HISTORY_COPY[kind]
    ),
    retryable: kind === 'retryable_failure',
    retryWith: 'session',
    detail: message,
  };
}
