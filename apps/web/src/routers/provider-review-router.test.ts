/**
 * @jest-environment node
 */
import { describe, expect, it, beforeAll, beforeEach } from '@jest/globals';
// @swc/jest only hoists `jest.mock` calls when `jest` is the GLOBAL binding
// (@types/jest). Importing `jest` from '@jest/globals' defeats hoisting: the
// mocked modules load for real before registration. Same pattern as
// github-pr-review-router.test.ts.
import { TRPCError } from '@trpc/server';
import { createCallerFactory } from '@/lib/trpc/init';
import type { User, OperationLedgerRow } from '@kilocode/db/schema';
import { providerPrRefKey } from '@kilocode/app-shared/provider-review';
import { GitLabReviewError } from '@/lib/provider-review/gitlab-authorization';
import { GITLAB_STALE_HEAD_REASON } from '@/lib/provider-review/gitlab-write';
import {
  BITBUCKET_AUTO_MERGE_UNSUPPORTED_REASON,
  BITBUCKET_PR_REVIEW_CAPABILITIES,
} from '@/lib/provider-review/bitbucket-write';
import { GITLAB_MR_REVIEW_CAPABILITIES } from '@/lib/provider-review/gitlab-write';
import { providerLedgerResourceKey, providerReviewRouter } from './provider-review-router';

const ORG_ID = '2b1d4c8e-9f3a-4e5d-8c7b-6a5948372615';
const USER_ID = 'user-1';

// ----- mocked seams -----------------------------------------------------------
// Every jest.mock factory below delegates LAZILY (arrow closures) so the
// hoisted mock registration never touches the const bindings during the
// import phase.

// The ledger primitives: the router must drive the same admission state
// machine as the GitHub write path. Mocked so the tests assert the
// orchestration (admit → execute → settle) without a database.
const mockAdmitOperation = jest.fn();
const mockSettleOperation = jest.fn();
const mockMarkReconcilePending = jest.fn();
const mockRecordOperationAcceptance = jest.fn();

jest.mock('@kilocode/db/operation-ledger', () => ({
  admitOperation: (...args: unknown[]) => mockAdmitOperation(...args),
  settleOperation: (...args: unknown[]) => mockSettleOperation(...args),
  markReconcilePending: (...args: unknown[]) => mockMarkReconcilePending(...args),
  recordOperationAcceptance: (...args: unknown[]) => mockRecordOperationAcceptance(...args),
}));

// The router passes `db` to the (mocked) ledger only.
jest.mock('@/lib/drizzle', () => ({ db: {} }));

const mockEnsureOrganizationAccess = jest.fn();
jest.mock('./organizations/utils', () => ({
  ensureOrganizationAccess: (...args: unknown[]) => mockEnsureOrganizationAccess(...args),
}));

const mockAssertTermsAccepted = jest.fn();
jest.mock('./github-pr-review-router', () => ({
  assertTermsAccepted: (...args: unknown[]) => mockAssertTermsAccepted(...args),
}));

// The provider read layers (s2/s3). The router must forward the input's
// repository identity and the ctx-derived owner — nothing else.
const gitlabRead = {
  getMergeRequest: jest.fn(),
  listChangedFiles: jest.fn(),
  getFileLines: jest.fn(),
  listDiscussions: jest.fn(),
  listChecks: jest.fn(),
  listInbox: jest.fn(),
  getMergeState: jest.fn(),
};
jest.mock('@/lib/provider-review/gitlab-read', () => ({
  getMergeRequest: (...a: unknown[]) => gitlabRead.getMergeRequest(...a),
  listChangedFiles: (...a: unknown[]) => gitlabRead.listChangedFiles(...a),
  getFileLines: (...a: unknown[]) => gitlabRead.getFileLines(...a),
  listDiscussions: (...a: unknown[]) => gitlabRead.listDiscussions(...a),
  listChecks: (...a: unknown[]) => gitlabRead.listChecks(...a),
  listInbox: (...a: unknown[]) => gitlabRead.listInbox(...a),
  getMergeState: (...a: unknown[]) => gitlabRead.getMergeState(...a),
  requestGitLabJson: jest.fn(),
}));

