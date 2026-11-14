import {
  SSH_ERROR_CODES,
  type SshErrorCode as SshErrorCategory,
} from '../../../modules/kilo-ssh/src/ReactNativeSsh.types';

export const SSH_ERROR_POLICY = {
  Network: { key: 'ssh.session.reason.network', retryable: true },
  Timeout: { key: 'ssh.session.reason.timeout', retryable: true },
  ChannelClosed: { key: 'ssh.session.reason.channelClosed', retryable: true },
  AuthFailed: { key: 'ssh.session.reason.authFailed', retryable: false },
  AuthCancelled: { key: 'ssh.session.reason.authCancelled', retryable: false },
  HostKeyRejected: { key: 'ssh.session.reason.hostKeyRejected', retryable: false },
  UnsupportedAlgorithm: { key: 'ssh.session.reason.unsupportedAlgorithm', retryable: false },
  KeyParse: { key: 'ssh.session.reason.keyParse', retryable: false },
  WrongPassphrase: { key: 'ssh.session.reason.wrongPassphrase', retryable: false },
  Protocol: { key: 'ssh.session.reason.protocol', retryable: false },
  KeyGeneration: { key: 'ssh.session.reason.keyGeneration', retryable: false },
  NotFound: { key: 'ssh.session.reason.notFound', retryable: false },
  PermissionDenied: { key: 'ssh.files.errors.permission', retryable: false },
  Cancelled: { key: 'ssh.session.reason.cancelled', retryable: false },
  Forwarding: { key: 'ssh.session.reason.forwarding', retryable: false },
  LocalIo: { key: 'ssh.session.reason.localIo', retryable: false },
  InvalidExport: { key: 'ssh.session.reason.protocol', retryable: false },
  OutputLimit: { key: 'ssh.errors.outputLimit', retryable: false },
} satisfies Record<SshErrorCategory, { key: string; retryable: boolean }>;

export function isSshErrorCategory(code: string): code is SshErrorCategory {
  return SSH_ERROR_CODES.some(candidate => candidate === code);
}
