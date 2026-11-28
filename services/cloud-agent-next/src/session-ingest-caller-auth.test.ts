import { describe, expect, it, vi } from 'vitest';
import {
  sessionIngestCallerAuth,
  sessionIngestExportCredential,
} from './session-ingest-caller-auth.js';

function envWith(mode: string | undefined, readable = true) {
  const get = vi.fn(async (): Promise<string> => {
    if (!readable) throw new Error('secrets store unavailable');
    return 'internal-secret';
  });
  const env = { INTERNAL_API_SECRET_PROD: { get }, SESSION_INGEST_CALLER_AUTH: mode };
  return { env, get };
}

describe('SESSION_INGEST_CALLER_AUTH', () => {
  it.each([undefined, '', 'legacy'])('%j is legacy', mode => {
    expect(sessionIngestCallerAuth(envWith(mode).env)).toBe('legacy');
  });

  it('binding is binding', () => {
    expect(sessionIngestCallerAuth(envWith('binding').env)).toBe('binding');
  });

  it.each(['props', 'Binding', ' ', 'sts', 'secrets-store'])('refuses %j', mode => {
    expect(() => sessionIngestCallerAuth(envWith(mode).env)).toThrow(
      'SESSION_INGEST_CALLER_AUTH must be legacy or binding'
    );
  });
});

describe('history export credential', () => {
  it.each([undefined, '', 'legacy'])('%j sends the internal secret, as before', async mode => {
    const { env } = envWith(mode);
    await expect(sessionIngestExportCredential(env)).resolves.toEqual({
      'X-Internal-Secret': 'internal-secret',
    });
  });

  it('legacy with an unreadable secret sends it empty, as before', async () => {
    const { env } = envWith(undefined, false);
    await expect(sessionIngestExportCredential(env)).resolves.toEqual({ 'X-Internal-Secret': '' });
  });

  it('binding sends no credential and never reads the secret', async () => {
    const { env, get } = envWith('binding');
    await expect(sessionIngestExportCredential(env)).resolves.toEqual({});
    expect(get).not.toHaveBeenCalled();
  });

  it('an unknown value fails the hydration closed before the secret is read', async () => {
    const { env, get } = envWith('props');
    await expect(sessionIngestExportCredential(env)).rejects.toThrow(
      'SESSION_INGEST_CALLER_AUTH must be legacy or binding'
    );
    expect(get).not.toHaveBeenCalled();
  });
});
