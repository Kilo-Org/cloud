import { describe, it, expect, beforeEach } from 'vitest';
import { mountR2Storage, userR2Prefix } from './r2';
import {
  createMockEnv,
  createMockEnvWithR2,
  createMockSandbox,
  suppressConsole,
} from '../test-utils';

const TEST_USER_ID = 'user_abc123';

describe('userR2Prefix', () => {
  it('returns a deterministic prefix for the same userId', async () => {
    const a = await userR2Prefix('user_abc123');
    const b = await userR2Prefix('user_abc123');
    expect(a).toBe(b);
  });

  it('returns different prefixes for different userIds', async () => {
    const a = await userR2Prefix('user_abc123');
    const b = await userR2Prefix('user_xyz789');
    expect(a).not.toBe(b);
  });

  it('starts with /users/', async () => {
    const prefix = await userR2Prefix('user_abc123');
    expect(prefix).toMatch(/^\/users\//);
  });

  it('uses URL-safe base64 characters only in the hash portion', async () => {
    const prefix = await userR2Prefix('oauth/google:118234567890');
    // Extract the hash after "/users/"
    const hash = prefix.replace('/users/', '');
    // Hash should not contain standard base64 chars +, /, or =
    expect(hash).not.toMatch(/[+/=]/);
    // Hash should only contain alphanumeric, dash, underscore
    expect(hash).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('produces a consistent length (SHA-256 -> 43 chars base64url + prefix)', async () => {
    const prefix = await userR2Prefix('any-user');
    // "/users/" (7 chars) + base64url(32 bytes) = 7 + 43 = 50 chars
    expect(prefix).toHaveLength(50);
  });

  it('handles special characters in userId', async () => {
    const prefix = await userR2Prefix('user@example.com');
    expect(prefix).toMatch(/^\/users\/[A-Za-z0-9_-]+$/);
  });
});

describe('mountR2Storage', () => {
  beforeEach(() => {
    suppressConsole();
  });

  describe('credential validation', () => {
    it('returns false when R2_ACCESS_KEY_ID is missing', async () => {
      const { sandbox } = createMockSandbox();
      const env = createMockEnv({
        R2_SECRET_ACCESS_KEY: 'secret',
        CF_ACCOUNT_ID: 'account123',
      });

      const result = await mountR2Storage(sandbox, env, TEST_USER_ID);

      expect(result).toBe(false);
    });

    it('returns false when R2_SECRET_ACCESS_KEY is missing', async () => {
      const { sandbox } = createMockSandbox();
      const env = createMockEnv({
        R2_ACCESS_KEY_ID: 'key123',
        CF_ACCOUNT_ID: 'account123',
      });

      const result = await mountR2Storage(sandbox, env, TEST_USER_ID);

      expect(result).toBe(false);
    });

    it('returns false when CF_ACCOUNT_ID is missing', async () => {
      const { sandbox } = createMockSandbox();
      const env = createMockEnv({
        R2_ACCESS_KEY_ID: 'key123',
        R2_SECRET_ACCESS_KEY: 'secret',
      });

      const result = await mountR2Storage(sandbox, env, TEST_USER_ID);

      expect(result).toBe(false);
    });

    it('returns false when all R2 credentials are missing', async () => {
      const { sandbox } = createMockSandbox();
      const env = createMockEnv();

      const result = await mountR2Storage(sandbox, env, TEST_USER_ID);

      expect(result).toBe(false);
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('R2 storage not configured')
      );
    });
  });

  describe('mounting behavior', () => {
    it('mounts R2 bucket with per-user prefix', async () => {
      const { sandbox, mountBucketMock } = createMockSandbox({ mounted: false });
      const env = createMockEnvWithR2({
        R2_ACCESS_KEY_ID: 'key123',
        R2_SECRET_ACCESS_KEY: 'secret',
        CF_ACCOUNT_ID: 'account123',
      });

      const result = await mountR2Storage(sandbox, env, TEST_USER_ID);

      expect(result).toBe(true);
      const expectedPrefix = await userR2Prefix(TEST_USER_ID);
      expect(mountBucketMock).toHaveBeenCalledWith('kiloclaw-data', '/data/openclaw', {
        endpoint: 'https://account123.r2.cloudflarestorage.com',
        credentials: {
          accessKeyId: 'key123',
          secretAccessKey: 'secret',
        },
        prefix: expectedPrefix,
      });
    });

    it('uses custom bucket name from R2_BUCKET_NAME env var', async () => {
      const { sandbox, mountBucketMock } = createMockSandbox({ mounted: false });
      const env = createMockEnvWithR2({
        R2_ACCESS_KEY_ID: 'key123',
        R2_SECRET_ACCESS_KEY: 'secret',
        CF_ACCOUNT_ID: 'account123',
        R2_BUCKET_NAME: 'kiloclaw-e2e-test123',
      });

      const result = await mountR2Storage(sandbox, env, TEST_USER_ID);

      expect(result).toBe(true);
      expect(mountBucketMock).toHaveBeenCalledWith(
        'kiloclaw-e2e-test123',
        '/data/openclaw',
        expect.any(Object)
      );
    });

    it('logs success message when mounted successfully', async () => {
      const { sandbox } = createMockSandbox({ mounted: false });
      const env = createMockEnvWithR2();

      await mountR2Storage(sandbox, env, TEST_USER_ID);

      expect(console.log).toHaveBeenCalledWith('R2 bucket mounted successfully');
    });
  });

  describe('error handling', () => {
    it('returns false when mountBucket throws', async () => {
      const { sandbox, mountBucketMock } = createMockSandbox({ mounted: false });
      mountBucketMock.mockRejectedValue(new Error('Mount failed'));

      const env = createMockEnvWithR2();

      const result = await mountR2Storage(sandbox, env, TEST_USER_ID);

      expect(result).toBe(false);
      expect(console.error).toHaveBeenCalledWith('Failed to mount R2 bucket:', expect.any(Error));
    });
  });
});
