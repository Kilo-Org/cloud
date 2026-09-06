import { describe, expect, it } from 'vitest';

import { prIntentFingerprint } from './intent-fingerprint';

const SHA = 'a'.repeat(40);

const COMMENT_INPUT = {
  owner: 'octocat',
  repo: 'hello',
  number: 1,
  body: 'inline nit',
  path: 'README.md',
  line: 3,
  side: 'RIGHT',
  commitSha: SHA,
};

const REVIEW_INPUT = {
  owner: 'octocat',
  repo: 'hello',
  number: 1,
  event: 'APPROVE',
  body: 'LGTM',
  commitSha: SHA,
  comments: [{ path: 'README.md', line: 3, side: 'RIGHT', body: 'nit' }],
};

const MERGE_INPUT = {
  owner: 'octocat',
  repo: 'hello',
  number: 1,
  method: 'squash',
  deleteBranch: true,
  expectedHeadSha: SHA,
};

const REPLY_INPUT = {
  owner: 'octocat',
  repo: 'hello',
  number: 1,
  commentId: 42,
  body: 'good point',
};

// The web router hashes this string into the stored `resource_key` and the
// mobile hooks derive the operation key from it, so the bytes are the dedupe
// identity for the ledger's 30-day retention window. Pin them: a reordered or
// renamed field must fail here instead of rotating every in-flight key.
describe('prIntentFingerprint', () => {
  it('pins the exact bytes for every intent', () => {
    expect(prIntentFingerprint('create_review_comment', COMMENT_INPUT)).toBe(
      `{"resource":["octocat","hello",1],"body":"inline nit","path":"README.md","line":3,"side":"RIGHT","commitSha":"${SHA}"}`
    );
    expect(prIntentFingerprint('submit_review', REVIEW_INPUT)).toBe(
      `{"resource":["octocat","hello",1],"event":"APPROVE","body":"LGTM","commitSha":"${SHA}","comments":[{"path":"README.md","line":3,"side":"RIGHT","body":"nit"}]}`
    );
    expect(prIntentFingerprint('merge', MERGE_INPUT)).toBe(
      `{"resource":["octocat","hello",1],"method":"squash","deleteBranch":true,"expectedHeadSha":"${SHA}"}`
    );
    expect(prIntentFingerprint('reply_comment', REPLY_INPUT)).toBe(
      '{"resource":["octocat","hello",1],"commentId":42,"body":"good point"}'
    );
  });

  it('ignores the caller insertion order', () => {
    const reversed = {
      commitSha: SHA,
      side: 'RIGHT',
      line: 3,
      path: 'README.md',
      body: 'inline nit',
      number: 1,
      repo: 'hello',
      owner: 'octocat',
    };
    expect(prIntentFingerprint('create_review_comment', reversed)).toBe(
      prIntentFingerprint('create_review_comment', COMMENT_INPUT)
    );
  });

  it('omits absent optional fields and ignores fields outside the intent', () => {
    expect(
      prIntentFingerprint('create_review_comment', {
        ...COMMENT_INPUT,
        startLine: undefined,
        startSide: undefined,
        operationKey: 'key-1',
      })
    ).toBe(prIntentFingerprint('create_review_comment', COMMENT_INPUT));
  });

  it('changes when any intent-defining field changes', () => {
    const original = prIntentFingerprint('merge', MERGE_INPUT);
    expect(prIntentFingerprint('merge', { ...MERGE_INPUT, method: 'rebase' })).not.toBe(original);
    expect(prIntentFingerprint('merge', { ...MERGE_INPUT, deleteBranch: false })).not.toBe(
      original
    );
    expect(
      prIntentFingerprint('merge', { ...MERGE_INPUT, expectedHeadSha: 'b'.repeat(40) })
    ).not.toBe(original);
    expect(prIntentFingerprint('merge', { ...MERGE_INPUT, commitTitle: 'T' })).not.toBe(original);
  });

  // The provider split adds `gitlab`/`bitbucket` resource shapes WITHOUT
  // touching the GitHub bytes: an absent or 'github' platform must keep the
  // exact legacy `[owner, repo, number]` resource, or every in-flight
  // GitHub key would rotate and break the ledger's dedupe window.
  it('keeps GitHub fingerprints byte-identical with an absent or explicit github platform', () => {
    expect(prIntentFingerprint('create_review_comment', COMMENT_INPUT)).toBe(
      '{"resource":["octocat","hello",1],"body":"inline nit","path":"README.md","line":3,"side":"RIGHT","commitSha":"' +
        SHA +
        '"}'
    );
    for (const [intent, input] of [
      ['create_review_comment', COMMENT_INPUT],
      ['submit_review', REVIEW_INPUT],
      ['merge', MERGE_INPUT],
      ['reply_comment', REPLY_INPUT],
    ] as const) {
      const legacy = prIntentFingerprint(intent, input);
      expect(prIntentFingerprint(intent, { ...input, platform: 'github' })).toBe(legacy);
    }
  });

  it('pins the gitlab resource bytes', () => {
    expect(
      prIntentFingerprint('merge', {
        platform: 'gitlab',
        projectPath: 'group/sub/repo',
        instanceHint: 'gitlab.example.com',
        number: 42,
        method: 'squash',
        deleteBranch: true,
        expectedHeadSha: SHA,
      })
    ).toBe(
      `{"resource":["gitlab","gitlab.example.com","group/sub/repo",42],"method":"squash","deleteBranch":true,"expectedHeadSha":"${SHA}"}`
    );
    expect(
      prIntentFingerprint('merge', {
        platform: 'gitlab',
        projectPath: 'group/sub/repo',
        number: 42,
        method: 'squash',
        deleteBranch: true,
        expectedHeadSha: SHA,
      })
    ).toBe(
      `{"resource":["gitlab","","group/sub/repo",42],"method":"squash","deleteBranch":true,"expectedHeadSha":"${SHA}"}`
    );
  });

  it('pins the bitbucket resource bytes', () => {
    expect(
      prIntentFingerprint('submit_review', {
        platform: 'bitbucket',
        workspace: 'acme',
        repoSlug: 'api',
        number: 7,
        event: 'APPROVE',
        body: 'LGTM',
        commitSha: SHA,
        comments: [],
      })
    ).toBe(
      '{"resource":["bitbucket","acme","api",7],"event":"APPROVE","body":"LGTM","commitSha":"' +
        SHA +
        '","comments":[]}'
    );
  });

  it('never collides across providers for same-named resources', () => {
    const github = prIntentFingerprint('merge', MERGE_INPUT);
    const gitlabInput = {
      platform: 'gitlab',
      projectPath: 'octocat/hello',
      number: 1,
      method: 'squash',
      deleteBranch: true,
      expectedHeadSha: SHA,
    };
    const bitbucket = prIntentFingerprint('merge', {
      platform: 'bitbucket',
      workspace: 'octocat',
      repoSlug: 'hello',
      number: 1,
      method: 'squash',
      deleteBranch: true,
      expectedHeadSha: SHA,
    });
    const gitlabNoHint = prIntentFingerprint('merge', gitlabInput);
    const gitlabSelfHosted = prIntentFingerprint('merge', {
      ...gitlabInput,
      instanceHint: 'gitlab.example.com',
    });
    const gitlabSaaS = prIntentFingerprint('merge', { ...gitlabInput, instanceHint: 'gitlab.com' });
    expect(new Set([github, gitlabNoHint, gitlabSelfHosted, gitlabSaaS, bitbucket]).size).toBe(5);
  });
});