const bitbucketRead = {
  getPullRequest: jest.fn(),
  listChangedFiles: jest.fn(),
  getFileLines: jest.fn(),
  listDiscussions: jest.fn(),
  listChecks: jest.fn(),
  listInbox: jest.fn(),
  getMergeRestrictions: jest.fn(),
};
jest.mock('@/lib/provider-review/bitbucket-read', () => ({
  getPullRequest: (...a: unknown[]) => bitbucketRead.getPullRequest(...a),
  listChangedFiles: (...a: unknown[]) => bitbucketRead.listChangedFiles(...a),
  getFileLines: (...a: unknown[]) => bitbucketRead.getFileLines(...a),
  listDiscussions: (...a: unknown[]) => bitbucketRead.listDiscussions(...a),
  listChecks: (...a: unknown[]) => bitbucketRead.listChecks(...a),
  listInbox: (...a: unknown[]) => bitbucketRead.listInbox(...a),
  getMergeRestrictions: (...a: unknown[]) => bitbucketRead.getMergeRestrictions(...a),
  requestBitbucketJson: jest.fn(),
  fetchPage: jest.fn(),
  repositoryPathGuard: jest.fn(),
}));

// The write layers: real capability constants and reason copy (the tests
// assert against them), mocked effects.
const gitlabWrite = {
  addComment: jest.fn(),
  replyToDiscussion: jest.fn(),
  submitReview: jest.fn(),
  resolveThread: jest.fn(),
  unresolveThread: jest.fn(),
  mergePullRequest: jest.fn(),
  enableAutoMerge: jest.fn(),
  disableAutoMerge: jest.fn(),
};
jest.mock('@/lib/provider-review/gitlab-write', () => ({
  ...jest.requireActual('@/lib/provider-review/gitlab-write'),
  addComment: (...a: unknown[]) => gitlabWrite.addComment(...a),
  replyToDiscussion: (...a: unknown[]) => gitlabWrite.replyToDiscussion(...a),
  submitReview: (...a: unknown[]) => gitlabWrite.submitReview(...a),
  resolveThread: (...a: unknown[]) => gitlabWrite.resolveThread(...a),
  unresolveThread: (...a: unknown[]) => gitlabWrite.unresolveThread(...a),
  mergePullRequest: (...a: unknown[]) => gitlabWrite.mergePullRequest(...a),
  enableAutoMerge: (...a: unknown[]) => gitlabWrite.enableAutoMerge(...a),
  disableAutoMerge: (...a: unknown[]) => gitlabWrite.disableAutoMerge(...a),
}));

const bitbucketWrite = {
  addComment: jest.fn(),
  replyToComment: jest.fn(),
  submitReview: jest.fn(),
  resolveThread: jest.fn(),
  unresolveThread: jest.fn(),
  mergePullRequest: jest.fn(),
};
jest.mock('@/lib/provider-review/bitbucket-write', () => ({
  ...jest.requireActual('@/lib/provider-review/bitbucket-write'),
  addComment: (...a: unknown[]) => bitbucketWrite.addComment(...a),
  replyToComment: (...a: unknown[]) => bitbucketWrite.replyToComment(...a),
  submitReview: (...a: unknown[]) => bitbucketWrite.submitReview(...a),
  resolveThread: (...a: unknown[]) => bitbucketWrite.resolveThread(...a),
  unresolveThread: (...a: unknown[]) => bitbucketWrite.unresolveThread(...a),
  mergePullRequest: (...a: unknown[]) => bitbucketWrite.mergePullRequest(...a),
}));

// ----- fixtures ---------------------------------------------------------------

const gitlabBase = {
  platform: 'gitlab' as const,
  projectPath: 'group/sub/repo',
  mrIid: 7,
};
const bitbucketBase = {
  platform: 'bitbucket' as const,
  organizationId: ORG_ID,
  workspace: 'acme',
  repoSlug: 'widgets',
  prId: 12,
};

function admittedRow(overrides: Partial<OperationLedgerRow> = {}): OperationLedgerRow {
  return {
    id: 'row-1',
    intent: 'create_review_comment',
    resource_key: 'resource-key-under-test',
    status: 'admitted',
    canonical_result: null,
    ...overrides,
  } as OperationLedgerRow;
}

/**
 * Queue an admission outcome whose row MIRRORS the request's identity
 * (intent + resource key) — the router's key-reuse guard refuses a row that
 * does not belong to the request, so branch tests must start from a row the
 * ledger actually returned for this call.
 */
function admittingOnce(admission: string, rowOverrides: Partial<OperationLedgerRow> = {}): void {
  mockAdmitOperation.mockImplementationOnce(async (_db: unknown, args: any) => ({
    admission,
    row: admittedRow({
      intent: args.intent,
      resource_key: args.resourceKey,
      ...rowOverrides,
    }),
  }));
}

