import { describe, expect, it } from 'vitest';
import {
  issueRuntimeCredentialProxyHandle,
  runtimeCredentialProxyBaseUrl,
  runtimeCredentialProxyUpstream,
  verifyRuntimeCredentialProxyHandle,
} from './runtime-credential-proxy.js';

const targets = {
  backendBaseUrl: 'https://backend.example.test/base',
  providerBaseUrl: 'https://provider.example.test/api/openrouter',
  sessionIngestBaseUrl: 'https://ingest.example.test',
};

describe('runtime credential proxy', () => {
  it('issues a stable opaque handle and verifies only its signed session scope', async () => {
    const env = { NEXTAUTH_SECRET: 'test-secret' } as never;
    const first = await issueRuntimeCredentialProxyHandle(env, {
      sessionId: 'agent_1',
      userId: 'user_1',
    });
    const second = await issueRuntimeCredentialProxyHandle(env, {
      sessionId: 'agent_1',
      userId: 'user_1',
    });

    expect(first).toBe(second);
    await expect(verifyRuntimeCredentialProxyHandle(env, first)).resolves.toEqual({
      sessionId: 'agent_1',
      userId: 'user_1',
    });
    await expect(verifyRuntimeCredentialProxyHandle(env, `${first}x`)).resolves.toBeNull();
  });

  it('maps only the provider, backend, and scoped ingest routes', () => {
    expect(runtimeCredentialProxyBaseUrl('https://worker.example.test/root/')).toBe(
      'https://worker.example.test/root/api/runtime-credential-proxy'
    );
    expect(
      runtimeCredentialProxyUpstream(
        targets,
        'provider',
        'chat/completions',
        '?stream=true',
        'agent_1'
      )?.toString()
    ).toBe('https://provider.example.test/api/openrouter/chat/completions?stream=true');
    expect(
      runtimeCredentialProxyUpstream(targets, 'backend', 'api/user', '', 'agent_1')?.toString()
    ).toBe('https://backend.example.test/base/api/user');
    expect(
      runtimeCredentialProxyUpstream(
        targets,
        'ingest',
        'api/session/agent_1/ingest',
        '',
        'agent_1'
      )?.toString()
    ).toBe('https://ingest.example.test/api/session/agent_1/ingest');
    expect(
      runtimeCredentialProxyUpstream(targets, 'backend', 'trpc/admin', '', 'agent_1')
    ).toBeNull();
    expect(
      runtimeCredentialProxyUpstream(targets, 'ingest', 'api/session/other/ingest', '', 'agent_1')
    ).toBeNull();
  });
});
