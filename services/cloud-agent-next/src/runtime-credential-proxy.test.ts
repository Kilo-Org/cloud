import { describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import {
  createRuntimeProxyGrant,
  issueRuntimeCredentialProxyHandle,
  matchesRuntimeProxyGrant,
  runtimeCredentialProxyBaseUrl,
  runtimeCredentialProxyUpstream,
  verifyRuntimeCredentialProxyHandle,
} from './runtime-credential-proxy.js';
import { resolveRuntimeCredentialProxyRoute } from './kilo/runtime-credential-proxy-routes.js';

const targets = {
  backendBaseUrl: 'https://backend.example.test/base',
  providerBaseUrl: 'https://provider.example.test/api/openrouter',
  sessionIngestBaseUrl: 'https://ingest.example.test',
};

describe('runtime credential proxy', () => {
  it('issues a bounded strict handle for an active runtime proxy grant', async () => {
    const env = { NEXTAUTH_SECRET: 'test-secret' } as never;
    const now = Date.now();
    const grant = createRuntimeProxyGrant({
      authorizationId: '11111111-1111-4111-8111-111111111111',
      sessionId: 'agent_1',
      kiloSessionId: 'kilo_1',
      userId: 'user_1',
      mode: 'contained',
      generation: 1,
      allocationId: 'allocation_1',
      leaseExpiresAt: now + 60_000,
      state: 'active',
    });
    const handle = await issueRuntimeCredentialProxyHandle(env, grant);

    const claims = await verifyRuntimeCredentialProxyHandle(env, handle);
    expect(claims).toMatchObject({
      aud: 'cloud-agent-next:runtime-credential-proxy',
      grantId: grant.grantId,
      authorizationId: grant.authorizationId,
      sessionId: grant.sessionId,
      kiloSessionId: grant.kiloSessionId,
      userId: grant.userId,
      nonce: grant.nonce,
      exp: Math.floor(grant.leaseExpiresAt / 1000),
    });
    expect(claims?.iat).toBeGreaterThan(0);
    expect(
      claims &&
        matchesRuntimeProxyGrant(grant, claims, {
          authorizationId: grant.authorizationId,
          sessionId: grant.sessionId,
          kiloSessionId: grant.kiloSessionId,
          userId: grant.userId,
          generation: grant.generation,
          allocationId: grant.allocationId,
          now,
        })
    ).toBe(true);
    await expect(verifyRuntimeCredentialProxyHandle(env, `${handle}x`)).resolves.toBeNull();
  });

  it('rejects expired, unsigned, non-HS256, and unknown claims', async () => {
    const env = { NEXTAUTH_SECRET: 'test-secret' } as never;
    const expired = createRuntimeProxyGrant({
      authorizationId: '11111111-1111-4111-8111-111111111111',
      sessionId: 'agent_1',
      kiloSessionId: 'kilo_1',
      userId: 'user_1',
      mode: 'direct',
      generation: 1,
      allocationId: 'allocation_1',
      leaseExpiresAt: Date.now() - 1,
      state: 'active',
    });
    await expect(issueRuntimeCredentialProxyHandle(env, expired)).rejects.toThrow('has expired');
    await expect(
      verifyRuntimeCredentialProxyHandle(env, 'eyJhbGciOiJub25lIn0.e30.')
    ).resolves.toBeNull();
    const claims = {
      aud: 'cloud-agent-next:runtime-credential-proxy',
      grantId: '11111111-1111-4111-8111-111111111111',
      authorizationId: '22222222-2222-4222-8222-222222222222',
      sessionId: 'agent_1',
      kiloSessionId: 'kilo_1',
      userId: 'user_1',
      nonce: 'a'.repeat(43),
      iat: Math.floor(Date.now() / 1000) - 60,
      exp: Math.floor(Date.now() / 1000) - 1,
    };
    await expect(
      verifyRuntimeCredentialProxyHandle(
        env,
        jwt.sign(claims, 'test-secret', { algorithm: 'HS256' })
      )
    ).resolves.toBeNull();
    await expect(
      verifyRuntimeCredentialProxyHandle(
        env,
        jwt.sign({ ...claims, exp: claims.iat + 120, extra: true }, 'test-secret', {
          algorithm: 'HS256',
        })
      )
    ).resolves.toBeNull();
    await expect(
      verifyRuntimeCredentialProxyHandle(
        env,
        jwt.sign({ ...claims, exp: claims.iat + 120 }, 'test-secret', { algorithm: 'HS384' })
      )
    ).resolves.toBeNull();
  });

  it('maps only exact method-scoped provider, backend, and ingest routes', () => {
    expect(runtimeCredentialProxyBaseUrl('https://worker.example.test/root/')).toBe(
      'https://worker.example.test/root/api/runtime-credential-proxy'
    );
    expect(
      runtimeCredentialProxyUpstream(
        targets,
        'provider',
        'POST',
        'chat/completions',
        '?stream=true',
        'agent_1'
      )?.toString()
    ).toBe('https://provider.example.test/api/openrouter/chat/completions?stream=true');
    expect(
      runtimeCredentialProxyUpstream(
        targets,
        'backend',
        'GET',
        'api/user',
        '',
        'agent_1'
      )?.toString()
    ).toBe('https://backend.example.test/base/api/user');
    expect(
      runtimeCredentialProxyUpstream(
        targets,
        'ingest',
        'POST',
        'api/session/agent_1/ingest',
        '',
        'agent_1'
      )?.toString()
    ).toBe('https://ingest.example.test/api/session/agent_1/ingest');
    expect(
      runtimeCredentialProxyUpstream(targets, 'backend', 'GET', 'trpc/admin', '', 'agent_1')
    ).toBeNull();
    expect(
      runtimeCredentialProxyUpstream(
        targets,
        'ingest',
        'POST',
        'api/session/other/ingest',
        '',
        'agent_1'
      )
    ).toBeNull();
  });

  it('requires exact identity and strict JSON for session creation', () => {
    expect(
      resolveRuntimeCredentialProxyRoute({
        targets,
        route: 'ingest',
        method: 'POST',
        pathname: '/api/session',
        search: '',
        kiloSessionId: 'kilo_1',
        contentType: 'application/json; charset=utf-8',
        bodyText: '{"sessionId":"kilo_1"}',
      })?.toString()
    ).toBe('https://ingest.example.test/api/session');
    for (const body of [
      '{}',
      '{"sessionId":"other"}',
      '{"sessionId":"kilo_1","extra":true}',
      '[]',
    ]) {
      expect(
        resolveRuntimeCredentialProxyRoute({
          targets,
          route: 'ingest',
          method: 'POST',
          pathname: '/api/session',
          search: '',
          kiloSessionId: 'kilo_1',
          contentType: 'application/json',
          bodyText: body,
        })
      ).toBeNull();
    }
  });

  it('fails closed for ambiguous paths and mismatched organization routes', () => {
    for (const pathname of ['/chat%2fcompletions', '/chat%252fcompletions']) {
      expect(
        resolveRuntimeCredentialProxyRoute({
          targets,
          route: 'provider',
          method: 'POST',
          pathname,
          search: '',
          kiloSessionId: 'kilo_1',
        })
      ).toBeNull();
    }
    expect(
      resolveRuntimeCredentialProxyRoute({
        targets,
        route: 'backend',
        method: 'GET',
        pathname: '/api/organizations/other/models',
        search: '',
        kiloSessionId: 'kilo_1',
        organizationId: 'allowed',
      })
    ).toBeNull();
    expect(
      resolveRuntimeCredentialProxyRoute({
        targets,
        route: 'provider',
        method: 'POST',
        pathname: '/embeddings',
        search: '',
        kiloSessionId: 'kilo_1',
      })?.toString()
    ).toBe('https://provider.example.test/api/openrouter/embeddings');
    expect(
      resolveRuntimeCredentialProxyRoute({
        targets: { ...targets, providerBaseUrl: 'ftp://provider.example.test/api/openrouter' },
        route: 'provider',
        method: 'POST',
        pathname: '/embeddings',
        search: '',
        kiloSessionId: 'kilo_1',
      })
    ).toBeNull();
  });
});
