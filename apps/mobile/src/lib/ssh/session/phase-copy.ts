import  { type TFunction } from 'i18next';

import  { type SshCloseReason, type SshSessionPhase } from './types';

/** What ended a session, in the person's words. */
const REASON_KEY: Record<SshCloseReason, string> = {
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
};

export function closeReasonMessage(t: TFunction, reason: SshCloseReason): string {
  return t(REASON_KEY[reason]);
}

/** The one-line state the session switcher shows beside a session. */
export function sessionStateLabel(t: TFunction, phase: SshSessionPhase): string {
  switch (phase.kind) {
    case 'connecting': {
      return t('ssh.session.state.connecting');
    }
    case 'awaiting-host-key': {
      return t('ssh.session.state.hostKey');
    }
    case 'awaiting-password':
    case 'awaiting-passphrase':
    case 'awaiting-prompts': {
      return t('glanceable.waitingForYou');
    }
    case 'connected': {
      return t('common.connected');
    }
    case 'reconnecting': {
      return t('ssh.session.state.reconnecting');
    }
    case 'closed': {
      return t('common.closed');
    }
  }
}
