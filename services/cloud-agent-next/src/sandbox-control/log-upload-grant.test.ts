import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import {
  CONTROL_LOG_GRANT_SECONDS,
  type ControlLogIdentity,
} from '../shared/control-diagnostics.js';
import {
  mintControlLogUploadCredential,
  mintControlLogUploadGrant,
  validateControlLogGrantProof,
  validateControlLogRenewal,
  validateControlLogUploadGrant,
} from './log-upload-grant.js';

const secret = 'test-signing-secret';
const identity: ControlLogIdentity = {
  sandboxId: 'sandbox_test',
  allocationId: 'allocation_test',
  wrapperInstanceId: '0fce125c-54a3-4143-b503-b7775c4d2135',
};

function expiredGrant(): string {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      type: 'control_log_upload',
      identity,
      iat: now - CONTROL_LOG_GRANT_SECONDS - 60,
      exp: now - 60,
    },
    secret,
    {
      algorithm: 'HS256',
      audience: 'cloud-agent-control-log-upload',
    }
  );
}

describe('control log upload grants', () => {
  it('mints a bounded credential with its expiry', () => {
    const before = Date.now();
    const credential = mintControlLogUploadCredential(identity, secret);
    expect(credential.expiresAt).toBeGreaterThanOrEqual(
      before + CONTROL_LOG_GRANT_SECONDS * 1000 - 2_000
    );
    expect(credential.expiresAt).toBeLessThanOrEqual(
      Date.now() + CONTROL_LOG_GRANT_SECONDS * 1000 + 2_000
    );
    expect(validateControlLogUploadGrant(`Bearer ${credential.grant}`, secret)).toEqual(identity);
    expect(mintControlLogUploadGrant(identity, secret)).toBeTypeOf('string');
  });

  it('still rejects an expired bearer over ordinary HTTP', () => {
    expect(validateControlLogUploadGrant(`Bearer ${expiredGrant()}`, secret)).toBeUndefined();
  });

  it('accepts an expired signed grant only as renewal proof', () => {
    const proof = expiredGrant();
    expect(validateControlLogGrantProof(proof, secret)).toEqual(identity);
    expect(validateControlLogGrantProof(proof, 'wrong-secret')).toBeUndefined();
    expect(validateControlLogGrantProof(`${proof}x`, secret)).toBeUndefined();
  });

  it('renews only from the current authorized socket for the same allocation', () => {
    const proof = expiredGrant();
    expect(
      validateControlLogRenewal({
        proof,
        secret,
        socketAuthorized: true,
        sandboxId: identity.sandboxId,
        allocationId: identity.allocationId,
      })
    ).toEqual(identity);
  });

  it('rejects renewal from a superseded socket', () => {
    expect(
      validateControlLogRenewal({
        proof: expiredGrant(),
        secret,
        socketAuthorized: false,
        sandboxId: identity.sandboxId,
        allocationId: identity.allocationId,
      })
    ).toBeUndefined();
  });

  it('rejects renewal proof for another allocation or sandbox', () => {
    expect(
      validateControlLogRenewal({
        proof: expiredGrant(),
        secret,
        socketAuthorized: true,
        sandboxId: identity.sandboxId,
        allocationId: 'allocation_other',
      })
    ).toBeUndefined();
    expect(
      validateControlLogRenewal({
        proof: expiredGrant(),
        secret,
        socketAuthorized: true,
        sandboxId: 'sandbox_other',
        allocationId: identity.allocationId,
      })
    ).toBeUndefined();
  });

  it('keeps the launch wrapper instance id rather than the socket wrapper id', () => {
    const renewed = validateControlLogRenewal({
      proof: expiredGrant(),
      secret,
      socketAuthorized: true,
      sandboxId: identity.sandboxId,
      allocationId: identity.allocationId,
    });
    expect(renewed?.wrapperInstanceId).toBe(identity.wrapperInstanceId);
  });
});
