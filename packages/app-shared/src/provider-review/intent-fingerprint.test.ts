import { describe, expect, it } from 'vitest';
import {
  legacyGitHubIntentFingerprint,
  providerReviewIntentFingerprint,
  type ReviewIntent,
  type ReviewIntentInput,
} from './intent-fingerprint';
import { providerReviewFixtures } from './fixtures';

const revision = { headSha: 'head', baseSha: 'base', startSha: 'start', targetHeadSha: 'target' };
const target = { provider: 'gitlab', kind: 'thread', id: 'thread:1', url: null } as const;
const position = {
  revision,
  oldPath: 'before.ts',
  newPath: 'after.ts',
  side: 'new',
  line: 5,
  startLine: 2,
  startSide: 'new',
  native: { provider: 'gitlab', oldLine: null, newLine: 5 },
} as const;
const intent: ReviewIntent = {
  accountId: 'account',
  review: providerReviewFixtures.gitlab.org,
  actorId: 'actor',
  revision,
  input: {
    action: 'comment',
    body: 'Exact text',
    target,
    position,
    choice: 'comment',
    comments: [{ itemId: 'item', body: 'Inline text', position }],
    draftReferences: [target],
    reaction: 'thumbsup',
    method: 'merge',
    squash: false,
    commitTitle: 'Title',
    commitMessage: 'Message',
    deletion: {
      effect: 'keep',
      repositoryKey: 'source-repository',
      branch: 'feature',
      expectedHeadSha: 'head',
    },
  },
};
const changes = {
  action: 'merge',
  body: 'Exact text\n',
  target: { ...target, id: 'thread:2' },
  position: { ...position, line: 6 },
  choice: 'approve',
  comments: [{ itemId: 'item', body: 'Different inline text', position }],
  draftReferences: [],
  reaction: 'heart',
  method: 'fast_forward',
  squash: true,
  commitTitle: 'New title',
  commitMessage: 'New message',
  deletion: {
    effect: 'delete',
    repositoryKey: 'source-repository',
    branch: 'feature',
    expectedHeadSha: 'head',
  },
} satisfies { [K in keyof ReviewIntentInput]-?: ReviewIntentInput[K] };

function expectNewAdmission(changed: ReviewIntent) {
  const admissions = new Map([[providerReviewIntentFingerprint(intent), 'existing-operation']]);
  expect(admissions.get(providerReviewIntentFingerprint(changed))).toBeUndefined();
}

describe('versioned provider intent fingerprints', () => {
  it.each(Object.entries(changes))(
    'does not replay an operation after changing %s',
    (key, value) => {
      expectNewAdmission({ ...intent, input: { ...intent.input, [key]: value } });
    }
  );
  it.each(['headSha', 'baseSha', 'startSha', 'targetHeadSha'] as const)(
    'binds the expected %s',
    field => {
      expectNewAdmission({ ...intent, revision: { ...revision, [field]: 'changed' } });
      expectNewAdmission({
        ...intent,
        input: {
          ...intent.input,
          position: { ...position, revision: { ...revision, [field]: 'changed' } },
        },
      });
    }
  );
  it.each([
    { oldPath: 'renamed.ts' },
    { newPath: 'renamed.ts' },
    { side: 'old' as const },
    { startLine: 3 },
    { startSide: 'old' as const },
    { native: { provider: 'gitlab' as const, oldLine: 5, newLine: 5 } },
    {
      native: {
        ...position.native,
        lineRange: {
          start: { lineCode: 'line:2', side: 'new' as const, oldLine: 2, newLine: 2 },
          end: { lineCode: 'line:5', side: 'new' as const, oldLine: 5, newLine: 5 },
        },
      },
    },
  ])('binds the exact original position: %j', change => {
    expectNewAdmission({
      ...intent,
      input: { ...intent.input, position: { ...position, ...change } },
    });
  });
  it.each([
    { repositoryKey: 'different-repository' },
    { branch: 'different-branch' },
    { expectedHeadSha: 'changed' },
  ])('binds the selected branch deletion target: %j', change => {
    expectNewAdmission({
      ...intent,
      input: {
        ...intent.input,
        deletion: {
          effect: 'keep',
          repositoryKey: 'source-repository',
          branch: 'feature',
          expectedHeadSha: 'head',
          ...change,
        },
      },
    });
  });
  it('isolates accounts, actors, reviews, repositories, integrations, instances, and owners', () => {
    for (const change of [
      { accountId: 'other' },
      { actorId: 'other' },
      { review: { ...intent.review, reviewId: 'other' } },
      { review: { ...intent.review, number: '8' } },
    ])
      expectNewAdmission({ ...intent, ...change });
    const review = providerReviewFixtures.gitlab.org;
    for (const change of [
      { instanceUrl: 'https://git.example/other' },
      { fullName: 'group/Sub/Repo' },
      { repositoryId: 'other' },
    ]) {
      if (review.authorization.kind === 'ownerIntegration') {
        expectNewAdmission({
          ...intent,
          review: {
            ...review,
            authorization: review.authorization,
            repository: { ...review.repository, ...change },
          },
        });
      }
    }
    if (review.authorization.kind === 'ownerIntegration') {
      for (const change of [
        { integrationId: 'other' },
        { owner: { type: 'user' as const, id: 'owner' } },
        { owner: { type: 'org' as const, id: 'other' } },
      ]) {
        expectNewAdmission({
          ...intent,
          review: { ...review, authorization: { ...review.authorization, ...change } },
        });
      }
    }
    for (const review of [providerReviewFixtures.github.user, providerReviewFixtures.bitbucket.org])
      expectNewAdmission({ ...intent, review });
  });
  it('isolates GitHub authorization replacement and Bitbucket workspace UUIDs', () => {
    const github = providerReviewFixtures.github.user;
    if (github.authorization.kind === 'githubUser' && github.repository.provider === 'github') {
      const changed = {
        ...github,
        repository: { ...github.repository, provider: 'github' as const },
        authorization: { ...github.authorization, authorizationId: 'replacement' },
      };
      expect(providerReviewIntentFingerprint({ ...intent, review: changed })).not.toBe(
        providerReviewIntentFingerprint({ ...intent, review: github })
      );
    }
    const bitbucket = providerReviewFixtures.bitbucket.org;
    if (
      bitbucket.authorization.kind === 'ownerIntegration' &&
      bitbucket.repository.provider === 'bitbucket'
    ) {
      const changed = {
        ...bitbucket,
        authorization: bitbucket.authorization,
        repository: {
          ...bitbucket.repository,
          workspaceUuid: '{33333333-3333-4333-8333-333333333333}',
        },
      };
      expect(providerReviewIntentFingerprint({ ...intent, review: changed })).not.toBe(
        providerReviewIntentFingerprint({ ...intent, review: bitbucket })
      );
    }
  });
  it('preserves bytes when callers reorder properties and rejects unknown intent fields', () => {
    const reordered = {
      ...intent,
      revision: { targetHeadSha: 'target', startSha: 'start', baseSha: 'base', headSha: 'head' },
      input: Object.fromEntries(Object.entries(intent.input).reverse()) as ReviewIntentInput,
    };
    expect(providerReviewIntentFingerprint(reordered)).toBe(
      providerReviewIntentFingerprint(intent)
    );
    expect(() =>
      providerReviewIntentFingerprint({
        ...intent,
        input: { ...intent.input, unrecordedEffect: true },
      } as ReviewIntent)
    ).toThrow();
    expect(providerReviewIntentFingerprint({ ...intent, input: { action: 'comment' } })).not.toBe(
      providerReviewIntentFingerprint({ ...intent, input: { action: 'comment', body: '' } })
    );
  });
});

