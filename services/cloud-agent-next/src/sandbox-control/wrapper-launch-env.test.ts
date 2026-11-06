import { describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import {
  buildControlWrapperLaunchEnv,
  type ControlWrapperLaunchEnvInput,
} from './wrapper-launch-env.js';
import {
  validateControlLogUploadGrant,
  validateSandboxTransferGrant,
} from './sandbox-transfer-grant.js';

const secret = 'launch-test-secret';
const sandboxId = 'sandbox_test';
const allocationId = 'allocation_test';

function build(overrides: Partial<ControlWrapperLaunchEnvInput> = {}) {
  return buildControlWrapperLaunchEnv({
    workerUrl: 'https://worker.example/',
    sandboxId,
    provider: 'cloudflare',
    credential: 'credential',
    diagnostics: { allocationId, signingSecret: secret },
    ...overrides,
  });
}

describe('buildControlWrapperLaunchEnv', () => {
  it('mints both transfer scopes and a legacy log grant with one wrapper identity', () => {
    const env = build();
    const wrapperInstanceId = env.CONTROL_WRAPPER_INSTANCE_ID;
    expect(wrapperInstanceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(env.SANDBOX_TRANSFER_URL).toBe(
      `https://worker.example/sandbox-transfer/${sandboxId}/${allocationId}/${wrapperInstanceId}`
    );
    expect(env.CONTROL_LOG_UPLOAD_URL).toBe(
      `https://worker.example/sandbox-logs/${sandboxId}/${allocationId}/${wrapperInstanceId}`
    );

    const transfer = validateSandboxTransferGrant(`Bearer ${env.SANDBOX_TRANSFER_GRANT}`, secret);
    expect(transfer?.identity).toEqual({ sandboxId, allocationId, wrapperInstanceId });
    expect(transfer?.scopes).toEqual(['logs', 'workspace_artifacts']);

    expect(validateControlLogUploadGrant(`Bearer ${env.CONTROL_LOG_UPLOAD_GRANT}`, secret)).toEqual(
      { sandboxId, allocationId, wrapperInstanceId }
    );

    const legacy = jwt.decode(env.CONTROL_LOG_UPLOAD_GRANT) as Record<string, unknown>;
    expect(legacy.type).toBe('control_log_upload');
    const current = jwt.decode(env.SANDBOX_TRANSFER_GRANT) as Record<string, unknown>;
    expect(current.type).toBe('sandbox_transfer');
  });

  it('emits no transfer environment without a signing secret', () => {
    const env = build({ diagnostics: { allocationId, signingSecret: null } });
    expect(env).not.toHaveProperty('SANDBOX_TRANSFER_URL');
    expect(env).not.toHaveProperty('CONTROL_LOG_UPLOAD_URL');
    expect(env.SANDBOX_CONTROL_URL).toContain(`/sandbox-control/${sandboxId}`);
  });

  it('emits no transfer environment for an invalid worker origin', () => {
    const env = build({ workerUrl: 'ftp://worker.example' });
    expect(env).not.toHaveProperty('SANDBOX_TRANSFER_URL');
    expect(env).not.toHaveProperty('CONTROL_LOG_UPLOAD_GRANT');
  });
});
