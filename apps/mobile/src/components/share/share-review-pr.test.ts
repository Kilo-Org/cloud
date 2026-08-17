import { describe, expect, it } from 'vitest';

import { selectShareReviewPr } from './share-review-pr';

const PR_URL = 'https://github.com/octocat/hello-world/pull/42';

describe('selectShareReviewPr', () => {
  it('returns the parsed destination when flag, new-session and PR text all hold', () => {
    expect(
      selectShareReviewPr({ text: PR_URL, prReviewEnabled: true, showNewSession: true })
    ).toEqual({
      owner: 'octocat',
      repo: 'hello-world',
      number: 42,
    });
  });

  it('returns null when the flag is off', () => {
    expect(
      selectShareReviewPr({ text: PR_URL, prReviewEnabled: false, showNewSession: true })
    ).toBeNull();
  });

  it('returns null for non-PR text', () => {
    expect(
      selectShareReviewPr({
        text: 'https://example.com',
        prReviewEnabled: true,
        showNewSession: true,
      })
    ).toBeNull();
  });

  it('returns null when showNewSession is false even for a PR URL', () => {
    expect(
      selectShareReviewPr({ text: PR_URL, prReviewEnabled: true, showNewSession: false })
    ).toBeNull();
  });

  it('matches a title-plus-URL text', () => {
    expect(
      selectShareReviewPr({
        text: `Fix the thing\n${PR_URL}`,
        prReviewEnabled: true,
        showNewSession: true,
      })
    ).toEqual({
      owner: 'octocat',
      repo: 'hello-world',
      number: 42,
    });
  });

  it('returns the first URL when two PR URLs are present', () => {
    expect(
      selectShareReviewPr({
        text: `${PR_URL} https://github.com/octocat/hello-world/pull/7`,
        prReviewEnabled: true,
        showNewSession: true,
      })
    ).toEqual({
      owner: 'octocat',
      repo: 'hello-world',
      number: 42,
    });
  });
});
