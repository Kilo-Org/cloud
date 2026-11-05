import { describe, expect, it } from 'vitest';
import { validateControlLogUploadGrant } from './log-upload-grant.js';
import { buildControlWrapperLaunchEnv } from './wrapper-launch-env.js';
import { validateWorktreeSnapshotGrant } from './worktree-snapshot-grant.js';

const secret = 'wrapper-launch-env-test-secret';
const input = {
  workerUrl: 'https://worker.example.com',
  sandboxId: 'sandbox_test',
  provider: 'cloudflare' as const,
  credential: 'launch-credential',
  diagnostics: { allocationId: 'allocation_test', signingSecret: secret },
};

describe('control wrapper launch environment', () => {
  it('mints log and snapshot grants with the same wrapper identity', () => {
    const env = buildControlWrapperLaunchEnv({
      ...input,
      worktreeSnapshotWrites: true,
    });
    const wrapperInstanceId = env.CONTROL_WRAPPER_INSTANCE_ID;
    expect(wrapperInstanceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(env.CONTROL_LOG_UPLOAD_URL).toBe(
      `https://worker.example.com/sandbox-logs/sandbox_test/allocation_test/${wrapperInstanceId}`
    );
    expect(env.CONTROL_WORKTREE_SNAPSHOT_URL).toBe(
      `https://worker.example.com/sandbox-worktree-snapshots/sandbox_test/allocation_test/${wrapperInstanceId}`
    );
    const identity = {
      sandboxId: 'sandbox_test',
      allocationId: 'allocation_test',
      wrapperInstanceId,
    };
    expect(validateControlLogUploadGrant(`Bearer ${env.CONTROL_LOG_UPLOAD_GRANT}`, secret)).toEqual(
      identity
    );
    expect(
      validateWorktreeSnapshotGrant(`Bearer ${env.CONTROL_WORKTREE_SNAPSHOT_GRANT}`, secret)
    ).toEqual(identity);
  });

  it('leaves snapshot variables unset when writes are disabled', () => {
    const env = buildControlWrapperLaunchEnv(input);
    expect(env.CONTROL_LOG_UPLOAD_URL).toBeDefined();
    expect(env.CONTROL_LOG_UPLOAD_GRANT).toBeDefined();
    expect(env.CONTROL_WORKTREE_SNAPSHOT_URL).toBeUndefined();
    expect(env.CONTROL_WORKTREE_SNAPSHOT_GRANT).toBeUndefined();
  });

  it('emits no grants without a diagnostics signing secret', () => {
    const env = buildControlWrapperLaunchEnv({
      ...input,
      diagnostics: undefined,
      worktreeSnapshotWrites: true,
    });
    expect(env.CONTROL_LOG_UPLOAD_URL).toBeUndefined();
    expect(env.CONTROL_WORKTREE_SNAPSHOT_URL).toBeUndefined();
    expect(env.CONTROL_WORKTREE_SNAPSHOT_GRANT).toBeUndefined();
    expect(env.CONTROL_WRAPPER_INSTANCE_ID).toBeUndefined();
  });

  it('emits no diagnostic grants for an invalid worker origin', () => {
    const env = buildControlWrapperLaunchEnv({
      ...input,
      workerUrl: 'https://user:pass@worker.example.com',
      worktreeSnapshotWrites: true,
    });
    expect(env.CONTROL_LOG_UPLOAD_URL).toBeUndefined();
    expect(env.CONTROL_WORKTREE_SNAPSHOT_URL).toBeUndefined();
  });
});