function summaryFixture(overrides: Record<string, unknown> = {}) {
  return {
    ref: { platform: 'gitlab', projectPath: 'group/sub/repo', mrIid: 7 },
    state: 'open',
    headSha: 'a'.repeat(40),
    ...overrides,
  };
}

let caller: any;

beforeAll(() => {
  caller = createCallerFactory(providerReviewRouter)({
    user: { id: USER_ID, is_admin: false } as User,
  });
});

beforeEach(() => {
  jest.clearAllMocks();
  mockEnsureOrganizationAccess.mockResolvedValue('member');
  mockAssertTermsAccepted.mockResolvedValue(undefined);
  // Default admission: a fresh row mirroring the request's identity, so
  // happy-path tests pass the reuse guard; mismatch tests override it.
  mockAdmitOperation.mockImplementation(async (_db: unknown, args: any) => ({
    admission: 'admitted',
    row: admittedRow({ intent: args.intent, resource_key: args.resourceKey }),
  }));
  mockSettleOperation.mockResolvedValue({ settled: true, row: admittedRow() });
  mockMarkReconcilePending.mockResolvedValue(admittedRow({ status: 'reconcile_pending' }));
  mockRecordOperationAcceptance.mockResolvedValue(null);
  gitlabRead.getMergeRequest.mockResolvedValue(summaryFixture());
  gitlabWrite.addComment.mockResolvedValue({ done: true, replayed: false });
  gitlabWrite.mergePullRequest.mockResolvedValue({
    done: true,
    replayed: false,
  });
  gitlabWrite.enableAutoMerge.mockResolvedValue({
    done: true,
    replayed: false,
  });
  gitlabWrite.disableAutoMerge.mockResolvedValue({
    done: true,
    replayed: false,
  });
  bitbucketWrite.addComment.mockResolvedValue({ done: true, replayed: false });
});

// ----- inputs are provider-discriminated, strict, and carry no identity -------

