import '@/i18n';

import { describe, expect, it } from 'vitest';

import { selectShareReviewPr, selectShareReviewPrSubtitle } from './share-review-pr';

const PR_URL = 'https://github.com/octocat/hello-world/pull/42';
const GITLAB_MR_URL = 'https://gitlab.com/group/sub/repo/-/merge_requests/7';
const BITBUCKET_PR_URL = 'https://bitbucket.org/acme/api/pull-requests/42/overview';

describe('selectShareReviewPr', () => {
  it('returns the parsed destination when flag, new-session and PR text all hold', () => {
    expect(
      selectShareReviewPr({ text: PR_URL, prReviewEnabled: true, showNewSession: true })
    ).toEqual({
      platform: 'github',
      owner: 'octocat',
      repo: 'hello-world',
      number: 42,
    });
  });

  it('recognises a GitLab merge request', () => {
    expect(
      selectShareReviewPr({ text: GITLAB_MR_URL, prReviewEnabled: true, showNewSession: true })
    ).toEqual({
      platform: 'gitlab',
      projectPath: 'group/sub/repo',
      mrIid: 7,
      instanceHint: 'https://gitlab.com',
    });
  });

  it('recognises a self-managed GitLab merge request', () => {
    expect(
      selectShareReviewPr({
        text: 'https://gitlab.example.com/team/repo/-/merge_requests/9',
        prReviewEnabled: true,
        showNewSession: true,
      })
    ).toEqual({
      platform: 'gitlab',
      projectPath: 'team/repo',
      mrIid: 9,
      instanceHint: 'https://gitlab.example.com',
    });
  });

  it('recognises a Bitbucket pull request', () => {
    expect(
      selectShareReviewPr({ text: BITBUCKET_PR_URL, prReviewEnabled: true, showNewSession: true })
    ).toEqual({ platform: 'bitbucket', workspace: 'acme', repoSlug: 'api', prId: 42 });
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
    expect(
      selectShareReviewPr({
        text: 'https://example.com/group/repo',
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
      platform: 'github',
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
      platform: 'github',
      owner: 'octocat',
      repo: 'hello-world',
      number: 42,
    });
  });
});

describe('selectShareReviewPrSubtitle', () => {
  it('numbers a GitLab merge request with the provider separator', () => {
    expect(
      selectShareReviewPrSubtitle({ platform: 'gitlab', projectPath: 'group/sub/repo', mrIid: 7 })
    ).toBe('group/sub/repo!7');
  });

  it('numbers a pasted GitLab merge request with the provider separator', () => {
    const ref = selectShareReviewPr({
      text: GITLAB_MR_URL,
      prReviewEnabled: true,
      showNewSession: true,
    });
    if (ref === null) {
      throw new Error('expected the GitLab MR URL to parse');
    }
    expect(selectShareReviewPrSubtitle(ref)).toBe('group/sub/repo!7');
  });

  it('keeps the GitHub and Bitbucket identity line', () => {
    expect(
      selectShareReviewPrSubtitle({
        platform: 'github',
        owner: 'octocat',
        repo: 'hello-world',
        number: 42,
      })
    ).toBe('octocat/hello-world #42');
    expect(
      selectShareReviewPrSubtitle({
        platform: 'bitbucket',
        workspace: 'acme',
        repoSlug: 'api',
        prId: 42,
      })
    ).toBe('acme/api #42');
  });
});
