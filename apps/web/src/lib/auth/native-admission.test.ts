jest.mock('@sentry/nextjs', () => ({
  captureMessage: jest.fn(),
}));

import { describe, test, expect, beforeEach } from '@jest/globals';
import { checkNativeAdmission } from './native-admission';
import { captureMessage } from '@sentry/nextjs';

const mockCaptureMessage = jest.mocked(captureMessage);

// The module reads NATIVE_ADMISSION_MODE from env; we set it before each test.
const setMode = (mode: string) => {
  process.env.NATIVE_ADMISSION_MODE = mode;
};

describe('checkNativeAdmission', () => {
  beforeEach(() => {
    delete process.env.NATIVE_ADMISSION_MODE;
    jest.clearAllMocks();
  });

  describe('mode: off', () => {
    test('admits with any body', () => {
      setMode('off');
      expect(checkNativeAdmission({})).toEqual({ ok: true });
    });

    test('admits with a body that has admission field', () => {
      setMode('off');
      expect(checkNativeAdmission({ admission: { foo: 'bar' } })).toEqual({ ok: true });
    });
  });

  describe('mode: report', () => {
    test('admits with any body (no provider yet)', () => {
      setMode('report');
      expect(checkNativeAdmission({})).toEqual({ ok: true });
    });
  });

  describe('mode: undefined (unset)', () => {
    test('admits everything (off is the default)', () => {
      // No mode set at all
      expect(checkNativeAdmission({})).toEqual({ ok: true });
    });
  });

  describe('mode: enforce', () => {
    beforeEach(() => {
      setMode('enforce');
    });

    test('absent admission field admits and increments legacy counter', () => {
      const result = checkNativeAdmission({ provider: 'google', idToken: 'abc' });
      expect(result).toEqual({ ok: true });
      expect(mockCaptureMessage).toHaveBeenCalledWith('native_admission_legacy_count: 1');
    });

    test('present admission field is refused (no provider in this commit)', () => {
      const result = checkNativeAdmission({
        provider: 'google',
        idToken: 'abc',
        admission: { some: 'data' },
      });
      expect(result).toEqual({ ok: false, errorCode: 'ADMISSION_REQUIRED' });
    });

    test('present but null admission field is refused', () => {
      const result = checkNativeAdmission({
        provider: 'google',
        idToken: 'abc',
        admission: null,
      });
      // null !== undefined, so 'admission' in body is true and body.admission !== undefined is true
      // Wait — the check is 'admission' in body && body['admission'] !== undefined.
      // null !== undefined is true, so the field is "present".
      // No provider exists, so it fails closed.
      expect(result).toEqual({ ok: false, errorCode: 'ADMISSION_REQUIRED' });
    });

    test('empty object admission is refused', () => {
      const result = checkNativeAdmission({
        provider: 'google',
        idToken: 'abc',
        admission: {},
      });
      expect(result).toEqual({ ok: false, errorCode: 'ADMISSION_REQUIRED' });
    });
  });
});