describe('providerReviewRouter inputs', () => {
  it('rejects host, token, instanceUrl, and userId fields on the GitLab arm', async () => {
    for (const smuggled of [
      { instanceUrl: 'https://evil.example' },
      { token: 'glpat-secret' },
      { host: 'evil.example' },
      { userId: 'victim' },
    ]) {
      await expect(caller.getPullRequest({ ...gitlabBase, ...smuggled })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
    }
    expect(gitlabRead.getMergeRequest).not.toHaveBeenCalled();
  });

  it('requires organizationId on the Bitbucket arm', async () => {
    await expect(
      caller.getPullRequest({
        platform: 'bitbucket',
        workspace: 'acme',
        repoSlug: 'widgets',
        prId: 12,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(bitbucketRead.getPullRequest).not.toHaveBeenCalled();
  });

  it('accepts the infinite-query direction discriminator on paged inputs', async () => {
    gitlabRead.listChangedFiles.mockResolvedValue({
      items: [],
      nextCursor: null,
    });
    await expect(
      caller.listFiles({ ...gitlabBase, cursor: 'c1', direction: 'forward' })
    ).resolves.toBeDefined();
    expect(gitlabRead.listChangedFiles).toHaveBeenCalledWith(
      { type: 'user', userId: USER_ID },
      'group/sub/repo',
      7,
      'c1',
      undefined
    );
  });
});

// ----- identity is server-derived ----------------------------------------------

describe('providerReviewRouter identity derivation', () => {
  it('runs ensureOrganizationAccess before any provider call when an organizationId is present', async () => {
    gitlabRead.getMergeRequest.mockResolvedValue(summaryFixture());
    await caller.getPullRequest({ ...gitlabBase, organizationId: ORG_ID });
    expect(mockEnsureOrganizationAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        user: expect.objectContaining({ id: USER_ID }),
      }),
      ORG_ID
    );
    expect(gitlabRead.getMergeRequest).toHaveBeenCalledWith(
      { type: 'organization', organizationId: ORG_ID, userId: USER_ID },
      'group/sub/repo',
      7,
      undefined
    );
  });

  it('derives the personal owner from ctx.user, never from input', async () => {
    gitlabRead.getMergeRequest.mockResolvedValue(summaryFixture());
    await caller.getPullRequest(gitlabBase);
    expect(mockEnsureOrganizationAccess).not.toHaveBeenCalled();
    expect(gitlabRead.getMergeRequest).toHaveBeenCalledWith(
      { type: 'user', userId: USER_ID },
      'group/sub/repo',
      7,
      undefined
    );
  });

  it('stops before any provider call when the organization guard rejects', async () => {
    mockEnsureOrganizationAccess.mockRejectedValueOnce(
      new TRPCError({ code: 'FORBIDDEN', message: 'no access' })
    );
    await expect(
      caller.addComment({
        ...bitbucketBase,
        body: 'hi',
        operationKey: 'key-1',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(bitbucketWrite.addComment).not.toHaveBeenCalled();
    expect(mockAdmitOperation).not.toHaveBeenCalled();
  });

  it('passes instanceHint only as a hint to the authorization layer, with the server-derived owner', async () => {
    gitlabRead.getMergeRequest.mockResolvedValue(summaryFixture());
    await caller.getPullRequest({
      ...gitlabBase,
      instanceHint: 'gitlab.example',
    });
    // The hint arrives as the LAST positional argument of the read layer —
    // the layer matches it against the connected instance and refuses a
    // mismatch (gitlab-authorization.test.ts); the router never builds a
    // request from it.
    expect(gitlabRead.getMergeRequest).toHaveBeenCalledWith(
      { type: 'user', userId: USER_ID },
      'group/sub/repo',
      7,
      'gitlab.example'
    );
  });

  it('never lets a page cursor steer which repository is read', async () => {
    gitlabRead.listChangedFiles.mockResolvedValue({
      items: [],
      nextCursor: null,
    });
    // A cursor minted for another repository is still only an opaque page
    // pointer: the router forwards the INPUT's identity, and the provider
    // cursor codec (s2) refuses a cursor bound to a different identity.
    await caller.listFiles({
      ...gitlabBase,
      cursor: Buffer.from(
        JSON.stringify({
          identity: 'gitlab-diff:other/repo#1',
          next: 'https://x/other%2Frepo',
        })
      ).toString('base64url'),
    });
    expect(gitlabRead.listChangedFiles).toHaveBeenCalledWith(
      { type: 'user', userId: USER_ID },
      'group/sub/repo',
      7,
      expect.any(String),
      undefined
    );
  });
});

// ----- the shared operation ledger ------------------------------------------------

describe('providerReviewRouter ledger', () => {
  it('admits provider writes into the shared pr domain with a provider-tagged resource key', async () => {
    await caller.addComment({
      ...gitlabBase,
      body: 'hello',
      operationKey: 'key-1',
    });
    const expectedKey = providerLedgerResourceKey(
      'create_review_comment',
      { platform: 'gitlab', projectPath: 'group/sub/repo', mrIid: 7 },
      {
        platform: 'gitlab',
        projectPath: 'group/sub/repo',
        instanceHint: undefined,
        number: 7,
        body: 'hello',
      }
    );
    expect(mockAdmitOperation).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        userId: USER_ID,
        domain: 'pr',
        intent: 'create_review_comment',
        operationKey: 'key-1',
        taxonomy: 'reconcile-first',
        resourceKey: expectedKey,
      })
    );
    // The resource key carries the provider identity, not the GitHub
    // `owner/repo#number` shape.
    expect(expectedKey.startsWith(JSON.stringify(['gitlab', '', 'group/sub/repo', 7]))).toBe(true);
  });

  it('a GitLab comment and a same-named GitHub comment can never share a ledger key', () => {
    const gitlabKey = providerLedgerResourceKey(
      'create_review_comment',
      { platform: 'gitlab', projectPath: 'octocat/hello', mrIid: 1 },
      {
        platform: 'gitlab',
        projectPath: 'octocat/hello',
        number: 1,
        body: 'same text',
      }
    );
    // The GitHub ledger identity (prLedgerResourceKey) is
    // `owner/repo#number::hash` — a plain string prefix.
    const githubStyle = 'octocat/hello#1::';
    expect(gitlabKey.startsWith(githubStyle)).toBe(false);
    expect(
      gitlabKey.startsWith(
        providerPrRefKey({
          platform: 'gitlab',
          projectPath: 'octocat/hello',
          mrIid: 1,
        })
      )
    ).toBe(true);
    const bitbucketKey = providerLedgerResourceKey(
      'create_review_comment',
      {
        platform: 'bitbucket',
        workspace: 'octocat',
        repoSlug: 'hello',
        prId: 1,
      },
      {
        platform: 'bitbucket',
        workspace: 'octocat',
        repoSlug: 'hello',
        number: 1,
        body: 'same text',
      }
    );
    expect(bitbucketKey.startsWith(githubStyle)).toBe(false);
    expect(bitbucketKey).not.toEqual(gitlabKey);
  });

  it('settles a completed write with the pr_operation_settled outbox event', async () => {
    await caller.addComment({
      ...gitlabBase,
      body: 'hello',
      operationKey: 'key-1',
    });
    expect(mockSettleOperation).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        rowId: 'row-1',
        status: 'completed',
        outcomeCode: 'ok',
        canonicalResult: { done: true, replayed: false },
      })
    );
    const event = (mockSettleOperation.mock.calls[0][1] as { outboxEvent: any }).outboxEvent;
    expect(event.eventName).toBe('pr_operation_settled');
    expect(event.distinctId).toBe(USER_ID);
    expect(event.properties).toMatchObject({
      intent: 'create_review_comment',
      outcome: 'completed',
      surface: 'pr',
    });
  });

  it('replays a settled duplicate without re-executing the provider write', async () => {
    admittingOnce('duplicate_settled', {
      status: 'completed',
      canonical_result: { done: true, replayed: false },
    });
    await expect(
      caller.addComment({
        ...gitlabBase,
        body: 'hello',
        operationKey: 'key-1',
      })
    ).resolves.toEqual({ done: true, replayed: true });
    expect(gitlabWrite.addComment).not.toHaveBeenCalled();
  });

  it('refuses a key reused for a different intent with no effect and no replay', async () => {
    mockAdmitOperation.mockResolvedValueOnce({
      admission: 'admitted',
      row: admittedRow({ intent: 'merge' }),
    });
    await expect(
      caller.addComment({
        ...gitlabBase,
        body: 'hello',
        operationKey: 'key-1',
      })
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'operation_key_reuse_mismatch',
    });
    expect(gitlabWrite.addComment).not.toHaveBeenCalled();
    expect(mockSettleOperation).not.toHaveBeenCalled();
  });

  it('never re-executes an in-flight duplicate', async () => {
    admittingOnce('duplicate_in_flight');
    await expect(
      caller.addComment({
        ...gitlabBase,
        body: 'hello',
        operationKey: 'key-1',
      })
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'operation_in_progress',
    });
    expect(gitlabWrite.addComment).not.toHaveBeenCalled();
  });

  it('runs the UGC terms gate before admission', async () => {
    mockAssertTermsAccepted.mockRejectedValueOnce(
      new TRPCError({ code: 'PRECONDITION_FAILED', message: 'terms_required' })
    );
    await expect(
      caller.addComment({
        ...gitlabBase,
        body: 'hello',
        operationKey: 'key-1',
      })
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'terms_required',
    });
    expect(mockAdmitOperation).not.toHaveBeenCalled();
    expect(gitlabWrite.addComment).not.toHaveBeenCalled();
  });

  it('marks the row reconcile-pending on a retryable provider failure and surfaces the ambiguous marker', async () => {
    gitlabWrite.addComment.mockRejectedValueOnce(
      new GitLabReviewError('retryable', 'Could not reach GitLab. Please try again.')
    );
    await expect(
      caller.addComment({
        ...gitlabBase,
        body: 'hello',
        operationKey: 'key-1',
      })
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: "Couldn't confirm — check the merge request before retrying.",
    });
    expect(mockMarkReconcilePending).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ rowId: 'row-1' })
    );
    // The ambiguous row is NEVER settled terminal.
    expect(mockSettleOperation).not.toHaveBeenCalled();
  });

  it('runs unledgered writes when no operationKey is present', async () => {
    await caller.addComment({ ...gitlabBase, body: 'hello' });
    expect(mockAdmitOperation).not.toHaveBeenCalled();
    expect(gitlabWrite.addComment).toHaveBeenCalledTimes(1);
  });
});

