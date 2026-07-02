import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockInfo, mockWarn, mockWithFields, mockWithTags } = vi.hoisted(() => {
  const info = vi.fn();
  const warn = vi.fn();
  const withFields = vi.fn(() => ({ info, warn }));
  const withTags = vi.fn(() => ({ withFields }));
  return {
    mockInfo: info,
    mockWarn: warn,
    mockWithFields: withFields,
    mockWithTags: withTags,
  };
});

vi.mock('./logger.js', () => ({
  logger: {
    withTags: mockWithTags,
  },
}));

import {
  logWorkspaceBackupDisabled,
  logWorkspaceBackupLifecycle,
} from './workspace-backup-observability.js';

describe('workspace backup observability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('emits a bounded warning when backup configuration is disabled', () => {
    logWorkspaceBackupDisabled('invalid_worker_url');

    expect(mockWithTags).toHaveBeenCalledWith({
      logTag: 'workspace_backup.configuration.disabled',
    });
    expect(mockWithFields).toHaveBeenCalledWith({ reason: 'invalid_worker_url' });
    expect(mockWarn).toHaveBeenCalledWith('workspace_backup.configuration.disabled');
    expect(mockInfo).not.toHaveBeenCalled();
  });

  it('emits a searchable structured start event', () => {
    logWorkspaceBackupLifecycle({ operation: 'restore', outcome: 'started' });

    expect(mockWithTags).toHaveBeenCalledWith({
      logTag: 'workspace_backup.restore.started',
    });
    expect(mockWithFields).toHaveBeenCalledWith({
      operation: 'restore',
      outcome: 'started',
    });
    expect(mockInfo).toHaveBeenCalledWith('workspace_backup.restore.started');
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('emits duration on a completed event', () => {
    logWorkspaceBackupLifecycle({ operation: 'create', outcome: 'completed', durationMs: 42 });

    expect(mockWithTags).toHaveBeenCalledWith({
      logTag: 'workspace_backup.create.completed',
    });
    expect(mockWithFields).toHaveBeenCalledWith({
      operation: 'create',
      outcome: 'completed',
      durationMs: 42,
    });
    expect(mockInfo).toHaveBeenCalledWith('workspace_backup.create.completed');
  });

  it('emits only a bounded category and duration on failure', () => {
    logWorkspaceBackupLifecycle({
      operation: 'restore',
      outcome: 'failed',
      durationMs: 17,
      failureCategory: 'backup_validation_failed',
    });

    expect(mockWithTags).toHaveBeenCalledWith({
      logTag: 'workspace_backup.restore.failed',
    });
    expect(mockWithFields).toHaveBeenCalledWith({
      operation: 'restore',
      outcome: 'failed',
      durationMs: 17,
      failureCategory: 'backup_validation_failed',
    });
    expect(mockWarn).toHaveBeenCalledWith('workspace_backup.restore.failed');
    expect(mockInfo).not.toHaveBeenCalled();
  });

  it('does not let logging failures change backup behavior', () => {
    mockWithTags.mockImplementationOnce(() => {
      throw new Error('logger unavailable');
    });

    expect(() =>
      logWorkspaceBackupLifecycle({ operation: 'create', outcome: 'started' })
    ).not.toThrow();
  });
});
