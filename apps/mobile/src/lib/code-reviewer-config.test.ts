import { describe, expect, it } from 'vitest';

import { parseReviewerPlatform, PERSONAL_SCOPE, toPersonalPlatform } from './code-reviewer-config';

describe('parseReviewerPlatform', () => {
  it('returns an org platform object for every platform', () => {
    expect(parseReviewerPlatform('org-1', 'github')).toEqual({
      kind: 'org',
      organizationId: 'org-1',
      platform: 'github',
    });
    expect(parseReviewerPlatform('org-1', 'gitlab')).toEqual({
      kind: 'org',
      organizationId: 'org-1',
      platform: 'gitlab',
    });
    expect(parseReviewerPlatform('org-1', 'bitbucket')).toEqual({
      kind: 'org',
      organizationId: 'org-1',
      platform: 'bitbucket',
    });
  });

  it('returns a personal platform object for github and gitlab', () => {
    expect(parseReviewerPlatform(PERSONAL_SCOPE, 'github')).toEqual({
      kind: 'personal',
      platform: 'github',
    });
    expect(parseReviewerPlatform(PERSONAL_SCOPE, 'gitlab')).toEqual({
      kind: 'personal',
      platform: 'gitlab',
    });
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

describe('toPersonalPlatform', () => {
  it('passes github and gitlab through unchanged', () => {
    expect(toPersonalPlatform('github')).toBe('github');
    expect(toPersonalPlatform('gitlab')).toBe('gitlab');
  });

  it('throws on bitbucket instead of rewriting it to github', () => {
    // A personal-scope config must never alias Bitbucket to GitHub; the
    // narrowing helper throws so the bad argument cannot silently target
    // another platform's config.
    expect(() => toPersonalPlatform('bitbucket')).toThrow();
  });
});