describe('legacy GitHub compatibility bytes', () => {
  it('preserves absent versus explicit-null legacy fields', () => {
    const input = {
      owner: 'Owner',
      repo: 'Repo',
      number: 7,
      method: 'merge',
      deleteBranch: true,
      expectedHeadSha: 'sha',
    };
    expect(legacyGitHubIntentFingerprint('merge', { ...input, commitTitle: undefined })).toBe(
      '{"resource":["Owner","Repo",7],"method":"merge","deleteBranch":true,"expectedHeadSha":"sha"}'
    );
    expect(legacyGitHubIntentFingerprint('merge', { ...input, commitTitle: null })).toBe(
      '{"resource":["Owner","Repo",7],"method":"merge","commitTitle":null,"deleteBranch":true,"expectedHeadSha":"sha"}'
    );
  });
  it.each([
    [
      'create_review_comment',
      {
        body: 'text',
        path: 'a.ts',
        line: 4,
        side: 'RIGHT',
        startLine: 2,
        startSide: 'RIGHT',
        commitSha: 'sha',
      },
      '{"resource":["Owner","Repo",7],"body":"text","path":"a.ts","line":4,"side":"RIGHT","startLine":2,"startSide":"RIGHT","commitSha":"sha"}',
    ],
    [
      'create_review_comment',
      { body: 'text', path: 'a.ts', line: 4, side: 'RIGHT', commitSha: 'sha' },
      '{"resource":["Owner","Repo",7],"body":"text","path":"a.ts","line":4,"side":"RIGHT","commitSha":"sha"}',
    ],
    [
      'reply_comment',
      { commentId: 42, body: 'reply' },
      '{"resource":["Owner","Repo",7],"commentId":42,"body":"reply"}',
    ],
    [
      'submit_review',
      {
        event: 'APPROVE',
        body: 'summary',
        commitSha: 'sha',
        comments: [{ path: 'a.ts', line: 4, side: 'RIGHT', body: 'text' }],
      },
      '{"resource":["Owner","Repo",7],"event":"APPROVE","body":"summary","commitSha":"sha","comments":[{"path":"a.ts","line":4,"side":"RIGHT","body":"text"}]}',
    ],
    [
      'merge',
      {
        method: 'squash',
        commitTitle: 'Title',
        commitMessage: 'Message',
        deleteBranch: false,
        expectedHeadSha: 'sha',
      },
      '{"resource":["Owner","Repo",7],"method":"squash","commitTitle":"Title","commitMessage":"Message","deleteBranch":false,"expectedHeadSha":"sha"}',
    ],
  ] as const)('preserves %s including optional ordering', (action, fields, expected) => {
    expect(
      legacyGitHubIntentFingerprint(action, {
        number: 7,
        repo: 'Repo',
        owner: 'Owner',
        operationKey: 'ignored',
        ...fields,
      })
    ).toBe(expected);
  });
});
