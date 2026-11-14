import { beforeEach, expect, it, vi } from 'vitest';

import {
  SSH_CONNECT_FAILED_EVENT,
  SSH_CONNECT_SUCCEEDED_EVENT,
  SSH_EXPORT_EVENT,
  SSH_FAILURE_CATEGORIES,
  SSH_FORWARD_FAILED_EVENT,
  SSH_FORWARD_STARTED_EVENT,
  SSH_IMPORT_EVENT,
  SSH_RECONNECT_EVENT,
  SSH_SANDBOX_TERMINAL_EVENT,
  SSH_SFTP_TRANSFER_EVENT,
} from '@kilocode/app-shared/analytics';

import {
  sshFailureCategory,
  trackSshConnectFailed,
  trackSshConnectSucceeded,
  trackSshExport,
  trackSshForwardFailed,
  trackSshForwardStarted,
  trackSshImport,
  trackSshReconnect,
  trackSshSandboxTerminal,
  trackSshSftpTransfer,
} from './analytics';

const captureEvent = vi.hoisted(() => vi.fn());

vi.mock('@/lib/analytics/posthog', () => ({ captureEvent }));

beforeEach(() => {
  captureEvent.mockReset();
});

const allowlisted = new Set<string>(SSH_FAILURE_CATEGORIES);

it('reports connection establishment with the credential kind only', () => {
  trackSshConnectSucceeded('key');
  expect(captureEvent).toHaveBeenCalledWith(SSH_CONNECT_SUCCEEDED_EVENT, {
    category: 'none',
    authMethod: 'key',
  });
});

it('maps a known close reason to its allowlisted category', () => {
  trackSshConnectFailed('password', 'HostKeyRejected');
  expect(captureEvent).toHaveBeenCalledWith(SSH_CONNECT_FAILED_EVENT, {
    category: 'host_key_rejected',
    authMethod: 'password',
  });
});

it('never forwards a free-text reason into the payload', () => {
  const reason = 'user@host /home/user cat secrets';
  trackSshConnectFailed('keyboard_interactive', reason);
  expect(sshFailureCategory(reason)).toBe('unknown');
  expect(captureEvent).toHaveBeenCalledWith(SSH_CONNECT_FAILED_EVENT, {
    category: 'unknown',
    authMethod: 'keyboard_interactive',
  });
  expect(JSON.stringify(captureEvent.mock.calls)).not.toContain('user@host');
});

it('maps the lower-case categories backup callers pass by name', () => {
  for (const category of ['wrong_passphrase', 'invalid_export', 'local_io'] as const) {
    expect(sshFailureCategory(category)).toBe(category);
  }
  trackSshImport('failed', 'local_io');
  expect(captureEvent).toHaveBeenCalledWith(SSH_IMPORT_EVENT, {
    outcome: 'failed',
    category: 'local_io',
  });
});

it('keeps every category inside the shared allowlist', () => {
  for (const reason of [null, '', 'Network', 'Forwarding', 'unavailable', 'not-a-reason']) {
    expect(allowlisted.has(sshFailureCategory(reason)), `reason ${String(reason)}`).toBe(true);
  }
});

it('reports exactly one outcome per reconnect handoff', () => {
  trackSshReconnect('requires_input');
  expect(captureEvent).toHaveBeenCalledWith(SSH_RECONNECT_EVENT, {
    outcome: 'requires_input',
  });
});

it('reports a failed transfer with its category and a finished one with none', () => {
  trackSshSftpTransfer('upload', 'failed', 'PermissionDenied');
  expect(captureEvent).toHaveBeenCalledWith(SSH_SFTP_TRANSFER_EVENT, {
    direction: 'upload',
    outcome: 'failed',
    category: 'permission_denied',
  });

  captureEvent.mockReset();
  trackSshSftpTransfer('download', 'completed', 'PermissionDenied');
  expect(captureEvent).toHaveBeenCalledWith(SSH_SFTP_TRANSFER_EVENT, {
    direction: 'download',
    outcome: 'completed',
    category: 'none',
  });
});

it('reports forward start and start failure with a direction', () => {
  trackSshForwardStarted('local');
  expect(captureEvent).toHaveBeenCalledWith(SSH_FORWARD_STARTED_EVENT, {
    direction: 'local',
    category: 'none',
  });

  captureEvent.mockReset();
  trackSshForwardFailed('remote', 'Forwarding');
  expect(captureEvent).toHaveBeenCalledWith(SSH_FORWARD_FAILED_EVENT, {
    direction: 'remote',
    category: 'forwarding',
  });
});

it('reports export and import outcomes through the same closed category map', () => {
  trackSshExport('completed', null);
  expect(captureEvent).toHaveBeenCalledWith(SSH_EXPORT_EVENT, {
    outcome: 'completed',
    category: 'none',
  });

  captureEvent.mockReset();
  trackSshImport('failed', 'InvalidExport');
  expect(captureEvent).toHaveBeenCalledWith(SSH_IMPORT_EVENT, {
    outcome: 'failed',
    category: 'invalid_export',
  });

  captureEvent.mockReset();
  trackSshImport('failed', 'file');
  expect(captureEvent).toHaveBeenCalledWith(SSH_IMPORT_EVENT, {
    outcome: 'failed',
    category: 'unknown',
  });
});

it('reports a sandbox terminal outcome', () => {
  trackSshSandboxTerminal('stopped');
  expect(captureEvent).toHaveBeenCalledWith(SSH_SANDBOX_TERMINAL_EVENT, {
    outcome: 'stopped',
  });
});

it('emits only allowlisted property keys and scalar values', () => {
  const allowedKeys = new Set(['category', 'authMethod', 'outcome', 'direction']);
  trackSshSftpTransfer('upload', 'failed', 'Protocol');
  trackSshConnectFailed('key', 'Network');
  for (const call of captureEvent.mock.calls) {
    const properties = call[1] as Record<string, unknown>;
    for (const [key, value] of Object.entries(properties)) {
      expect(allowedKeys.has(key), key).toBe(true);
      expect(['string', 'number', 'boolean']).toContain(typeof value);
    }
  }
});
