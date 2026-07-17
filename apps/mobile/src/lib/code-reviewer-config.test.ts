import { describe, expect, it } from 'vitest';

import { parseReviewerPlatform, PERSONAL_SCOPE } from './code-reviewer-config';

describe('parseReviewerPlatform', () => {
  it('allows every platform for an organization scope', () => {
    expect(parseReviewerPlatform('org-1', 'github')).toBe('github');
    expect(parseReviewerPlatform('org-1', 'gitlab')).toBe('gitlab');
    expect(parseReviewerPlatform('org-1', 'bitbucket')).toBe('bitbucket');
  });

  it('allows github and gitlab for the personal scope', () => {
    expect(parseReviewerPlatform(PERSONAL_SCOPE, 'github')).toBe('github');
    expect(parseReviewerPlatform(PERSONAL_SCOPE, 'gitlab')).toBe('gitlab');
  });

  it('rejects bitbucket for the personal scope (org-only platform)', () => {
    expect(parseReviewerPlatform(PERSONAL_SCOPE, 'bitbucket')).toBeNull();
  });

  it('rejects an unknown platform', () => {
    expect(parseReviewerPlatform('org-1', 'gitea')).toBeNull();
    expect(parseReviewerPlatform(PERSONAL_SCOPE, 'gitea')).toBeNull();
  });

  it('rejects a missing or repeated route segment', () => {
    expect(parseReviewerPlatform('org-1', undefined)).toBeNull();
    expect(parseReviewerPlatform('org-1', ['github', 'gitlab'])).toBeNull();
  });
});
