import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ProbeError, connectFailure, probeStatementFailure } from '../../container/src/session.ts';
import { GithubUnavailableError, createGithubClient } from '../../src/github';

describe('GitHub calls', () => {
  it('give up after the request timeout as a network failure, compare calls included', async () => {
    // A GitHub that never answers: the only way out is the request's own abort signal.
    const hanging = (_url: string, init: RequestInit) => {
      const { promise, reject } = Promise.withResolvers<Response>();
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      return promise;
    };
    const pem = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    }).privateKey;
    const client = createGithubClient(
      {
        appId: '1',
        installationId: '2',
        apiUrl: 'https://api.github.com',
        privateKey: async () => pem,
      },
      hanging,
      Date.now,
      50
    );
    const failure = await client
      .compare('a'.repeat(40), 'b'.repeat(40))
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GithubUnavailableError);
  });
});

describe('probe failure classes (§6 step 2)', () => {
  it('reads a full connection limit at login (53300) as connect_timeout, which is retryable', () => {
    const failure = connectFailure(
      Object.assign(new Error('too many connections'), { code: '53300' })
    );
    expect(failure).toMatchObject({ reason: 'connect_timeout', sqlstate: '53300' });
  });

  it('reads a probe statement that never answers as connect_timeout, not a migration failure', () => {
    const failure = probeStatementFailure(new Error('Query read timeout'));
    expect(failure).toBeInstanceOf(ProbeError);
    expect(failure).toMatchObject({ reason: 'connect_timeout' });
    const other = new Error('something else');
    expect(probeStatementFailure(other)).toBe(other);
  });
});
