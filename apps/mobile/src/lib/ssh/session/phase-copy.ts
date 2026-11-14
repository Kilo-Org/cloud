import { type TFunction } from 'i18next';

import { isSshErrorCategory, SSH_ERROR_POLICY } from '../error-policy';

import { type SshCloseReason, type SshSessionPhase } from './types';

/** What ended a session, in the person's words. */
const REASON_KEY = {
  disconnected: 'ssh.session.reason.disconnected',
  'key-missing': 'ssh.session.reason.keyMissing',
  'host-missing': 'ssh.session.reason.hostMissing',
  unavailable: 'ssh.session.reason.unavailable',
  user: 'ssh.session.reason.closed',
} satisfies Record<Exclude<SshCloseReason, keyof typeof SSH_ERROR_POLICY>, string>;

export function closeReasonMessage(t: TFunction, reason: SshCloseReason): string {
  return t(isSshErrorCategory(reason) ? SSH_ERROR_POLICY[reason].key : REASON_KEY[reason]);
}

/** The one-line state the session switcher shows beside a session. */
const STATE_KEY = {
  connecting: 'ssh.session.state.connecting',
  'awaiting-host-key': 'ssh.session.state.hostKey',
  'awaiting-password': 'ssh.session.state.prompt',
  'awaiting-passphrase': 'ssh.session.state.prompt',
  'awaiting-prompts': 'ssh.session.state.prompt',
  connected: 'common.connected',
  reconnecting: 'ssh.session.state.reconnecting',
  closed: 'common.closed',
} satisfies Record<SshSessionPhase['kind'], string>;

export function sessionStateLabel(t: TFunction, phase: SshSessionPhase): string {
  return t(STATE_KEY[phase.kind]);
}
