import { describe, test, expect } from '@jest/globals';
import {
  createDeviceAuthViewerToken,
  verifyDeviceAuthViewerToken,
} from './device-auth-viewer-token';

describe('device-auth-viewer-token', () => {
  test('creates and verifies a valid token', () => {
    const token = createDeviceAuthViewerToken('ABCD-EFGH', 'user-123');
    const verified = verifyDeviceAuthViewerToken(token);

    expect(verified).not.toBeNull();
    expect(verified!.code).toBe('ABCD-EFGH');
    expect(verified!.userId).toBe('user-123');
  });

  test('returns null for null input', () => {
    expect(verifyDeviceAuthViewerToken(null)).toBeNull();
  });

  test('returns null for empty string', () => {
    expect(verifyDeviceAuthViewerToken('')).toBeNull();
  });

  test('returns null for token without separator', () => {
    expect(verifyDeviceAuthViewerToken('justSomeString')).toBeNull();
  });

  test('returns null for tampered payload', () => {
    const token = createDeviceAuthViewerToken('ABCD-EFGH', 'user-123');
    // Replace the last char of the signature.
    const tampered = token.slice(0, -1) + (token.at(-1) === 'a' ? 'b' : 'a');
    expect(verifyDeviceAuthViewerToken(tampered)).toBeNull();
  });

  test('returns null for token with different code', () => {
    const token = createDeviceAuthViewerToken('ABCD-EFGH', 'user-123');
    // Manually decode, change code, re-encode — verify must fail because the
    // signature only covers the original payload.
    const dotIdx = token.indexOf('.');
    const payload = Buffer.from(token.slice(0, dotIdx), 'base64url').toString('utf8');
    const obj = JSON.parse(payload) as Record<string, unknown>;
    obj.code = 'DIFFERENT';
    const newPayload = Buffer.from(JSON.stringify(obj)).toString('base64url');
    const sig = token.slice(dotIdx + 1);
    expect(verifyDeviceAuthViewerToken(`${newPayload}.${sig}`)).toBeNull();
  });

  test('returns null for token with different userId', () => {
    const token = createDeviceAuthViewerToken('ABCD-EFGH', 'user-123');
    const dotIdx = token.indexOf('.');
    const payload = Buffer.from(token.slice(0, dotIdx), 'base64url').toString('utf8');
    const obj = JSON.parse(payload) as Record<string, unknown>;
    obj.userId = 'attacker';
    const newPayload = Buffer.from(JSON.stringify(obj)).toString('base64url');
    const sig = token.slice(dotIdx + 1);
    expect(verifyDeviceAuthViewerToken(`${newPayload}.${sig}`)).toBeNull();
  });

  test('tokens for different codes are distinct', () => {
    const t1 = createDeviceAuthViewerToken('CODE-1111', 'user-1');
    const t2 = createDeviceAuthViewerToken('CODE-2222', 'user-1');
    expect(t1).not.toBe(t2);
  });

  test('tokens for different users are distinct', () => {
    const t1 = createDeviceAuthViewerToken('CODE-1111', 'user-a');
    const t2 = createDeviceAuthViewerToken('CODE-1111', 'user-b');
    expect(t1).not.toBe(t2);
  });
});
