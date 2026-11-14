import {
  SSH_CONNECT_FAILED_EVENT,
  SSH_CONNECT_SUCCEEDED_EVENT,
  SSH_EXPORT_EVENT,
  SSH_FORWARD_FAILED_EVENT,
  SSH_FORWARD_STARTED_EVENT,
  SSH_IMPORT_EVENT,
  SSH_RECONNECT_EVENT,
  SSH_SANDBOX_TERMINAL_EVENT,
  SSH_SFTP_TRANSFER_EVENT,
  type SshAuthMethod,
  type SshFailureCategory,
  type SshForwardDirection,
  type SshOperationOutcome,
  type SshReconnectOutcome,
  type SshTerminalOutcome,
  type SshTransferDirection,
} from '@kilocode/app-shared/analytics';

import { captureEvent } from '@/lib/analytics/posthog';

import { type SshCloseReason } from './session/types';

const FAILURE_CATEGORY_BY_REASON = {
  Network: 'network',
  Timeout: 'timeout',
  HostKeyRejected: 'host_key_rejected',
  AuthFailed: 'auth_failed',
  AuthCancelled: 'auth_cancelled',
  UnsupportedAlgorithm: 'unsupported_algorithm',
  KeyParse: 'key_parse',
  WrongPassphrase: 'wrong_passphrase',
  InvalidExport: 'invalid_export',
  ChannelClosed: 'channel_closed',
  Protocol: 'protocol',
  OutputLimit: 'output_limit',
  KeyGeneration: 'key_generation',
  NotFound: 'not_found',
  PermissionDenied: 'permission_denied',
  Cancelled: 'cancelled',
  Forwarding: 'forwarding',
  LocalIo: 'local_io',
  disconnected: 'disconnected',
  user: 'user',
  'key-missing': 'key_missing',
  'host-missing': 'host_missing',
  unavailable: 'unavailable',
} satisfies Record<SshCloseReason, SshFailureCategory>;

/** Canonical categories callers outside the session runtime may pass by name. */
const FAILURE_CATEGORY_ALIAS = {
  wrong_passphrase: 'wrong_passphrase',
  invalid_export: 'invalid_export',
  local_io: 'local_io',
} satisfies Record<string, SshFailureCategory>;

const failureCategoryByReason = new Map<string, SshFailureCategory>([
  ...Object.entries(FAILURE_CATEGORY_BY_REASON),
  ...Object.entries(FAILURE_CATEGORY_ALIAS),
]);

/** A closed category for a reason the core reported, or `unknown`. */
export function sshFailureCategory(reason: string | null): SshFailureCategory {
  return (reason === null ? undefined : failureCategoryByReason.get(reason)) ?? 'unknown';
}

function operationCategory(outcome: SshOperationOutcome, code: string | null): SshFailureCategory {
  return outcome === 'failed' ? sshFailureCategory(code) : 'none';
}

export function trackSshConnectSucceeded(authMethod: SshAuthMethod): void {
  captureEvent(SSH_CONNECT_SUCCEEDED_EVENT, { category: 'none', authMethod });
}

export function trackSshConnectFailed(authMethod: SshAuthMethod, reason: string): void {
  captureEvent(SSH_CONNECT_FAILED_EVENT, {
    category: sshFailureCategory(reason),
    authMethod,
  });
}

export function trackSshReconnect(outcome: SshReconnectOutcome): void {
  captureEvent(SSH_RECONNECT_EVENT, { outcome });
}

export function trackSshSftpTransfer(
  direction: SshTransferDirection,
  outcome: SshOperationOutcome,
  code: string | null
): void {
  captureEvent(SSH_SFTP_TRANSFER_EVENT, {
    direction,
    outcome,
    category: operationCategory(outcome, code),
  });
}

export function trackSshForwardStarted(direction: SshForwardDirection): void {
  captureEvent(SSH_FORWARD_STARTED_EVENT, { direction, category: 'none' });
}

export function trackSshForwardFailed(direction: SshForwardDirection, code: string | null): void {
  captureEvent(SSH_FORWARD_FAILED_EVENT, {
    direction,
    category: sshFailureCategory(code),
  });
}

export function trackSshExport(outcome: SshOperationOutcome, code: string | null): void {
  captureEvent(SSH_EXPORT_EVENT, { outcome, category: operationCategory(outcome, code) });
}

export function trackSshImport(outcome: SshOperationOutcome, code: string | null): void {
  captureEvent(SSH_IMPORT_EVENT, { outcome, category: operationCategory(outcome, code) });
}

export function trackSshSandboxTerminal(outcome: SshTerminalOutcome): void {
  captureEvent(SSH_SANDBOX_TERMINAL_EVENT, { outcome });
}
