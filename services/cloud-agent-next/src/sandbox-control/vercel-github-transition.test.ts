import { describe, expect, it, vi } from 'vitest';
import type * as Identity from '../scm-broker/vercel-identity.js';
import { contract } from '../scm-broker/test-fixtures.js';

vi.mock('../scm-broker/vercel-identity.js', async importOriginal => ({
  ...(await importOriginal<typeof Identity>()),
  verifiedVercelSandboxIdentityContract: contract,
}));

import {
  buildControlNetworkPolicy,
  prepareCredentialGrant,
  type CredentialGrantPreparation,
} from './session-credentials.js';

function preparation(): CredentialGrantPreparation {
  return {
    env: {
      WORKER_URL: 'https://worker.test',
      KILOCODE_BACKEND_BASE_URL: 'https://api.kilo.ai',
      KILO_OPENROUTER_BASE: 'https://api.kilo.ai',
      KILO_SESSION_INGEST_URL: 'https://ingest.kilosessions.ai',
    } as CredentialGrantPreparation['env'],
    source: {
      userId: 'user-1',
      kiloSessionId: 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa',
      kiloToken: 'eyJhbGciOiJub25lIn0.eyJydW50aW1lQXV0aG9yaXphdGlvbiI6eyJpZCI6InJhXzEifX0.c2ln',
      repository: { type: 'github', repo: 'acme/widgets' },
      createdOnPlatform: 'cloud-agent-web',
    },
    sessionId: 'workspace_11111111-1111-4111-8111-111111111111',
    sandboxId: 'ses-abcdef',
    provider: 'vercel',
    containmentEnabled: true,
    directory: '/workspace/test',
    scopeId: 'test-scope',
    outboundContainerId: 'ses-abcdef',
    payload: {},
  };
}

describe('Vercel GitHub capabilities with a synthetic verified contract', () => {
  it.each([true, false])(
    'uses configured fallback=%s, composes forwarding and rejects explicit tokens',
    async allowUserAuthorization => {
      const input = preparation();
      input.source.createdOnPlatform = allowUserAuthorization ? 'cloud-agent-web' : 'automation';
      const issue = vi.fn(async () => ({
        success: true,
        capability: 'kgh2.synthetic',
        source: allowUserAuthorization ? 'user' : 'installation',
        installationId: '123',
        accountLogin: 'acme',
        appType: 'standard',
        gitAuthor: { name: 'Kilo', email: 'bot@example.com' },
      }));
      Object.assign(input.env, { GIT_TOKEN_SERVICE: { issueGitHubSessionCapability: issue } });
      const { grant, payload } = await prepareCredentialGrant(input);
      expect(issue).toHaveBeenCalledWith({
        userId: 'user-1',
        githubRepo: 'acme/widgets',
        accessPurpose: 'workflow',
        allowUserAuthorization,
        outboundContainerId: 'ses-abcdef',
      });
      expect(grant.repository).toMatchObject({ allowUserAuthorization });
      expect(grant.scm?.capability?.credential).toBe('kgh2.synthetic');
      expect(grant.scm?.nativeToken).toBeUndefined();
      expect(JSON.stringify(payload)).not.toContain('kgh2.synthetic');
      expect(
        buildControlNetworkPolicy([grant], undefined, input.env).allow['api.github.com']
      ).toEqual([{ forwardURL: 'https://worker.test/scm/vercel/ses-abcdef' }]);
      expect(buildControlNetworkPolicy([grant], undefined, input.env).allow['*']).toEqual([]);

      const renewed = await prepareCredentialGrant({
        ...input,
        existing: grant,
        refreshBacking: true,
      });
      expect(issue).toHaveBeenCalledTimes(2);
      expect(issue.mock.calls[0]).toEqual(issue.mock.calls[1]);
      expect(renewed.grant.scm?.alias).toBe(grant.scm?.alias);
      expect(renewed.grant.repository).toEqual(grant.repository);

      await expect(
        prepareCredentialGrant({
          ...input,
          scopeId: 'explicit-scope',
          source: {
            ...input.source,
            repository: {
              type: 'github',
              repo: 'acme/explicit',
              token: 'synthetic-explicit-token',
            },
          },
        })
      ).rejects.toThrow();
      expect(issue).toHaveBeenCalledTimes(2);
    }
  );

  it('fails preparation when the configured GitHub policy denies issuance', async () => {
    const input = preparation();
    input.source.createdOnPlatform = 'automation';
    const issue = vi.fn(async () => ({ success: false, reason: 'not_connected' }));
    const legacyToken = vi.fn();
    Object.assign(input.env, {
      GIT_TOKEN_SERVICE: { issueGitHubSessionCapability: issue, getTokenForRepo: legacyToken },
    });
    await expect(prepareCredentialGrant(input)).rejects.toThrow();
    expect(issue).toHaveBeenCalledExactlyOnceWith({
      userId: 'user-1',
      githubRepo: 'acme/widgets',
      accessPurpose: 'workflow',
      allowUserAuthorization: false,
      outboundContainerId: 'ses-abcdef',
    });
    expect(legacyToken).not.toHaveBeenCalled();
  });
});
