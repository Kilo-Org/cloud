import { type TFunction } from 'i18next';

import { type SshCloseReason, type SshSessionPhase } from './types';

/** What ended a session, in the person's words. */
const REASON_KEY = {
  Network: 'ssh.session.reason.network',
  Timeout: 'ssh.session.reason.timeout',
  ChannelClosed: 'ssh.session.reason.channelClosed',
  disconnected: 'ssh.session.reason.disconnected',
  AuthFailed: 'ssh.session.reason.authFailed',
  AuthCancelled: 'ssh.session.reason.authCancelled',
  HostKeyRejected: 'ssh.session.reason.hostKeyRejected',
  UnsupportedAlgorithm: 'ssh.session.reason.unsupportedAlgorithm',
  KeyParse: 'ssh.session.reason.keyParse',
  WrongPassphrase: 'ssh.session.reason.wrongPassphrase',
  Protocol: 'ssh.session.reason.protocol',
  KeyGeneration: 'ssh.session.reason.keyGeneration',
  'key-missing': 'ssh.session.reason.keyMissing',
  'host-missing': 'ssh.session.reason.hostMissing',
  unavailable: 'ssh.session.reason.unavailable',
  user: 'ssh.session.reason.closed',
} satisfies Record<SshCloseReason, string>;

export function closeReasonMessage(t: TFunction, reason: SshCloseReason): string {
  return t(REASON_KEY[reason]);
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
