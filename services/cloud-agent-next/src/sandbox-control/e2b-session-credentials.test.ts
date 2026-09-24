import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMetadata } from '../persistence/session-metadata.js';
import { resolveCloudAgentGitHubAuthForRepo } from '../services/git-token-service-client.js';
import {
  prepareSessionCredentials,
  sessionCredentialGrantSchema,
  type SessionCredentialGrant,
} from './session-credentials.js';

vi.mock('../services/git-token-service-client.js', () => ({
  resolveCloudAgentGitHubAuthForRepo: vi.fn(),
}));

const NOW = 1_800_000_000_000;
const ORGANIZATION_ID = '11111111-1111-4111-8111-111111111111';
const CREDENTIAL_ID = '22222222-2222-4222-8222-222222222222';
const SANDBOX_ID = 'ses-e2b123';
const binding = {
  kind: 'e2b',
  organizationId: ORGANIZATION_ID,
  credentialId: CREDENTIAL_ID,
} as const;
const env = {
  KILOCODE_BACKEND_BASE_URL: 'https://backend.example.test',
  KILO_OPENROUTER_BASE: 'https://provider.example.test/api/openrouter',
  KILO_SESSION_INGEST_URL: 'https://ingest.example.test',
} as Parameters<typeof prepareSessionCredentials>[0]['env'];

function metadata(): SessionMetadata {
  return {
    metadataSchemaVersion: 2,
    identity: {
      sessionId: 'workspace_33333333-3333-4333-8333-333333333333',
      userId: 'oauth/test-user',
      orgId: ORGANIZATION_ID,
      createdOnPlatform: 'cloud-agent-web',
    },
    auth: {
      kiloSessionId: 'ses_abcdefghijklmnopqrstuvwxyz',
      kilocodeToken: 'test-direct-kilo-token',
    },
    lifecycle: { version: 1, timestamp: NOW },
    repository: { type: 'github', repo: 'test-org/repository' },
    workspace: {
      sandboxId: SANDBOX_ID,
      sandboxProvider: 'e2b',
      sandboxProviderBinding: binding,
      workspacePath: '/workspace/test-worktree',
      credentialContainment: { github: false, gitlab: false, bitbucket: false, kilocode: false },
    },
  };
}

function prepare(data = metadata(), existing?: SessionCredentialGrant) {
  return prepareSessionCredentials({
    env,
    metadata: data,
    sandboxId: SANDBOX_ID,
    existing,
    now: NOW,
  });
}

beforeEach(() => {
  vi.mocked(resolveCloudAgentGitHubAuthForRepo).mockReset();
  vi.mocked(resolveCloudAgentGitHubAuthForRepo).mockResolvedValue({
    success: true,
    value: {
      githubToken: 'test-managed-github-token',
      source: 'installation',
      installationId: '42',
      accountLogin: 'test-org',
      appType: 'standard',
      gitAuthor: { name: 'Test Bot', email: 'bot@example.test' },
    },
  });
});

describe('E2B direct worktree grants', () => {
  it('uses existing direct Kilo and managed GitHub resolution with an exact provider binding', async () => {
    const { grant, payload } = await prepare();
    expect(grant).toMatchObject({
      provider: 'e2b',
      providerBinding: binding,
      orgId: ORGANIZATION_ID,
      containmentEnabled: false,
      kilo: { token: 'test-direct-kilo-token', capabilities: {} },
      scm: { nativeToken: 'test-managed-github-token' },
    });
    expect(grant.outboundContainerId).toBeUndefined();
    expect(grant.kilo.alias).toBeUndefined();
    expect(grant.scm?.alias).toBeUndefined();
    expect(payload.kilo).toMatchObject({
      token: 'test-direct-kilo-token',
      organizationId: ORGANIZATION_ID,
      containmentEnabled: false,
    });
    expect(payload.env).toMatchObject({
      KILOCODE_TOKEN: 'test-direct-kilo-token',
      KILOCODE_ORGANIZATION_ID: ORGANIZATION_ID,
      GH_TOKEN: 'test-managed-github-token',
    });
    expect(payload.git?.token).toBe('test-managed-github-token');
    expect(JSON.stringify(payload)).not.toContain(CREDENTIAL_ID);
    expect(JSON.stringify(payload)).not.toContain('apiKeyEncrypted');
  });

  it.each(['github', 'gitlab', 'bitbucket', 'kilocode'] as const)(
    'rejects a missing or enabled %s containment flag before resolving native credentials',
    async flag => {
      for (const value of [undefined, true]) {
        const data = metadata();
        const flags = { ...data.workspace?.credentialContainment, [flag]: value };
        data.workspace = {
          ...data.workspace,
          credentialContainment: flags,
        } as SessionMetadata['workspace'];
        await expect(prepare(data)).rejects.toThrow();
      }
      expect(resolveCloudAgentGitHubAuthForRepo).not.toHaveBeenCalled();
    }
  );

  it('rejects another organization before delivering credentials', async () => {
    const data = metadata();
    data.identity.orgId = '44444444-4444-4444-8444-444444444444';
    await expect(prepare(data)).rejects.toThrow();
    expect(resolveCloudAgentGitHubAuthForRepo).not.toHaveBeenCalled();
  });

  it('does not repoint an existing grant to a replacement E2B credential', async () => {
    const first = await prepare();
    const data = metadata();
    data.workspace = {
      ...data.workspace,
      sandboxProviderBinding: { ...binding, credentialId: '44444444-4444-4444-8444-444444444444' },
    };
    vi.mocked(resolveCloudAgentGitHubAuthForRepo).mockClear();
    await expect(prepare(data, first.grant)).rejects.toThrow();
    expect(resolveCloudAgentGitHubAuthForRepo).not.toHaveBeenCalled();
  });

  it('requires HTTPS credential targets for E2B', async () => {
    await expect(
      prepareSessionCredentials({
        env: { ...env, KILO_OPENROUTER_BASE: 'http://provider.example.test/api/openrouter' },
        metadata: metadata(),
        sandboxId: SANDBOX_ID,
        now: NOW,
      })
    ).rejects.toThrow();
  });

  it.each([
    { providerBinding: undefined },
    { providerBinding: { kind: 'e2b', organizationId: ORGANIZATION_ID } },
    { providerBinding: { ...binding, organizationId: '44444444-4444-4444-8444-444444444444' } },
    { containmentEnabled: undefined },
    { containmentEnabled: true },
    { outboundContainerId: 'contained:foreign-allocation' },
  ])('rejects a persisted grant with incompatible binding or policy: %j', async overrides => {
    const { grant } = await prepare();
    expect(sessionCredentialGrantSchema.safeParse({ ...grant, ...overrides }).success).toBe(false);
  });

  it('rejects broker aliases or capabilities in an E2B direct grant', async () => {
    const { grant } = await prepare();
    expect(
      sessionCredentialGrantSchema.safeParse({
        ...grant,
        kilo: { ...grant.kilo, alias: 'kcp1.unexpected' },
      }).success
    ).toBe(false);
    expect(
      sessionCredentialGrantSchema.safeParse({
        ...grant,
        scm: { ...grant.scm, alias: 'kcp1.unexpected' },
      }).success
    ).toBe(false);
  });
});