// ----- inline anchors -------------------------------------------------------------

describe('providerReviewRouter inline anchors', () => {
  const anchor = {
    path: 'src/a.ts',
    side: 'RIGHT' as const,
    line: 42,
    startLine: 40,
  };

  it('passes the anchor to the GitLab write and folds it into the fingerprint', async () => {
    await caller.addComment({
      ...gitlabBase,
      body: 'inline',
      anchor,
      operationKey: 'key-1',
    });

    expect(gitlabWrite.addComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'inline', anchor })
    );
    const expectedKey = providerLedgerResourceKey(
      'create_review_comment',
      { platform: 'gitlab', projectPath: 'group/sub/repo', mrIid: 7 },
      {
        platform: 'gitlab',
        projectPath: 'group/sub/repo',
        instanceHint: undefined,
        number: 7,
        body: 'inline',
        path: 'src/a.ts',
        line: 42,
        side: 'RIGHT',
        startLine: 40,
      }
    );
    expect(mockAdmitOperation).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ resourceKey: expectedKey })
    );
  });

  it('passes the anchor to the Bitbucket write and folds it into the fingerprint', async () => {
    await caller.addComment({
      ...bitbucketBase,
      body: 'inline',
      anchor,
      operationKey: 'key-1',
    });

    expect(bitbucketWrite.addComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'inline', anchor })
    );
    const expectedKey = providerLedgerResourceKey(
      'create_review_comment',
      {
        platform: 'bitbucket',
        workspace: 'acme',
        repoSlug: 'widgets',
        prId: 12,
      },
      {
        platform: 'bitbucket',
        workspace: 'acme',
        repoSlug: 'widgets',
        number: 12,
        body: 'inline',
        path: 'src/a.ts',
        line: 42,
        side: 'RIGHT',
        startLine: 40,
      }
    );
    expect(mockAdmitOperation).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ resourceKey: expectedKey })
    );
  });

  it('an anchored and an unanchored comment with the same body never share a ledger key', async () => {
    const anchored = providerLedgerResourceKey(
      'create_review_comment',
      { platform: 'gitlab', projectPath: 'group/sub/repo', mrIid: 7 },
      {
        platform: 'gitlab',
        projectPath: 'group/sub/repo',
        number: 7,
        body: 'same',
        path: 'src/a.ts',
        line: 42,
        side: 'RIGHT',
      }
    );
    const plain = providerLedgerResourceKey(
      'create_review_comment',
      { platform: 'gitlab', projectPath: 'group/sub/repo', mrIid: 7 },
      {
        platform: 'gitlab',
        projectPath: 'group/sub/repo',
        number: 7,
        body: 'same',
      }
    );
    expect(anchored).not.toEqual(plain);
  });

  it('without an anchor the write payload and the fingerprint bytes stay unchanged', async () => {
    await caller.addComment({
      ...gitlabBase,
      body: 'hello',
      operationKey: 'key-1',
    });

    expect(gitlabWrite.addComment).toHaveBeenCalledWith(expect.objectContaining({ body: 'hello' }));
    expect(gitlabWrite.addComment.mock.calls[0][0]).not.toHaveProperty('anchor');
    // The legacy bytes: path/line/side/startLine absent (undefined) still
    // serialize identically, so older clients keep replaying correctly.
    const legacyKey = providerLedgerResourceKey(
      'create_review_comment',
      { platform: 'gitlab', projectPath: 'group/sub/repo', mrIid: 7 },
      {
        platform: 'gitlab',
        projectPath: 'group/sub/repo',
        instanceHint: undefined,
        number: 7,
        body: 'hello',
      }
    );
    expect(mockAdmitOperation).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ resourceKey: legacyKey })
    );
  });

  it('refuses malformed anchors with BAD_REQUEST before any write', async () => {
    for (const bad of [
      { path: 'a.ts', side: 'TOP', line: 1 },
      { path: 'a.ts', side: 'LEFT', line: 0 },
      { path: 'a.ts', side: 'LEFT', line: -3 },
      { path: '', side: 'LEFT', line: 1 },
      { path: 'a.ts', side: 'LEFT', line: 1.5 },
      { path: 'a.ts', side: 'LEFT', line: 1, startLine: 2 },
      { path: 'a.ts', side: 'LEFT', line: 1, extra: true },
      { side: 'LEFT', line: 1 },
    ]) {
      await expect(
        caller.addComment({
          ...gitlabBase,
          body: 'x',
          anchor: bad,
          operationKey: 'k',
        })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
    expect(gitlabWrite.addComment).not.toHaveBeenCalled();
  });

  it('submitReview folds the comment batch into the write and the fingerprint', async () => {
    gitlabWrite.submitReview.mockResolvedValueOnce({
      done: true,
      replayed: false,
    });
    const comments = [
      { path: 'a.ts', side: 'RIGHT' as const, line: 3, body: 'first' },
      {
        path: 'b.ts',
        side: 'LEFT' as const,
        line: 9,
        startLine: 4,
        body: 'second',
      },
    ];

    await caller.submitReview({
      ...gitlabBase,
      event: 'approve',
      body: 'LGTM',
      comments,
      operationKey: 'key-1',
    });

    expect(gitlabWrite.submitReview).toHaveBeenCalledWith(expect.objectContaining({ comments }));
    const expectedKey = providerLedgerResourceKey(
      'submit_review',
      { platform: 'gitlab', projectPath: 'group/sub/repo', mrIid: 7 },
      {
        platform: 'gitlab',
        projectPath: 'group/sub/repo',
        instanceHint: undefined,
        number: 7,
        event: 'approve',
        body: 'LGTM',
        comments,
      }
    );
    expect(mockAdmitOperation).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ resourceKey: expectedKey })
    );
  });

  it('Bitbucket submitReview carries the batch through the same path', async () => {
    bitbucketWrite.submitReview.mockResolvedValueOnce({
      done: true,
      replayed: false,
    });
    const comments = [{ path: 'a.ts', side: 'RIGHT' as const, line: 3, body: 'first' }];

    await caller.submitReview({
      ...bitbucketBase,
      event: 'comment',
      comments,
      operationKey: 'key-1',
    });

    expect(bitbucketWrite.submitReview).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'comment', comments })
    );
  });

  it('a submit without comments keeps the legacy fingerprint bytes', async () => {
    gitlabWrite.submitReview.mockResolvedValueOnce({
      done: true,
      replayed: false,
    });
    await caller.submitReview({
      ...gitlabBase,
      event: 'approve',
      body: 'LGTM',
      operationKey: 'key-1',
    });

    expect(gitlabWrite.submitReview.mock.calls[0][0]).not.toHaveProperty('comments');
    const legacyKey = providerLedgerResourceKey(
      'submit_review',
      { platform: 'gitlab', projectPath: 'group/sub/repo', mrIid: 7 },
      {
        platform: 'gitlab',
        projectPath: 'group/sub/repo',
        instanceHint: undefined,
        number: 7,
        event: 'approve',
        body: 'LGTM',
      }
    );
    expect(mockAdmitOperation).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ resourceKey: legacyKey })
    );
  });

  it('refuses comment items and oversized batches with BAD_REQUEST before any write', async () => {
    await expect(
      caller.submitReview({
        ...gitlabBase,
        event: 'comment',
        comments: [{ path: 'a.ts', side: 'RIGHT', line: 1 }],
        operationKey: 'k',
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller.submitReview({
        ...gitlabBase,
        event: 'comment',
        comments: Array.from({ length: 101 }, (_, i) => ({
          path: 'a.ts',
          side: 'RIGHT' as const,
          line: i + 1,
          body: 'x',
        })),
        operationKey: 'k',
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(gitlabWrite.submitReview).not.toHaveBeenCalled();
  });
});

// ----- moved head blocks merge ---------------------------------------------------

describe('providerReviewRouter merge head fence', () => {
  it('surfaces the exact stale-head reason as a CONFLICT and settles the row failed head_moved', async () => {
    gitlabWrite.mergePullRequest.mockRejectedValueOnce(
      new GitLabReviewError('stale_head', GITLAB_STALE_HEAD_REASON)
    );
    await expect(
      caller.mergePullRequest({
        ...gitlabBase,
        expectedHeadSha: 'a'.repeat(40),
        operationKey: 'key-merge',
      })
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: GITLAB_STALE_HEAD_REASON,
    });
    expect(mockSettleOperation).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ status: 'failed', outcomeCode: 'head_moved' })
    );
    expect(mockMarkReconcilePending).not.toHaveBeenCalled();
  });

  it('reconciles a pending merge by re-reading through the owner-bound reader', async () => {
    admittingOnce('duplicate_reconcile_pending', {
      status: 'reconcile_pending',
    });
    gitlabRead.getMergeRequest.mockResolvedValueOnce(summaryFixture({ state: 'merged' }));
    await expect(
      caller.mergePullRequest({
        ...gitlabBase,
        expectedHeadSha: 'a'.repeat(40),
        operationKey: 'key-merge',
      })
    ).resolves.toMatchObject({ done: true, replayed: true });
    // The reconcile read used the input's identity with the ctx owner — the
    // same authorization the write path uses.
    expect(gitlabRead.getMergeRequest).toHaveBeenCalledWith(
      { type: 'user', userId: USER_ID },
      'group/sub/repo',
      7,
      undefined
    );
    expect(gitlabWrite.mergePullRequest).not.toHaveBeenCalled();
    expect(mockSettleOperation).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        status: 'completed',
        canonicalResult: { done: true, replayed: true },
      })
    );
  });

  it('a reconcile read showing a moved head settles failed confirmed_absent and refuses the merge', async () => {
    admittingOnce('duplicate_reconcile_pending', {
      status: 'reconcile_pending',
    });
    gitlabRead.getMergeRequest.mockResolvedValueOnce(summaryFixture({ headSha: 'b'.repeat(40) }));
    await expect(
      caller.mergePullRequest({
        ...gitlabBase,
        expectedHeadSha: 'a'.repeat(40),
        operationKey: 'key-merge',
      })
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: GITLAB_STALE_HEAD_REASON,
    });
    expect(gitlabWrite.mergePullRequest).not.toHaveBeenCalled();
    expect(mockSettleOperation).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        status: 'failed',
        outcomeCode: 'head_moved',
        outboxEvent: expect.objectContaining({
          properties: expect.objectContaining({
            reconcile_result: 'confirmed_absent',
          }),
        }),
      })
    );
  });

  it('a failed authoritative read stays reconcile-pending instead of settling absent', async () => {
    admittingOnce('duplicate_reconcile_pending', {
      status: 'reconcile_pending',
    });
    gitlabRead.getMergeRequest.mockRejectedValueOnce(new GitLabReviewError('not_found', 'gone'));
    await expect(
      caller.mergePullRequest({
        ...gitlabBase,
        expectedHeadSha: 'a'.repeat(40),
        operationKey: 'key-merge',
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(mockMarkReconcilePending).toHaveBeenCalled();
    expect(mockSettleOperation).not.toHaveBeenCalled();
  });
});

// ----- capabilities and auto-merge --------------------------------------------------

describe('providerReviewRouter capabilities', () => {
  it('answers GitLab with the MR capability list (no request-changes event)', async () => {
    await expect(caller.getCapabilities({ platform: 'gitlab' })).resolves.toEqual(
      GITLAB_MR_REVIEW_CAPABILITIES
    );
    expect(GITLAB_MR_REVIEW_CAPABILITIES.reviewEvents).not.toContain('request_changes');
  });

  it('answers Bitbucket with the shared capability list carrying the auto-merge reason', async () => {
    await expect(
      caller.getCapabilities({ platform: 'bitbucket', organizationId: ORG_ID })
    ).resolves.toEqual(BITBUCKET_PR_REVIEW_CAPABILITIES);
    expect(BITBUCKET_PR_REVIEW_CAPABILITIES.autoMerge).toMatchObject({
      supported: false,
      reason: BITBUCKET_AUTO_MERGE_UNSUPPORTED_REASON,
    });
  });

  it('returns the capability reason for Bitbucket auto-merge without a ledger row', async () => {
    await expect(
      caller.enableAutoMerge({
        ...bitbucketBase,
        expectedHeadSha: 'a'.repeat(40),
        operationKey: 'key-am',
      })
    ).resolves.toEqual({
      supported: false,
      reason: BITBUCKET_AUTO_MERGE_UNSUPPORTED_REASON,
      done: false,
      replayed: false,
    });
    expect(mockAdmitOperation).not.toHaveBeenCalled();
    expect(mockEnsureOrganizationAccess).toHaveBeenCalled();
    await expect(caller.disableAutoMerge({ ...bitbucketBase })).resolves.toMatchObject({
      supported: false,
    });
    expect(mockAdmitOperation).not.toHaveBeenCalled();
  });

  it('runs GitLab auto-merge through the ledger with the auto-merge intents', async () => {
    await expect(
      caller.enableAutoMerge({
        ...gitlabBase,
        expectedHeadSha: 'a'.repeat(40),
        operationKey: 'key-am',
      })
    ).resolves.toEqual({
      supported: true,
      reason: '',
      done: true,
      replayed: false,
    });
    expect(mockAdmitOperation).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ intent: 'enable_auto_merge' })
    );
    await caller.disableAutoMerge({ ...gitlabBase, operationKey: 'key-dam' });
    expect(mockAdmitOperation).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ intent: 'disable_auto_merge' })
    );
  });
});
