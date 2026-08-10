import { describe, expect, it } from 'vitest';
import {
  SLACK_OAUTH_CREDENTIAL_ENVELOPE_SCHEME,
  SLACK_OAUTH_CREDENTIAL_ENVELOPE_VERSION,
  buildSlackCredentialLockKey,
  buildSlackOAuthCredentialAad,
  type SlackOAuthCredentialAadInput,
} from './slack-credential.js';

const input: SlackOAuthCredentialAadInput = {
  credentialId: 'credential-1',
  integrationId: 'integration-1',
  slackTeamId: 'T00000001',
  owner: { type: 'org', id: 'organization-1' },
  credentialVersion: 3,
  kind: 'access',
};

describe('buildSlackOAuthCredentialAad', () => {
  it('serializes every binding field in a stable order', () => {
    expect(buildSlackOAuthCredentialAad(input)).toBe(
      JSON.stringify({
        scheme: SLACK_OAUTH_CREDENTIAL_ENVELOPE_SCHEME,
        version: SLACK_OAUTH_CREDENTIAL_ENVELOPE_VERSION,
        platform: 'slack',
        credentialId: 'credential-1',
        integrationId: 'integration-1',
        slackTeamId: 'T00000001',
        owner: { type: 'org', id: 'organization-1' },
        credentialVersion: 3,
        kind: 'access',
      })
    );
  });

  it('is deterministic regardless of owner key order or extra owner keys', () => {
    const reordered = buildSlackOAuthCredentialAad({
      ...input,
      owner: { id: 'organization-1', type: 'org' } as SlackOAuthCredentialAadInput['owner'],
    });
    const withExtras = buildSlackOAuthCredentialAad({
      ...input,
      owner: {
        type: 'org',
        id: 'organization-1',
        extra: 'ignored',
      } as unknown as SlackOAuthCredentialAadInput['owner'],
    });

    expect(reordered).toBe(buildSlackOAuthCredentialAad(input));
    expect(withExtras).toBe(buildSlackOAuthCredentialAad(input));
  });

  it.each([
    ['credentialId', { credentialId: 'credential-2' }],
    ['integrationId', { integrationId: 'integration-2' }],
    ['slackTeamId', { slackTeamId: 'T00000002' }],
    ['owner id', { owner: { type: 'org', id: 'organization-2' } as const }],
    ['owner type', { owner: { type: 'user', id: 'organization-1' } as const }],
    ['credentialVersion', { credentialVersion: 4 }],
    ['kind', { kind: 'refresh' as const }],
  ])('changes when %s changes', (_label, override) => {
    expect(buildSlackOAuthCredentialAad({ ...input, ...override })).not.toBe(
      buildSlackOAuthCredentialAad(input)
    );
  });
});

describe('buildSlackCredentialLockKey', () => {
  it('keys the lock on the parent integration', () => {
    expect(buildSlackCredentialLockKey('integration-1')).toBe(
      'slack-oauth-credential:integration:integration-1'
    );
    expect(buildSlackCredentialLockKey('integration-2')).not.toBe(
      buildSlackCredentialLockKey('integration-1')
    );
  });
});
