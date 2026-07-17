import { describe, expect, it } from 'vitest';
import {
  GITLAB_CREDENTIAL_AUDIT_AUDIENCE as RootGitLabCredentialAuditAudience,
  GITLAB_CREDENTIAL_BROKER_AUDIENCE as RootGitLabCredentialBrokerAudience,
} from './index.js';
import {
  BITBUCKET_CODE_REVIEW_PULL_REQUEST_AUDIENCE,
  BITBUCKET_CODE_REVIEW_WEBHOOK_DELETE_AUDIENCE,
  BITBUCKET_CODE_REVIEW_WEBHOOK_ENSURE_AUDIENCE,
  BITBUCKET_REPOSITORY_LIST_AUDIENCE,
  GITLAB_CREDENTIAL_BROKER_AUDIENCE,
  GITLAB_CREDENTIAL_AUDIT_AUDIENCE,
} from './internal-service-token-audiences.js';

describe('internal service token audiences', () => {
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

  it('exports a distinct purpose-bound GitLab credential audit audience', () => {
    expect(GITLAB_CREDENTIAL_AUDIT_AUDIENCE).toBe('git-token-service:gitlab-credential-audit');
    expect(GITLAB_CREDENTIAL_AUDIT_AUDIENCE).not.toBe(GITLAB_CREDENTIAL_BROKER_AUDIENCE);
    expect(RootGitLabCredentialAuditAudience).toBe(GITLAB_CREDENTIAL_AUDIT_AUDIENCE);
  });
});
