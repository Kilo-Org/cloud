import { describe, expect, test } from '@jest/globals';
import { resolveServiceSenderAuth, type VercelRuntime } from './service-sender-auth';

const PRODUCTION = { VERCEL_ENV: 'production', VERCEL_TARGET_ENV: 'production' };
const STAGING = { VERCEL_ENV: 'preview', VERCEL_TARGET_ENV: 'staging' };
const PREVIEW = { VERCEL_ENV: 'preview', VERCEL_TARGET_ENV: 'preview' };
const VERCEL_DEVELOPMENT = { VERCEL_ENV: 'development', VERCEL_TARGET_ENV: 'development' };
const LOCAL = {};
const HTTPS_URL = 'https://receiver.example.test';
const LOCAL_URL = 'http://localhost:8789';

const resolve = (auth: string | undefined, runtime: VercelRuntime, url = HTTPS_URL) =>
  resolveServiceSenderAuth({ auth, url, runtime });

describe('resolveServiceSenderAuth', () => {
  test.each([
    ['Vercel production', PRODUCTION],
    ['staging', STAGING],
    ['a preview', PREVIEW],
    ['Vercel development', VERCEL_DEVELOPMENT],
    ['a process outside Vercel', LOCAL],
  ])('unset, empty or legacy is legacy on %s', (_name, runtime) => {
    expect(resolve(undefined, runtime)).toEqual({ kind: 'legacy' });
    expect(resolve('', runtime)).toEqual({ kind: 'legacy' });
    expect(resolve('legacy', runtime)).toEqual({ kind: 'legacy' });
  });

  test.each(['dual', 'STS', 'Legacy', ' sts', 'sts ', 'true', 'off', 'binding'])(
    'refuses %j',
    auth => {
      expect(resolve(auth, PRODUCTION)).toEqual({ kind: 'refused', reason: 'invalid_auth' });
    }
  );

  test.each([
    ['staging', STAGING],
    ['a preview', PREVIEW],
    ['Vercel development', VERCEL_DEVELOPMENT],
  ])('explicit sts on %s is refused: no receiver verifies its tokens', (_name, runtime) => {
    expect(resolve('sts', runtime)).toEqual({ kind: 'refused', reason: 'sts_production_only' });
  });

  test('production sends a token only over https', () => {
    expect(resolve('sts', PRODUCTION)).toEqual({ kind: 'sts', environment: 'production' });
    for (const url of ['http://receiver.example.test', LOCAL_URL, '', 'not a url']) {
      expect(resolve('sts', PRODUCTION, url)).toEqual({ kind: 'refused', reason: 'insecure_url' });
    }
  });

  test('local development sends a development token only to a loopback address', () => {
    for (const url of [LOCAL_URL, 'http://127.0.0.1:8800', 'http://[::1]:8800']) {
      expect(resolve('sts', LOCAL, url)).toEqual({ kind: 'sts', environment: 'development' });
    }
    for (const url of [HTTPS_URL, 'http://receiver.example.test', '']) {
      expect(resolve('sts', LOCAL, url)).toEqual({ kind: 'refused', reason: 'insecure_url' });
    }
  });
});
