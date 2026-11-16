import { describe, expect, it, vi } from 'vitest';
import { readProxyTaskCredentials, TaskCredentialsError } from './task-credentials.js';
const path = '/v2/credentials/11111111-1111-4111-8111-111111111111';
const metadata = {
  AccessKeyId: 'ASIATEST000000000000',
  SecretAccessKey: 'task-secret',
  Token: 'task-session',
  Expiration: '2026-11-15T01:00:00.000Z',
  RoleArn: 'arn:aws:iam::123456789012:role/proxy',
};
const now = Date.parse('2026-11-15T00:00:00.000Z');
describe('proxy task role source', () => {
  it('accepts the task endpoint and returns only bounded-lifetime credentials', async () => {
    const fetch = vi.fn(async (_path: string, _signal: AbortSignal) => metadata);
    await expect(readProxyTaskCredentials(path, fetch, now)).resolves.toEqual({
      accessKeyId: metadata.AccessKeyId,
      secretAccessKey: metadata.SecretAccessKey,
      sessionToken: metadata.Token,
      expiresAt: Date.parse(metadata.Expiration),
    });
    expect(fetch.mock.calls[0][0]).toBe(path);
    expect(fetch.mock.calls[0][1]).toBeInstanceOf(AbortSignal);
  });
  it.each([
    undefined,
    'http://attacker.example/role',
    '//attacker.example/role',
    '/v2/credentials/../other',
    path + '?redirect=other',
    path + '\r\nHost: other',
  ])('refuses an untrusted metadata URI %s', async uri => {
    const fetch = vi.fn(async () => metadata);
    await expect(readProxyTaskCredentials(uri, fetch, now)).rejects.toMatchObject({
      code: 'invalid',
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('recovers a transient metadata failure within a bound', async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error('transport failed'))
      .mockResolvedValue(metadata);
    await expect(readProxyTaskCredentials(path, fetch, now)).resolves.toHaveProperty(
      'accessKeyId',
      metadata.AccessKeyId
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('refuses malformed and expiring authority', async () => {
    await expect(
      readProxyTaskCredentials(path, async () => ({ ...metadata, Token: '' }), now)
    ).rejects.toBeInstanceOf(TaskCredentialsError);
    await expect(
      readProxyTaskCredentials(path, async () => metadata, Date.parse(metadata.Expiration) - 1000)
    ).rejects.toMatchObject({ code: 'expiring' });
  });
});
