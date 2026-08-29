import { describe, expect, it } from 'vitest';
import { signKiloToken, verifyKiloToken } from './kilo-token.js';
import { BITBUCKET_INTERACTIVE_AUDIENCE } from './internal-service-token-audiences.js';
import { GITLAB_CREDENTIAL_BROKER_AUDIENCE as RootGitLabCredentialBrokerAudience } from './index.js';
import {
  BITBUCKET_CODE_REVIEW_PULL_REQUEST_AUDIENCE,
  BITBUCKET_CODE_REVIEW_WEBHOOK_DELETE_AUDIENCE,
  BITBUCKET_CODE_REVIEW_WEBHOOK_ENSURE_AUDIENCE,
  BITBUCKET_REPOSITORY_LIST_AUDIENCE,
  GITLAB_CREDENTIAL_BROKER_AUDIENCE,
  SESSION_INGEST_USER_DELETION_AUDIENCE,
} from './internal-service-token-audiences.js';

describe('internal service token audiences', () => {
  it('prevents interactive assertions from authorizing legacy endpoints', async () => {
    const secret = 'test-secret-that-is-at-least-32-characters';
    const { token } = await signKiloToken({
      userId: 'actor',
      pepper: null,
      secret,
      expiresInSeconds: 60,
      audience: BITBUCKET_INTERACTIVE_AUDIENCE,
    });
    await expect(
      verifyKiloToken(token, secret, { audience: BITBUCKET_INTERACTIVE_AUDIENCE })
    ).resolves.toMatchObject({ kiloUserId: 'actor' });
    for (const audience of [
      undefined,
      BITBUCKET_REPOSITORY_LIST_AUDIENCE,
      BITBUCKET_CODE_REVIEW_PULL_REQUEST_AUDIENCE,
      BITBUCKET_CODE_REVIEW_WEBHOOK_ENSURE_AUDIENCE,
      BITBUCKET_CODE_REVIEW_WEBHOOK_DELETE_AUDIENCE,
      GITLAB_CREDENTIAL_BROKER_AUDIENCE,
    ]) {
      await expect(verifyKiloToken(token, secret, { audience })).rejects.toThrow();
    }
  });

  it('keeps Bitbucket operations purpose-bound and mutually distinct', () => {
    const audiences = [
      BITBUCKET_REPOSITORY_LIST_AUDIENCE,
      BITBUCKET_CODE_REVIEW_PULL_REQUEST_AUDIENCE,
      BITBUCKET_CODE_REVIEW_WEBHOOK_ENSURE_AUDIENCE,
      BITBUCKET_CODE_REVIEW_WEBHOOK_DELETE_AUDIENCE,
    ];

    expect(new Set(audiences).size).toBe(audiences.length);
    expect(audiences).toEqual(
      expect.arrayContaining([
        'git-token-service:bitbucket-code-review:pull-request',
        'git-token-service:bitbucket-code-review:webhook-ensure',
        'git-token-service:bitbucket-code-review:webhook-delete',
      ])
    );
  });

  it('exports one purpose-bound GitLab credential broker audience', () => {
    expect(GITLAB_CREDENTIAL_BROKER_AUDIENCE).toBe('git-token-service:gitlab-credentials');
    expect(RootGitLabCredentialBrokerAudience).toBe(GITLAB_CREDENTIAL_BROKER_AUDIENCE);
  });

  it('exports one purpose-bound session-ingest user-deletion audience', () => {
    expect(SESSION_INGEST_USER_DELETION_AUDIENCE).toBe('session-ingest:user-deletion');
  });
});
