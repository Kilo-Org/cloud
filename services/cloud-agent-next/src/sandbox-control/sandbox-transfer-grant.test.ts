import { describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import {
  CONTROL_LOG_GRANT_SECONDS,
  SANDBOX_TRANSFER_GRANT_AUDIENCE,
  SANDBOX_TRANSFER_GRANT_SECONDS,
} from '../shared/control-diagnostics.js';
import {
  mintControlLogUploadGrant,
  mintSandboxTransferGrant,
  validateControlLogUploadGrant,
  validateSandboxTransferGrant,
} from './sandbox-transfer-grant.js';

const secret = 'transfer-test-secret';
const identity = {
  sandboxId: 'sandbox_test',
  allocationId: 'allocation_test',
  wrapperInstanceId: '0fce125c-54a3-4143-b503-b7775c4d2135',
};

describe('sandbox transfer grants', () => {
  it('mints both scopes with the transfer audience and a short lifetime', () => {
    const minted = mintSandboxTransferGrant(identity, ['logs', 'workspace_artifacts'], secret);
    const payload = jwt.decode(minted.grant) as Record<string, unknown>;
    expect(payload).toMatchObject({
      type: 'sandbox_transfer',
      aud: SANDBOX_TRANSFER_GRANT_AUDIENCE,
      identity,
      scopes: ['logs', 'workspace_artifacts'],
    });
    expect(Number(payload.exp) - Number(payload.iat)).toBe(SANDBOX_TRANSFER_GRANT_SECONDS);
    expect(minted.expiresAt).toBeGreaterThan(Date.now());

    expect(validateSandboxTransferGrant(`Bearer ${minted.grant}`, secret)).toEqual({
      identity,
      scopes: ['logs', 'workspace_artifacts'],
      expiresAt: Number(payload.exp) * 1000,
    });
  });

  it('keeps scopes separate', () => {
    const minted = mintSandboxTransferGrant(identity, ['workspace_artifacts'], secret);
    expect(validateSandboxTransferGrant(`Bearer ${minted.grant}`, secret)?.scopes).toEqual([
      'workspace_artifacts',
    ]);
  });

  it('rejects a mismatched identity, audience, or type', () => {
    const minted = mintSandboxTransferGrant(identity, ['logs'], secret);
    expect(
      validateSandboxTransferGrant(
        `Bearer ${minted.grant}`,
        'a different secret that must not verify the signature'
      )
    ).toBeUndefined();

    const wrongAudience = jwt.sign(
      { type: 'sandbox_transfer', identity, scopes: ['logs'] },
      secret,
      { algorithm: 'HS256', audience: 'another-audience', expiresIn: 60 }
    );
    expect(validateSandboxTransferGrant(`Bearer ${wrongAudience}`, secret)).toBeUndefined();

    const oldType = jwt.sign({ type: 'control_log_upload', identity }, secret, {
      algorithm: 'HS256',
      audience: SANDBOX_TRANSFER_GRANT_AUDIENCE,
      expiresIn: 60,
    });
    expect(validateSandboxTransferGrant(`Bearer ${oldType}`, secret)).toBeUndefined();
  });

  it('rejects a grant whose declared lifetime exceeds the transfer bound', () => {
    const now = Math.floor(Date.now() / 1000);
    const overlong = jwt.sign(
      {
        type: 'sandbox_transfer',
        identity,
        scopes: ['logs'],
        iat: now,
        exp: now + SANDBOX_TRANSFER_GRANT_SECONDS + 1,
      },
      secret,
      { algorithm: 'HS256', audience: SANDBOX_TRANSFER_GRANT_AUDIENCE }
    );
    expect(validateSandboxTransferGrant(`Bearer ${overlong}`, secret)).toBeUndefined();
  });

  it('rejects an overlong authorization header', () => {
    const minted = mintSandboxTransferGrant(identity, ['logs'], secret);
    expect(validateSandboxTransferGrant(`Bearer ${'a'.repeat(4097)}`, secret)).toBeUndefined();
    expect(validateSandboxTransferGrant(`Bearer ${minted.grant}`, secret)).toBeDefined();
  });

  it('validates legacy control log grants only through the legacy validator', () => {
    const legacy = mintControlLogUploadGrant(identity, secret);
    const payload = jwt.decode(legacy) as Record<string, unknown>;
    expect(payload).toMatchObject({ type: 'control_log_upload', identity });
    expect(Number(payload.exp) - Number(payload.iat)).toBe(CONTROL_LOG_GRANT_SECONDS);
    expect(validateControlLogUploadGrant(`Bearer ${legacy}`, secret)).toEqual(identity);
    expect(validateSandboxTransferGrant(`Bearer ${legacy}`, secret)).toBeUndefined();
  });
});
