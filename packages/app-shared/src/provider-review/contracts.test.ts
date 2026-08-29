import { describe, expect, expectTypeOf, it } from 'vitest';
import { CODE_REVIEW_PLATFORMS } from '../code-review/enums';
import { normalizeLegacyGitHubReviewRepository } from '../code-review/repository-identity';
import {
  BitbucketMergeTaskSchema,
  ProviderReferenceSchema,
  ProviderReviewStateSchema,
  ReviewActionSchema,
  ReviewCapabilitiesSchema,
  ReviewCapabilitySchema,
  ReviewChecksSchema,
  ReviewMutationResultSchema,
  ReviewPositionSchema,
  ReviewRevisionSchema,
  parseReviewCursor,
  reviewActionAvailability,
  reviewPageKey,
  reviewResourceKey,
  serializeReviewWriteRequest,
  type ReviewFile,
  type ReviewOverview,
  type ReviewPageScope,
} from './contracts';
import {
  availableCapabilityFixture,
  providerReviewFixtures,
  reviewCapabilityFixtures,
} from './fixtures';

const revision = { headSha: 'head', baseSha: 'base', startSha: 'start', targetHeadSha: 'target' };
const reference = { provider: 'bitbucket', kind: 'merge-task', id: 'task:opaque', url: null };
const scope: ReviewPageScope = {
  resourceKey: reviewResourceKey('account', providerReviewFixtures.gitlab.org),
  surface: 'files',
  queryKey: 'all',
  revision,
};
const confirmed = {
  status: 'confirmed',
  reference: null,
  retry: 'never',
  reconciliation: 'complete',
};
const unresolved = {
  status: 'unresolved',
  reference,
  reason: 'revision-unproven',
  retry: 'reconcile',
  reconciliation: 'required',
};

