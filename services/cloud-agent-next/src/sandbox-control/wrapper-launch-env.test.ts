import { describe, expect, it } from 'vitest';
import { validateControlLogUploadGrant } from './log-upload-grant.js';
import { buildControlWrapperLaunchEnv } from './wrapper-launch-env.js';

const secret = 'wrapper-launch-env-test-secret';
const input = {
  workerUrl: 'https://worker.example.com',
  sandboxId: 'sandbox_test',
  provider: 'cloudflare' as const,
  credential: 'launch-credential',
  diagnostics: { allocationId: 'allocation_test', signingSecret: secret },
};

describe('control wrapper launch environment', () => {
  it('mints the log grant and keeps the snapshot URL independent of it', () => {
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
      'https://worker.example.com/sandbox-worktree-snapshots/sandbox_test'
    );
    expect(env.CONTROL_WORKTREE_SNAPSHOT_GRANT).toBeUndefined();
    expect(env.SANDBOX_CONTROL_CREDENTIAL).toBe('launch-credential');
    expect(validateControlLogUploadGrant(`Bearer ${env.CONTROL_LOG_UPLOAD_GRANT}`, secret)).toEqual(
      {
        sandboxId: 'sandbox_test',
        allocationId: 'allocation_test',
        wrapperInstanceId,
      }
    );
  });

  it('leaves the snapshot URL unset when writes are disabled', () => {
    const env = buildControlWrapperLaunchEnv(input);
    expect(env.CONTROL_LOG_UPLOAD_URL).toBeDefined();
    expect(env.CONTROL_LOG_UPLOAD_GRANT).toBeDefined();
    expect(env.CONTROL_WORKTREE_SNAPSHOT_URL).toBeUndefined();
  });

  it('emits the snapshot URL without a diagnostics signing secret', () => {
    const env = buildControlWrapperLaunchEnv({
      ...input,
      diagnostics: undefined,
      worktreeSnapshotWrites: true,
    });
    expect(env.CONTROL_LOG_UPLOAD_URL).toBeUndefined();
    expect(env.CONTROL_LOG_UPLOAD_GRANT).toBeUndefined();
    expect(env.CONTROL_WRAPPER_INSTANCE_ID).toBeUndefined();
    expect(env.CONTROL_WORKTREE_SNAPSHOT_URL).toBe(
      'https://worker.example.com/sandbox-worktree-snapshots/sandbox_test'
    );
  });

  it('emits no snapshot URL for an invalid worker origin', () => {
    const credentialedOrigin = new URL('https://worker.example.com');
    credentialedOrigin.username = 'user';
    credentialedOrigin.password = 'fixture';
    const env = buildControlWrapperLaunchEnv({
      ...input,
      workerUrl: credentialedOrigin.toString(),
      worktreeSnapshotWrites: true,
    });
    expect(env.CONTROL_LOG_UPLOAD_URL).toBeUndefined();
    expect(env.CONTROL_WORKTREE_SNAPSHOT_URL).toBeUndefined();
  });
});
