import { type ProviderPrRef } from '@kilocode/app-shared/provider-review';
import { describe, expect, it } from 'vitest';

import {
  buildFixWithKiloHref,
  fixWithKiloMessage,
  fixWithKiloPrefillRepo,
  prCommentAnchor,
  prCommentWebUrl,
} from './fix-with-kilo';

import { i18n } from '@/i18n';

const GITHUB_REF: ProviderPrRef = {
  platform: 'github',
  owner: 'octocat',
  repo: 'hello',
  number: 7,
};

const GITLAB_REF_WITH_HINT: ProviderPrRef = {
  platform: 'gitlab',
  projectPath: 'group/sub/repo',
  mrIid: 12,
  instanceHint: 'https://gitlab.example.com',
};

const GITLAB_REF_WITHOUT_HINT: ProviderPrRef = {
  platform: 'gitlab',
  projectPath: 'group/sub/repo',
  mrIid: 12,
};

const BITBUCKET_REF: ProviderPrRef = {
  platform: 'bitbucket',
  workspace: 'acme',
  repoSlug: 'api',
  prId: 42,
};

describe('prCommentAnchor', () => {
  it.each([
    ['github', 'review', 'discussion_r55'],
    ['github', 'conversation', 'issuecomment-55'],
    ['gitlab', 'review', 'note_55'],
    ['gitlab', 'conversation', 'note_55'],
    ['bitbucket', 'review', 'comment-55'],
    ['bitbucket', 'conversation', 'comment-55'],
  ] as const)('anchors a %s %s comment the way the provider does', (platform, kind, expected) => {
    expect(prCommentAnchor(platform, kind, 55)).toBe(expected);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects the unusable id %s', commentId => {
    expect(prCommentAnchor('github', 'review', commentId)).toBeNull();
  });
});

describe('prCommentWebUrl', () => {
  it('anchors a GitHub review comment', () => {
    expect(prCommentWebUrl(GITHUB_REF, 'review', 55)).toBe(
      'https://github.com/octocat/hello/pull/7#discussion_r55'
    );
  });

  it('anchors a GitLab note on the hinted instance', () => {
    expect(prCommentWebUrl(GITLAB_REF_WITH_HINT, 'conversation', 9)).toBe(
      'https://gitlab.example.com/group/sub/repo/-/merge_requests/12#note_9'
    );
  });

  it('anchors a Bitbucket comment', () => {
    expect(prCommentWebUrl(BITBUCKET_REF, 'review', 3)).toBe(
      'https://bitbucket.org/acme/api/pull-requests/42#comment-3'
    );
  });

  it('returns null for a GitLab MR with no instance hint to name a host', () => {
    expect(prCommentWebUrl(GITLAB_REF_WITHOUT_HINT, 'review', 9)).toBeNull();
  });
});

describe('fixWithKiloPrefillRepo', () => {
  it('returns owner/repo for GitHub', () => {
    expect(fixWithKiloPrefillRepo(GITHUB_REF)).toBe('octocat/hello');
  });

  it('returns null for GitLab, which the picker can never show', () => {
    expect(fixWithKiloPrefillRepo(GITLAB_REF_WITH_HINT)).toBeNull();
    expect(fixWithKiloPrefillRepo(GITLAB_REF_WITHOUT_HINT)).toBeNull();
  });

  it('returns null for Bitbucket, which the picker can never show', () => {
    expect(fixWithKiloPrefillRepo(BITBUCKET_REF)).toBeNull();
  });
});

describe('fixWithKiloMessage', () => {
  it('interpolates the comment link into the English sentence', async () => {
    await i18n.changeLanguage('en');

    expect(fixWithKiloMessage('https://github.com/octocat/hello/pull/7#discussion_r55')).toBe(
      'Please address the following PR comment: https://github.com/octocat/hello/pull/7#discussion_r55'
    );
  });
});

describe('buildFixWithKiloHref', () => {
  const shareId = 'a1b2c3d4-0000-4000-8000-000000000000';

  it('carries the organization, the share id and an encoded repo prefill', () => {
    expect(buildFixWithKiloHref({ shareId, organizationId: 'org_1', repo: 'octocat/hello' })).toBe(
      `/(app)/agent-chat/new?organizationId=org_1&shareId=${shareId}&prefillRepo=octocat%2Fhello`
    );
  });

  it('omits the organization param for the personal scope', () => {
    expect(buildFixWithKiloHref({ shareId, organizationId: null, repo: 'octocat/hello' })).toBe(
      `/(app)/agent-chat/new?shareId=${shareId}&prefillRepo=octocat%2Fhello`
    );
  });

  it('omits the repo prefill when the provider has no picker row', () => {
    expect(buildFixWithKiloHref({ shareId, organizationId: 'org_1', repo: null })).toBe(
      `/(app)/agent-chat/new?organizationId=org_1&shareId=${shareId}`
    );
  });

  it('keeps only the share id when organization and repo are both absent', () => {
    expect(buildFixWithKiloHref({ shareId, organizationId: null, repo: null })).toBe(
      `/(app)/agent-chat/new?shareId=${shareId}`
    );
  });
});
