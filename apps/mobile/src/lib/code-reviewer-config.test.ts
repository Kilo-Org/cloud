import { describe, expect, it } from 'vitest';

import { parseReviewerPlatform, PERSONAL_SCOPE, toPersonalPlatform } from './code-reviewer-config';

// Every organization procedure validates the scope as a UUID, so the route
// parser accepts only a real UUID (or `personal`) as a scope.
const ORGANIZATION_ID = '5b0f5a0e-8a1f-4a54-9d0d-2a1c1b3d4e5f';

describe('parseReviewerPlatform', () => {
  it('returns an org platform object for every platform', () => {
    expect(parseReviewerPlatform(ORGANIZATION_ID, 'github')).toEqual({
      kind: 'org',
      organizationId: ORGANIZATION_ID,
      platform: 'github',
    });
    expect(parseReviewerPlatform(ORGANIZATION_ID, 'gitlab')).toEqual({
      kind: 'org',
      organizationId: ORGANIZATION_ID,
      platform: 'gitlab',
    });
    expect(parseReviewerPlatform(ORGANIZATION_ID, 'bitbucket')).toEqual({
      kind: 'org',
      organizationId: ORGANIZATION_ID,
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
    expect(parseReviewerPlatform(ORGANIZATION_ID, 'gitea')).toBeNull();
    expect(parseReviewerPlatform(PERSONAL_SCOPE, 'gitea')).toBeNull();
  });

  it('rejects a missing or repeated route segment', () => {
    expect(parseReviewerPlatform(ORGANIZATION_ID, undefined)).toBeNull();
    expect(parseReviewerPlatform(ORGANIZATION_ID, ['github', 'gitlab'])).toBeNull();
  });

  it('rejects a non-UUID scope for every platform', () => {
    // An organization id is a UUID, so any other shape is a hand-built link
    // the server would refuse as invalid input on every request.
    const invalidScopes = [
      '',
      'PERSONAL',
      'org-1',
      ` ${ORGANIZATION_ID}`,
      ORGANIZATION_ID.slice(0, -1),
    ];
    const platforms = ['github', 'gitlab', 'bitbucket'] as const;
    for (const scope of invalidScopes) {
      for (const platform of platforms) {
        expect(parseReviewerPlatform(scope, platform)).toBeNull();
      }
    }
  });
});

describe('toPersonalPlatform', () => {
  it('passes github and gitlab through unchanged', () => {
    expect(toPersonalPlatform('github')).toBe('github');
    expect(toPersonalPlatform('gitlab')).toBe('gitlab');
  });

  it('throws on bitbucket instead of rewriting it to github', () => {
    expect(() => toPersonalPlatform('bitbucket')).toThrow();
  });
});
