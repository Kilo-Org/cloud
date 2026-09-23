/**
 * Unit tests for the `/test/*` admin guard shared by both fake LLM runtimes.
 */

import { describe, expect, it } from 'vitest';

import {
  LOCAL_FAKE_LLM_ADMIN_TOKEN,
  isAdminAuthorized,
  resolveFakeAdminToken,
} from '../../e2e/fake-llm-admin.js';

describe('resolveFakeAdminToken', () => {
  it('prefers an explicitly configured token', () => {
    expect(resolveFakeAdminToken({ FAKE_LLM_ADMIN_TOKEN: 'configured-token' })).toBe(
      'configured-token'
    );
  });

  it('falls back to the insecure development default', () => {
    expect(resolveFakeAdminToken({})).toBe(LOCAL_FAKE_LLM_ADMIN_TOKEN);
    // The no-arg default reads process.env, so hide any ambient configured
    // token for a deterministic assertion, then restore it.
    const previous = process.env.FAKE_LLM_ADMIN_TOKEN;
    delete process.env.FAKE_LLM_ADMIN_TOKEN;
    try {
      expect(resolveFakeAdminToken()).toBe(LOCAL_FAKE_LLM_ADMIN_TOKEN);
    } finally {
      if (previous === undefined) delete process.env.FAKE_LLM_ADMIN_TOKEN;
      else process.env.FAKE_LLM_ADMIN_TOKEN = previous;
    }
  });

  it('keeps an explicitly empty token empty instead of using the default', () => {
    // The empty value must reach `isAdminAuthorized` so it fails closed; a
    // silent fallback to the known default would be worse.
    expect(resolveFakeAdminToken({ FAKE_LLM_ADMIN_TOKEN: '' })).toBe('');
  });
});

describe('isAdminAuthorized', () => {
  const token = 'configured-admin-token';

  it('accepts exactly the configured bearer', () => {
    expect(isAdminAuthorized(`Bearer ${token}`, token)).toBe(true);
    expect(isAdminAuthorized(`bearer ${token}`, token)).toBe(true);
  });

  it('rejects missing, malformed, empty and wrong credentials', () => {
    expect(isAdminAuthorized(undefined, token)).toBe(false);
    expect(isAdminAuthorized('', token)).toBe(false);
    expect(isAdminAuthorized(token, token)).toBe(false);
    expect(isAdminAuthorized('Bearer', token)).toBe(false);
    expect(isAdminAuthorized('Bearer ', token)).toBe(false);
    expect(isAdminAuthorized('Bearer wrong-token', token)).toBe(false);
    expect(isAdminAuthorized('Basic dXNlcjpwYXNz', token)).toBe(false);
  });

  it('rejects the model credential and the development default when another token is configured', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJ2ZXJzaW9uIjozfQ.signature';
    expect(isAdminAuthorized(`Bearer ${jwt}`, token)).toBe(false);
    expect(isAdminAuthorized(`Bearer ${LOCAL_FAKE_LLM_ADMIN_TOKEN}`, token)).toBe(false);
  });

  it('fails closed when the configured token is missing or empty', () => {
    expect(isAdminAuthorized(`Bearer ${token}`, undefined)).toBe(false);
    expect(isAdminAuthorized(`Bearer ${token}`, '')).toBe(false);
    expect(isAdminAuthorized(`Bearer ${LOCAL_FAKE_LLM_ADMIN_TOKEN}`, '')).toBe(false);
  });
});
