import { describe, expect, it, vi } from 'vitest';
import { createControlPlaneCredential } from '../sandbox-control/managed-credential.js';
import { classifyScmAuthorization } from '../scm-broker/authorization.js';
import { substituteNetworkSecrets } from './substitution.js';

const alias = createControlPlaneCredential('ses-network-test', 'secret');
const secret = {
  type: 'network',
  key: 'SERVICE_TOKEN',
  value: 'synthetic-real-value',
  allowedHosts: ['api.example.com'],
  locations: ['header'],
};
const sandbox = { containerId: 'synthetic-container' };

describe('network secret substitution', () => {
  it.each([
    ['authorization', `Bearer ${alias}`, `Bearer ${secret.value}`],
    ['x-api-key', alias, secret.value],
    ['x-api-key', `Token="${alias}"`, `Token="${secret.value}"`],
    [
      'authorization',
      `Basic ${Buffer.from(`user:${alias}`).toString('base64')}`,
      `Basic ${Buffer.from(`user:${secret.value}`).toString('base64')}`,
    ],
  ])('substitutes %s without changing the body', async (name, value, expected) => {
    const resolve = vi.fn(async () => secret);
    const result = await substituteNetworkSecrets(
      new Request('https://api.example.com/path', {
        method: 'POST',
        headers: { [name]: value },
        body: 'unchanged',
      }),
      sandbox,
      resolve
    );
    expect(result.type).toBe('rewritten');
    if (result.type !== 'rewritten') throw new Error('Expected rewritten request');
    expect(result.request.headers.get(name)).toBe(expected);
    expect(result.request.headers.get('host')).toBe('api.example.com');
    expect(result.request.redirect).toBe('manual');
    expect(await result.request.text()).toBe('unchanged');
    expect(result.audit).toEqual([
      { credentialKey: 'SERVICE_TOKEN', credentialDecision: 'substituted' },
    ]);
    expect(JSON.stringify(result.audit)).not.toContain(alias);
    expect(JSON.stringify(result.audit)).not.toContain(secret.value);
    expect(resolve).toHaveBeenCalledOnce();
  });
  it.each([
    'https://other.example.com/',
    'https://sub.api.example.com/',
    'https://api.example.com:8443/',
    'http://api.example.com/',
  ])('denies the destination %s', async url => {
    const result = await substituteNetworkSecrets(
      new Request(url, { headers: { authorization: `Bearer ${alias}` } }),
      sandbox,
      async () => secret
    );
    expect(result.type).toBe('denied');
    if (result.type !== 'denied') throw new Error('Expected denial');
    expect(result.response.status).toBe(403);
    expect(await result.response.json()).toMatchObject({
      error: 'network_secret_host_mismatch',
      key: 'SERVICE_TOKEN',
    });
  });
  it.each([null, { ...secret, value: 'invalid\r\nvalue' }])(
    'denies an unknown or invalid resolution',
    async resolution => {
      const result = await substituteNetworkSecrets(
        new Request('https://api.example.com/', { headers: { 'x-api-key': alias } }),
        sandbox,
        async () => resolution
      );
      expect(result.type).toBe('denied');
      if (result.type !== 'denied') throw new Error('Expected denial');
      const body = await result.response.text();
      expect(body).toContain(
        resolution === null ? 'network_secret_unknown' : 'network_secret_unavailable'
      );
      expect(body).not.toContain(alias);
      expect(body).not.toContain(secret.value);
    }
  );
  it('does not replace an alias embedded in another token', async () => {
    const result = await substituteNetworkSecrets(
      new Request('https://api.example.com/', { headers: { 'x-api-key': `prefix${alias}suffix` } }),
      sandbox,
      async () => secret
    );
    expect(result.type).toBe('denied');
  });
  it('reports a transient resolver fault as retryable without forwarding', async () => {
    const result = await substituteNetworkSecrets(
      new Request('https://api.example.com/', { headers: { authorization: `Bearer ${alias}` } }),
      sandbox,
      async () => {
        throw Object.assign(new Error('synthetic transport fault'), { retryable: true });
      }
    );
    if (result.type !== 'denied') throw new Error('Expected denial');
    expect(result.response.status).toBe(503);
    expect(await result.response.json()).toMatchObject({
      error: 'network_secret_unavailable',
      retryable: true,
    });
    expect(result.audit).toEqual([{ credentialDecision: 'unavailable' }]);
  });
  it.each([
    { url: `https://api.example.com/?token=${encodeURIComponent(alias)}`, headers: new Headers() },
    {
      url: 'https://api.example.com/',
      headers: new Headers({ host: alias, 'x-api-key': alias }),
    },
    {
      url: 'https://api.example.com/',
      headers: new Headers({
        authorization: `Basic ${Buffer.from(`${alias}:password`).toString('base64')}`,
      }),
    },
  ])('rejects an unsupported location', async input => {
    const resolve = vi.fn(async () => secret);
    const result = await substituteNetworkSecrets(
      new Request(input.url, { headers: input.headers }),
      sandbox,
      resolve
    );
    expect(result.type).toBe('denied');
    if (result.type !== 'denied') throw new Error('Expected denial');
    expect(await result.response.json()).toMatchObject({ error: 'network_secret_location_denied' });
    expect(resolve).not.toHaveBeenCalled();
  });
  it.each([
    ['a control-plane alias', createControlPlaneCredential('ses-network-test', 'github')],
    ['a capability', 'kgh2.synthetic-capability'],
    ['an unknown control-plane purpose', `kcp1.c2VzLW5ldHdvcmstdGVzdA.future.${'0'.repeat(64)}`],
  ])('denies %s mixed with a network secret before resolution', async (_name, managed) => {
    const resolve = vi.fn();
    const result = await substituteNetworkSecrets(
      new Request('https://api.example.com/', {
        headers: {
          'x-api-key': alias,
          authorization: `Bearer ${managed}`,
        },
      }),
      sandbox,
      resolve
    );
    expect(result.type).toBe('denied');
    expect(resolve).not.toHaveBeenCalled();
  });
  it('substitutes two distinct aliases for one host atomically', async () => {
    const other = createControlPlaneCredential('ses-network-test', 'secret');
    const result = await substituteNetworkSecrets(
      new Request('https://api.example.com/', {
        headers: { 'x-key': alias, 'x-other-key': other },
      }),
      sandbox,
      async input => ({ ...secret, key: input.credential === alias ? 'FIRST' : 'SECOND' })
    );
    expect(result.type).toBe('rewritten');
    if (result.type !== 'rewritten') throw new Error('Expected rewritten request');
    expect(result.audit).toHaveLength(2);
  });
  it('does not recommend retry for a fixed resolver configuration fault', async () => {
    const result = await substituteNetworkSecrets(
      new Request('https://api.example.com/', { headers: { authorization: `Bearer ${alias}` } }),
      sandbox,
      async () => {
        throw Object.assign(new Error('configuration unavailable'), { retryable: false });
      }
    );
    if (result.type !== 'denied') throw new Error('Expected denial');
    expect(result.response.status).toBe(503);
    expect(await result.response.json()).toMatchObject({
      error: 'network_secret_unavailable',
      retryable: false,
    });
  });
  it('explains a stale build placeholder without exposing it', async () => {
    const buildAlias = createControlPlaneCredential(
      'environment-build:11111111-1111-4111-8111-111111111111',
      'secret'
    );
    const result = await substituteNetworkSecrets(
      new Request('https://api.example.com/', {
        headers: { authorization: `Bearer ${buildAlias}` },
      }),
      sandbox,
      async () => null
    );
    if (result.type !== 'denied') throw new Error('Expected denial');
    const body = await result.response.text();
    expect(body).toContain('network_secret_build_scope_denied');
    expect(body).not.toContain(buildAlias);
  });
  it('leaves caller-owned credentials unchanged', async () => {
    const resolve = vi.fn();
    expect(
      await substituteNetworkSecrets(
        new Request('https://api.example.com/', {
          headers: { authorization: 'Bearer caller-owned' },
        }),
        sandbox,
        resolve
      )
    ).toEqual({ type: 'unmanaged' });
    expect(resolve).not.toHaveBeenCalled();
  });
  it('keeps network secrets unsupported in the SCM classifier', () => {
    expect(classifyScmAuthorization({ authorization: `Bearer ${alias}` }).type).toBe('denied');
    expect(
      classifyScmAuthorization({
        authorization: `Basic ${Buffer.from(`x-access-token:${alias}`).toString('base64')}`,
      }).type
    ).toBe('denied');
    expect(classifyScmAuthorization({ privateToken: alias }).type).toBe('denied');
  });
});
