import { describe, expect, it } from 'vitest';
import { parseSessionMetadata } from '../persistence/session-metadata.js';
import {
  buildControlNetworkPolicy,
  credentialSourceFromMetadata,
  prepareCredentialGrant,
  sessionCredentialsPayloadFromGrant,
  type CredentialGrantPreparation,
} from './session-credentials.js';

const sessionId = 'workspace_11111111-1111-4111-8111-111111111111';
const kiloSessionId = 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa';
const facade = 'https://worker.example.com';

function localPreparation(): CredentialGrantPreparation {
  return {
    env: {
      WORKER_URL: facade,
      KILOCODE_BACKEND_BASE_URL: 'http://localhost:4300',
      KILO_OPENROUTER_BASE: 'http://localhost:4300/api/openrouter',
      KILO_SESSION_INGEST_URL: 'http://localhost:10100',
    } as CredentialGrantPreparation['env'],
    source: {
      userId: 'user-1',
      kiloSessionId,
      kiloToken: 'eyJhbGciOiJub25lIn0.eyJydW50aW1lQXV0aG9yaXphdGlvbiI6eyJpZCI6InJhXzEifX0.c2ln',
      repository: { type: 'git', url: 'https://github.com/acme/widgets.git' },
      scopeId: sessionId,
    },
    sessionId,
    sandboxId: 'ses-abcdef',
    provider: 'vercel',
    containmentEnabled: true,
    directory: '/workspace/test',
    scopeId: sessionId,
    payload: {},
    now: 1_000,
  };
}

describe('Vercel credentials with private control-plane upstreams', () => {
  it('keeps loopback upstreams behind the HTTPS runtime facade', async () => {
    const input = localPreparation();
    const { grant } = await prepareCredentialGrant(input);
    const proxy = grant.kilo.runtimeProxy;
    if (!proxy) throw new Error('Missing runtime proxy');
    proxy.members.push({ sessionId, kiloSessionId, handle: 'test-session-handle' });

    const payload = sessionCredentialsPayloadFromGrant(grant, sessionId);
    expect(payload.proxy?.targets).toEqual({
      backendBaseUrl: facade,
      providerBaseUrl: facade,
      sessionIngestBaseUrl: facade,
    });
    expect(JSON.stringify(payload)).not.toContain('localhost');
    expect(JSON.stringify(payload)).not.toContain(input.source.kiloToken);
    const policy = buildControlNetworkPolicy([grant]);
    expect(policy.injectionRules.length).toBeGreaterThan(0);
    expect(policy.injectionRules.every(rule => rule.domain === 'worker.example.com')).toBe(true);
    expect(JSON.stringify(policy)).not.toContain('localhost');
  });

  it('rejects a public HTTP upstream', async () => {
    const input = localPreparation();
    input.env.KILOCODE_BACKEND_BASE_URL = 'http://backend.example.com';
    await expect(prepareCredentialGrant(input)).rejects.toThrow();
  });

  it('rejects an HTTP sandbox-facing facade', async () => {
    const input = localPreparation();
    input.env.WORKER_URL = 'http://worker.example.com';
    await expect(prepareCredentialGrant(input)).rejects.toThrow();
  });
});

describe('credential source projection', () => {
  it.each(['browser', 'mobile'] as const)(
    'projects %s client provenance from session metadata',
    clientProvenance => {
      const metadata = parseSessionMetadata({
        metadataSchemaVersion: 2,
        identity: { sessionId: 'workspace_test', userId: 'user_test', clientProvenance },
        auth: { kiloSessionId: 'ses_test', kilocodeToken: 'token' },
        lifecycle: { version: 1, timestamp: 1 },
      });
      expect(credentialSourceFromMetadata(metadata)).toMatchObject({ clientProvenance });
    }
  );
});