describe('normalized provider review contracts', () => {
  // The package typecheck in CI validates these fixtures and type assertions.
  const lineCountFixtures: { additions: number | null; deletions: number | null }[] = [
    { additions: null, deletions: null },
    { additions: 0, deletions: 0 },
    { additions: 8, deletions: 3 },
    { additions: null, deletions: 3 },
    { additions: 8, deletions: null },
  ];

  it('accepts unavailable and confirmed file line counts without widening the contract', () => {
    expectTypeOf(lineCountFixtures).toEqualTypeOf<Pick<ReviewFile, 'additions' | 'deletions'>[]>();
  });

  it('accepts unavailable overview line counts while keeping commits and files numeric', () => {
    const overviewCountFixtures = lineCountFixtures.map(counts => ({
      commits: 1,
      files: 2,
      ...counts,
    }));
    expectTypeOf(overviewCountFixtures).toEqualTypeOf<ReviewOverview['counts'][]>();
  });

  it.each(CODE_REVIEW_PLATFORMS)('isolates %s pages from other providers and owners', provider => {
    for (const review of Object.values(providerReviewFixtures[provider])) {
      if (review === null) continue;
      const ownScope = { ...scope, resourceKey: reviewResourceKey('account', review) };
      const cursor = { scopeKey: reviewPageKey(ownScope), token: 'page:2' };
      expect(parseReviewCursor(cursor, ownScope).token).toBe('page:2');
      expect(() =>
        parseReviewCursor(cursor, {
          ...ownScope,
          resourceKey: reviewResourceKey('account', { ...review, reviewId: 'different' }),
        })
      ).toThrow('identity');
      if (review.authorization.kind === 'ownerIntegration') {
        const other = {
          ...review,
          authorization: {
            ...review.authorization,
            owner: { ...review.authorization.owner, id: 'other-owner' },
          },
        };
        expect(() =>
          parseReviewCursor(cursor, {
            ...ownScope,
            resourceKey: reviewResourceKey('account', other),
          })
        ).toThrow('identity');
      }
    }
  });

  it('rejects installation authorization for GitHub reviews and Personal Bitbucket', () => {
    const github = providerReviewFixtures.github.user;
    const bitbucket = providerReviewFixtures.bitbucket.org;
    const authorization = {
      kind: 'ownerIntegration',
      owner: { type: 'user', id: 'owner' },
      integrationId: 'integration',
    } as const;
    expect(() => reviewResourceKey('account', { ...github, authorization })).toThrow(
      'user authorization'
    );
    expect(() => reviewResourceKey('account', { ...bitbucket, authorization })).toThrow(
      'organization'
    );
  });

  it('normalizes absent legacy additions without inventing a default branch or authorization', () => {
    const old = {
      accountId: 'account',
      repository: { repositoryId: 'R_1', fullName: 'Team/Repo' },
      authorization: { kind: 'githubUser', accountId: 'account', authorizationId: 'user-auth' },
    } as const;
    const resolved = normalizeLegacyGitHubReviewRepository(old);
    expect(resolved).toMatchObject({
      kind: 'resolved',
      reference: {
        repository: { provider: 'github', instanceUrl: 'https://github.com', defaultBranch: null },
      },
    });
    expect(normalizeLegacyGitHubReviewRepository({ ...old, authorization: null })).toMatchObject({
      kind: 'legacy-unresolved',
      repository: old.repository,
    });
  });

  it('requires explicit nullable revision fields and opaque provider IDs', () => {
    expect(ReviewRevisionSchema.safeParse({ headSha: 'head' }).success).toBe(false);
    expect(
      ReviewRevisionSchema.parse({
        ...revision,
        baseSha: null,
        startSha: null,
        targetHeadSha: null,
      })
    ).toMatchObject({ baseSha: null, startSha: null, targetHeadSha: null });
    expect(ProviderReferenceSchema.safeParse({ ...reference, id: 42 }).success).toBe(false);
    expect(ProviderReferenceSchema.parse(reference).id).toBe('task:opaque');
  });

  it.each([
    null,
    {},
    { scopeKey: '', token: '2' },
    { scopeKey: 'foreign', token: '2' },
    { scopeKey: reviewPageKey(scope), token: 2 },
    { scopeKey: reviewPageKey(scope), token: '' },
    { scopeKey: reviewPageKey(scope), token: '2', repository: 'injected' },
  ])('rejects malformed or foreign pagination identity: %j', cursor => {
    expect(() => parseReviewCursor(cursor, scope)).toThrow();
  });
  it.each([
    { revision: { ...revision, headSha: 'changed' } },
    { revision: { ...revision, targetHeadSha: 'changed' } },
    { queryKey: 'different-filter' },
    { surface: 'threads' as const },
  ])('does not reuse a page after its scope changes: %j', change => {
    expect(() =>
      parseReviewCursor({ scopeKey: reviewPageKey(scope), token: '2' }, { ...scope, ...change })
    ).toThrow('identity');
  });

  it.each(CODE_REVIEW_PLATFORMS)(
    'retains supported %s actions when a write grant is missing',
    provider => {
      const capabilities = reviewCapabilityFixtures(provider);
      for (const action of ReviewActionSchema.options) {
        const capability = capabilities[action];
        const denied = { ...capability, permission: 'forbidden' as const };
        expect(reviewActionAvailability(denied)).toBe(
          capability.support === 'supported' ? 'forbidden' : capability.support
        );
      }
      expect(reviewActionAvailability(capabilities.read)).toBe('available');
      expect(
        ReviewCapabilitiesSchema.safeParse({ ...capabilities, reply: undefined }).success
      ).toBe(false);
    }
  );
  it.each([
    [{ support: 'unknown' }, 'unknown'],
    [{ permission: 'forbidden' }, 'forbidden'],
    [{ version: 'unavailable' }, 'version'],
    [{ license: 'unavailable' }, 'license'],
    [{ restrictions: ['required-check'] }, 'restricted'],
  ] as const)('keeps a distinct capability recovery state: %j', (change, expected) => {
    expect(
      reviewActionAvailability({
        ...availableCapabilityFixture,
        ...change,
        restrictions: 'restrictions' in change ? [...change.restrictions] : [],
      })
    ).toBe(expected);
  });
  it('requires evidence for unsupported actions instead of disguising missing implementation', () => {
    expect(
      ReviewCapabilitySchema.safeParse({ ...availableCapabilityFixture, support: 'unsupported' })
        .success
    ).toBe(false);
    expect(reviewActionAvailability(reviewCapabilityFixtures('bitbucket').enableAutoMerge)).toBe(
      'unsupported'
    );
  });

  it('keeps GitLab approvals independent from requested changes and licensed blocking', () => {
    const state = {
      provider: 'gitlab',
      approvals: { approved: true, required: null, remaining: 0, actorIds: ['actor'] },
      requestedChanges: {
        actorIds: ['reviewer'],
        blocksMerge: false,
        blockingCapability: { ...availableCapabilityFixture, license: 'unavailable' },
      },
    };
    expect(ProviderReviewStateSchema.parse(state)).toEqual(state);
    expect(ProviderReviewStateSchema.safeParse({ ...state, decision: 'APPROVED' }).success).toBe(
      false
    );
    expect(reviewActionAvailability(reviewCapabilityFixtures('gitlab').requestChanges)).toBe(
      'available'
    );
  });
  it('retains Bitbucket participant state without claiming an atomic head guard', () => {
    const state = {
      provider: 'bitbucket',
      expectedHeadProtection: 'none',
      participants: [
        {
          actor: {
            provider: 'bitbucket',
            instanceUrl: 'https://bitbucket.org',
            id: '{actor}',
            displayName: null,
            login: null,
            avatarUrl: null,
          },
          role: 'REVIEWER',
          state: null,
          participatedOn: null,
        },
      ],
    };
    expect(ProviderReviewStateSchema.parse(state)).toEqual(state);
    expect(
      ProviderReviewStateSchema.safeParse({ ...state, expectedHeadProtection: 'atomicSource' })
        .success
    ).toBe(false);
  });
  it('does not report empty checks as a successful check report', () => {
    expect(ReviewChecksSchema.safeParse({ status: 'reported', checks: [] }).success).toBe(false);
    expect(ReviewChecksSchema.parse({ status: 'none', checks: [] })).toEqual({
      status: 'none',
      checks: [],
    });
  });

  it.each([
    { provider: 'github' },
    {
      provider: 'gitlab',
      oldLine: null,
      newLine: 9,
      lineRange: {
        start: { lineCode: 'old_4_4', side: 'new', oldLine: 4, newLine: 4 },
        end: { lineCode: 'new_9_9', side: 'new', oldLine: 9, newLine: 9 },
      },
    },
    { provider: 'bitbucket', to: 9, startTo: 4 },
    { provider: 'bitbucket', from: 9, startFrom: 4 },
  ])('preserves native range fields for $provider without retargeting', native => {
    const position = {
      revision,
      oldPath: 'old.ts',
      newPath: 'new.ts',
      side: 'from' in native ? 'old' : 'new',
      line: 9,
      startLine: 4,
      startSide: 'from' in native ? 'old' : 'new',
      native,
    };
    expect(ReviewPositionSchema.parse(position)).toEqual(position);
    expect(ReviewPositionSchema.safeParse({ ...position, startSide: undefined }).success).toBe(
      false
    );
    if (native.provider === 'gitlab')
      expect(
        ReviewPositionSchema.safeParse({ ...position, revision: { ...revision, baseSha: null } })
          .success
      ).toBe(false);
  });

  it('retains accepted tasks and separate unfinished batch effects across serialization', () => {
    const task = { reference, state: 'pending', mergeCommitSha: null, error: null };
    const accepted = {
      status: 'accepted',
      reference,
      task,
      retry: 'reconcile',
      reconciliation: 'pending',
    };
    const partial = {
      status: 'partial',
      items: [
        { itemId: 'merge', effect: 'merge', result: confirmed },
        { itemId: 'delete', effect: 'deleteBranch', result: unresolved },
      ],
      retry: 'unfinished-only',
      reconciliation: 'required',
    };
    for (const result of [confirmed, accepted, partial, unresolved]) {
      expect(ReviewMutationResultSchema.parse(JSON.parse(JSON.stringify(result)))).toEqual(result);
    }
    expect(
      BitbucketMergeTaskSchema.safeParse({
        ...task,
        reference: { ...reference, provider: 'github' },
      }).success
    ).toBe(false);
    expect(ReviewMutationResultSchema.safeParse({ ...accepted, retry: 'same-key' }).success).toBe(
      false
    );
    expect(ReviewMutationResultSchema.safeParse({ ...unresolved, retry: 'same-key' }).success).toBe(
      false
    );
  });
  it.each(['same-key', 'never'])('retains the rejected action retry policy: %s', retry => {
    const result = {
      status: 'rejected',
      code: 'denied-or-transient',
      explanation: 'Saved work',
      retry,
      reconciliation: 'not-needed',
    };
    expect(ReviewMutationResultSchema.parse(JSON.parse(JSON.stringify(result)))).toEqual(result);
  });
  it.each([
    'é'.repeat(127_999),
    '\u4e2d'.repeat(85_332) + 'aa',
    '\u{20000}'.repeat(63_999) + 'aa',
    '%'.repeat(255_998),
    '\ud800'.repeat(42_666) + 'aa',
  ])('enforces the exact serialized UTF-8 ceiling without truncation', body => {
    expect(JSON.parse(serializeReviewWriteRequest(body))).toBe(body);
    expect(() => serializeReviewWriteRequest(`${body}a`)).toThrow('byte limit');
  });
  it('counts the complete request envelope, not only the comment text', () => {
    const request = { body: 'a'.repeat(255_989) };
    expect(JSON.parse(serializeReviewWriteRequest(request))).toEqual(request);
    expect(() => serializeReviewWriteRequest({ body: `${request.body}a` })).toThrow('byte limit');
    expect(() => serializeReviewWriteRequest(undefined)).toThrow();
  });
});
