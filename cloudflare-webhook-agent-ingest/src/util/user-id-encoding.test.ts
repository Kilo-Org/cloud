import { describe, it, expect } from 'vitest';
import { encodeUserIdForPath, decodeUserIdFromPath } from './user-id-encoding';

describe('encodeUserIdForPath', () => {
  it('passes through a UUID unchanged', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    expect(encodeUserIdForPath(uuid)).toBe(uuid);
  });

  it('encodes an OAuth Google user ID', () => {
    const oauthId = 'oauth/google:101043560986948156510';
    const encoded = encodeUserIdForPath(oauthId);
    expect(encoded).toMatch(/^o-[A-Za-z0-9_-]+$/);
    expect(encoded).not.toContain('/');
  });

  it('encodes an OAuth GitHub user ID', () => {
    const oauthId = 'oauth/github:789456';
    const encoded = encodeUserIdForPath(oauthId);
    expect(encoded).toMatch(/^o-[A-Za-z0-9_-]+$/);
  });

  it('passes through a simple string without slashes', () => {
    expect(encodeUserIdForPath('user123')).toBe('user123');
  });
});

describe('decodeUserIdFromPath', () => {
  it('passes through a UUID unchanged', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    expect(decodeUserIdFromPath(uuid)).toBe(uuid);
  });

  it('passes through a simple string unchanged', () => {
    expect(decodeUserIdFromPath('user123')).toBe('user123');
  });

  it('decodes an o- prefixed value', () => {
    const oauthId = 'oauth/google:101043560986948156510';
    const encoded = encodeUserIdForPath(oauthId);
    expect(decodeUserIdFromPath(encoded)).toBe(oauthId);
  });
});

describe('roundtrip', () => {
  const testIds = [
    '550e8400-e29b-41d4-a716-446655440000',
    'oauth/google:101043560986948156510',
    'oauth/github:789456',
    'oauth/gitlab:12345',
    'simple-id',
  ];

  for (const id of testIds) {
    it(`roundtrips: ${id}`, () => {
      expect(decodeUserIdFromPath(encodeUserIdForPath(id))).toBe(id);
    });
  }
});
