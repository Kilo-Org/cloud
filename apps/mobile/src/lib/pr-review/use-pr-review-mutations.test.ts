/* eslint-disable max-lines -- the comment and review-submit suites share one mock harness for the review seam */
// P1-A-08c + s6 wiring tests for `useCreateReviewCommentMutation` and
// `useSubmitReviewMutation`.
//
// The sheet / composer / pending-review surfaces own the inline error
// rendering; these tests assert the HOOK WIRING: each `mutationFn`
// delegates to the matching `trpcClient.<router>.<procedure>.mutate`, the
// hoisted operation key is merged into the input, and the key rotation
// policy (real `isPrMutationRetryable` + `mapPrOperationError`) runs inside
// `mutationFn`. Only `useHoistedOperationKey` is mocked (it holds React ref
// state that needs a mounted renderer, covered by
// `operation-key.mounted.test.tsx`).
//
// s6: the GitHub arms stay byte-identical (same procedures, same inputs,
// same pinned fingerprints). The provider arms route the same intents
// through `providerReview.*` with the s1 provider identity, and the
// fingerprint pins below mirror the server's `gitlabFingerprintInput` /
// `bitbucketFingerprintInput` exactly — a GitLab comment and a same-named
// GitHub comment can never share a ledger key (identity rule 17).
// c3: the provider arms carry the REAL diff position — an `anchor` on
// addComment and a `comments` batch on submitReview — and the pinned
// fingerprints below mirror the server folding the anchor flat and the
// parsed batch into the ledger key.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as OperationKeyModule from '@/lib/operation-key';
import { prIntentFingerprint } from '@kilocode/app-shared/pr-review';
import type * as ProviderPrRefModule from '@/lib/pr-review/provider-pr-ref';
import { type ProviderPrRef, type ProviderPrTriple } from '@/lib/pr-review/provider-pr-ref';
import { useCreateReviewCommentMutation, useSubmitReviewMutation } from './use-pr-review-mutations';

const hoistedKeys = vi.hoisted(() => ({
  getKey: vi.fn((_: string) => 'hoisted-op-key'),
  rotateKey: vi.fn(),
}));

vi.mock('expo-crypto', () => ({
  randomUUID: () => 'not-used',
}));

vi.mock('@/lib/operation-key', async importOriginal => {
  const actual = await importOriginal<typeof OperationKeyModule>();
  return { ...actual, useHoistedOperationKey: () => hoistedKeys };
});

// The hooks read the live provider scope from context. These tests call the
// hooks as plain functions (no renderer), so the context hook is replaced by
// a settable override: null keeps the GitHub fallback the pre-s6 surface
// used; a provider scope drives the provider arms.
let scopeOverride: { ref: ProviderPrRef; organizationId: string | null } | null = null;

vi.mock('@/lib/pr-review/provider-pr-ref', async importOriginal => {
  const actual = await importOriginal<typeof ProviderPrRefModule>();
  return {
    ...actual,
    useProviderPrScope: (fallback: ProviderPrTriple) =>
      scopeOverride ?? { ref: { platform: 'github', ...fallback }, organizationId: null },
  };
});

type MutationOptions = {
  mutationFn?: (vars: unknown) => Promise<unknown>;
  onError?: (error: unknown) => void;
  onSettled?: (data?: unknown, error?: unknown, vars?: unknown) => Promise<void> | void;
};

let lastCapturedOptions: MutationOptions | null = null;
const createCommentMutateMock = vi.fn();
const submitReviewMutateMock = vi.fn();
const providerAddCommentMutateMock = vi.fn();
const providerSubmitReviewMutateMock = vi.fn();
const invalidateQueriesMock = vi.fn();
const toastErrorMock = vi.fn();

vi.mock('@tanstack/react-query', () => ({
  useMutation: (opts: MutationOptions) => {
    lastCapturedOptions = opts;
    return { mutateAsync: vi.fn(), mutate: vi.fn() };
  },
  useQueryClient: () => ({
    invalidateQueries: (...args: unknown[]) => {
      invalidateQueriesMock(...args);
    },
  }),
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    githubPrReview: {
      getPullRequest: { queryKey: () => ['githubPrReview', 'getPullRequest'] },
      listReviewThreads: { pathFilter: () => ['githubPrReview', 'listReviewThreads'] },
    },
    providerReview: {
      getPullRequest: { queryKey: () => ['providerReview', 'getPullRequest'] },
      listDiscussions: { pathFilter: () => ['providerReview', 'listDiscussions'] },
    },
  }),
  trpcClient: {
    githubPrReview: {
      // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
      createReviewComment: { mutate: (vars: unknown) => createCommentMutateMock(vars) },
      // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
      submitReview: { mutate: (vars: unknown) => submitReviewMutateMock(vars) },
    },
    providerReview: {
      // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
      addComment: { mutate: (vars: unknown) => providerAddCommentMutateMock(vars) },
      // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
      submitReview: { mutate: (vars: unknown) => providerSubmitReviewMutateMock(vars) },
    },
  },
}));

vi.mock('sonner-native', () => ({
  toast: { error: (msg: string) => toastErrorMock(msg) },
}));

// Rolldown (Vitest's bundler) cannot parse React Native's Flow source.
// `use-pr-review-mutations` imports `announcingToast`, which imports
// `announce.ts`, which imports `react-native`. Mock only the symbols
// `announce.ts` imports so the module graph loads under Node.
vi.mock('react-native', () => ({
  AccessibilityInfo: {
    announceForAccessibility: vi.fn(),
    setAccessibilityFocus: vi.fn(),
  },
  findNodeHandle: vi.fn(() => null),
}));

const REF = { owner: 'octocat', repo: 'hello', number: 1 };

const GITLAB_REF: ProviderPrRef = {
  platform: 'gitlab',
  projectPath: 'group/sub/app',
  mrIid: 12,
  instanceHint: 'https://gl.example.com',
};

const BITBUCKET_REF: ProviderPrRef = {
  platform: 'bitbucket',
  workspace: 'acme',
  repoSlug: 'widgets',
  prId: 77,
};

const GITLAB_IDENTITY = {
  platform: 'gitlab',
  projectPath: 'group/sub/app',
  mrIid: 12,
  instanceHint: 'https://gl.example.com',
  organizationId: 'org-9',
};

const BITBUCKET_IDENTITY = {
  platform: 'bitbucket',
  workspace: 'acme',
  repoSlug: 'widgets',
  prId: 77,
  organizationId: 'org-9',
};

const COMMENT_INPUT = {
  owner: 'octocat',
  repo: 'hello',
  number: 1,
  body: 'inline nit',
  path: 'README.md',
  line: 3,
  side: 'RIGHT' as const,
  commitSha: 'a'.repeat(40),
};

const REVIEW_INPUT = {
  owner: 'octocat',
  repo: 'hello',
  number: 1,
  event: 'APPROVE' as const,
  body: 'LGTM',
  commitSha: 'a'.repeat(40),
  comments: [{ path: 'README.md', line: 3, side: 'RIGHT' as const, body: 'nit' }],
};

function resetMocks() {
  lastCapturedOptions = null;
  scopeOverride = null;
  createCommentMutateMock.mockReset();
  submitReviewMutateMock.mockReset();
  providerAddCommentMutateMock.mockReset();
  providerSubmitReviewMutateMock.mockReset();
  invalidateQueriesMock.mockReset();
  toastErrorMock.mockReset();
  hoistedKeys.getKey.mockClear();
  hoistedKeys.rotateKey.mockClear();
}

describe('useCreateReviewCommentMutation (P1-A-08c wiring)', () => {
  beforeEach(() => {
    resetMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('delegates the input to createReviewComment.mutate and resolves the reply', async () => {
    const reply = { id: 42, htmlUrl: 'https://example.com' };
    createCommentMutateMock.mockResolvedValueOnce(reply);
    useCreateReviewCommentMutation(REF);

    await expect(lastCapturedOptions?.mutationFn?.(COMMENT_INPUT)).resolves.toEqual(reply);
    expect(createCommentMutateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'octocat',
        repo: 'hello',
        number: 1,
        body: 'inline nit',
        path: 'README.md',
        line: 3,
        side: 'RIGHT',
        commitSha: 'a'.repeat(40),
      })
    );
  });

  it('merges the hoisted operation key into the comment input (P1-A-08c)', async () => {
    createCommentMutateMock.mockResolvedValueOnce({ id: 42 });
    useCreateReviewCommentMutation(REF);

    await lastCapturedOptions?.mutationFn?.(COMMENT_INPUT);

    // The fingerprint is the dedupe identity the server hashes into
    // `resource_key` for 30 days. Pin the exact bytes: a drift in the shared
    // field list must fail here instead of silently rotating in-flight keys.
    expect(hoistedKeys.getKey).toHaveBeenCalledWith(
      '{"resource":["octocat","hello",1],"body":"inline nit","path":"README.md","line":3,"side":"RIGHT","commitSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'
    );
    expect(createCommentMutateMock).toHaveBeenCalledWith(
      expect.objectContaining({ operationKey: 'hoisted-op-key' })
    );
  });

  it('regenerates the key after a successful post (fresh intent next)', async () => {
    createCommentMutateMock.mockResolvedValueOnce({ id: 42 });
    useCreateReviewCommentMutation(REF);

    await lastCapturedOptions?.mutationFn?.(COMMENT_INPUT);

    expect(hoistedKeys.rotateKey).toHaveBeenCalledTimes(1);
  });

  it('keeps the key on an in-progress CONFLICT and maps it onto the comment retryable copy', async () => {
    createCommentMutateMock.mockRejectedValueOnce(new Error('operation_in_progress'));
    useCreateReviewCommentMutation(REF);

    await expect(lastCapturedOptions?.mutationFn?.(COMMENT_INPUT)).rejects.toMatchObject({
      message: 'Could not post comment.',
    });
    expect(hoistedKeys.rotateKey).not.toHaveBeenCalled();
  });

  it('regenerates the key on a non-retryable failure (bad-request ends the intent)', async () => {
    const badRequest = new Error('Cannot approve your own pull request');
    Object.assign(badRequest, { data: { code: 'BAD_REQUEST' } });
    createCommentMutateMock.mockRejectedValueOnce(badRequest);
    useCreateReviewCommentMutation(REF);

    await expect(lastCapturedOptions?.mutationFn?.(COMMENT_INPUT)).rejects.toMatchObject({
      message: 'Cannot approve your own pull request',
    });
    expect(hoistedKeys.rotateKey).toHaveBeenCalledTimes(1);
  });

  it('maps the ambiguous ledger marker onto the verify-before-retrying copy in onError', () => {
    useCreateReviewCommentMutation(REF);
    lastCapturedOptions?.onError?.(new Error("Couldn't confirm — check the PR before retrying."));
    expect(toastErrorMock).toHaveBeenCalledWith("Couldn't confirm — check the PR before retrying.");
  });

  it('onError still toasts the message (so the retryable inline error surfaces)', () => {
    useCreateReviewCommentMutation(REF);
    lastCapturedOptions?.onError?.(new Error('boom'));
    expect(toastErrorMock).toHaveBeenCalledWith('boom');
  });

  it('onSettled invalidates the PR review caches (overview + threads)', async () => {
    useCreateReviewCommentMutation(REF);

    await lastCapturedOptions?.onSettled?.();

    expect(invalidateQueriesMock).toHaveBeenCalledWith({
      queryKey: ['githubPrReview', 'getPullRequest'],
    });
    expect(invalidateQueriesMock).toHaveBeenCalledWith(['githubPrReview', 'listReviewThreads']);
  });
});

describe('useCreateReviewCommentMutation (s6 gitlab arm)', () => {
  beforeEach(() => {
    resetMocks();
    scopeOverride = { ref: GITLAB_REF, organizationId: 'org-9' };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('routes the body through providerReview.addComment with the full identity', async () => {
    providerAddCommentMutateMock.mockResolvedValueOnce({ done: true, replayed: false });
    useCreateReviewCommentMutation(GITLAB_REF);

    await expect(lastCapturedOptions?.mutationFn?.({ body: 'inline nit' })).resolves.toEqual({
      done: true,
      replayed: false,
    });
    expect(createCommentMutateMock).not.toHaveBeenCalled();
    expect(providerAddCommentMutateMock).toHaveBeenCalledWith({
      ...GITLAB_IDENTITY,
      body: 'inline nit',
      operationKey: 'hoisted-op-key',
    });
  });

  it('folds the GitLab instance into the fingerprint (identity rule 17)', async () => {
    providerAddCommentMutateMock.mockResolvedValueOnce({ done: true, replayed: false });
    useCreateReviewCommentMutation(GITLAB_REF);

    await lastCapturedOptions?.mutationFn?.({ body: 'inline nit' });

    // Pinned bytes mirroring the server's gitlabFingerprintInput: platform +
    // instanceHint + projectPath + number (as `number`) + body.
    expect(hoistedKeys.getKey).toHaveBeenCalledWith(
      '{"resource":["gitlab","https://gl.example.com","group/sub/app",12],"body":"inline nit"}'
    );
  });

  it('sends the tapped diff position as the real anchor and folds it into the fingerprint (c3)', async () => {
    providerAddCommentMutateMock.mockResolvedValueOnce({ done: true, replayed: false });
    useCreateReviewCommentMutation(GITLAB_REF);

    await lastCapturedOptions?.mutationFn?.({
      body: 'inline nit',
      anchor: { path: 'src/a.ts', side: 'RIGHT', line: 12, startLine: 10 },
    });
    expect(providerAddCommentMutateMock).toHaveBeenCalledWith({
      ...GITLAB_IDENTITY,
      body: 'inline nit',
      anchor: { path: 'src/a.ts', side: 'RIGHT', line: 12, startLine: 10 },
      operationKey: 'hoisted-op-key',
    });
    // Pinned bytes mirroring the server's gitlabFingerprintInput: the anchor
    // folds FLAT into the s1 create_review_comment field order (body, path,
    // line, side, startLine) — a retried anchored comment keeps its key.
    expect(hoistedKeys.getKey).toHaveBeenCalledWith(
      '{"resource":["gitlab","https://gl.example.com","group/sub/app",12],"body":"inline nit","path":"src/a.ts","line":12,"side":"RIGHT","startLine":10}'
    );
  });

  it('rotates the key when the same body moves to another line (changed intent)', async () => {
    providerAddCommentMutateMock.mockResolvedValue({ done: true, replayed: false });
    useCreateReviewCommentMutation(GITLAB_REF);

    await lastCapturedOptions?.mutationFn?.({
      body: 'inline nit',
      anchor: { path: 'src/a.ts', side: 'RIGHT', line: 12 },
    });
    const atLine12 = hoistedKeys.getKey.mock.calls[0]?.[0];
    await lastCapturedOptions?.mutationFn?.({
      body: 'inline nit',
      anchor: { path: 'src/a.ts', side: 'RIGHT', line: 13 },
    });
    const atLine13 = hoistedKeys.getKey.mock.calls[1]?.[0];
    expect(atLine12).not.toBe(atLine13);
    expect(atLine12).toBe(
      '{"resource":["gitlab","https://gl.example.com","group/sub/app",12],"body":"inline nit","path":"src/a.ts","line":12,"side":"RIGHT"}'
    );
  });

  it('keys a GitLab comment apart from the same GitHub comment and from the same MR on another instance', async () => {
    providerAddCommentMutateMock.mockResolvedValue({ done: true, replayed: false });
    const onInstanceA = prIntentFingerprint('create_review_comment', {
      platform: 'gitlab',
      projectPath: 'group/sub/app',
      instanceHint: 'https://gl.example.com',
      number: 12,
      body: 'inline nit',
    });
    const onInstanceB = prIntentFingerprint('create_review_comment', {
      platform: 'gitlab',
      projectPath: 'group/sub/app',
      instanceHint: 'https://gl.other.example',
      number: 12,
      body: 'inline nit',
    });
    const onGitHub = prIntentFingerprint('create_review_comment', COMMENT_INPUT);
    expect(onInstanceA).not.toBe(onInstanceB);
    expect(onInstanceA).not.toBe(onGitHub);

    useCreateReviewCommentMutation({ ...GITLAB_REF, instanceHint: 'https://gl.other.example' });
    await lastCapturedOptions?.mutationFn?.({ body: 'inline nit' });
    expect(hoistedKeys.getKey).toHaveBeenLastCalledWith(
      '{"resource":["gitlab","https://gl.other.example","group/sub/app",12],"body":"inline nit"}'
    );
  });

  it('keeps the key on an in-progress CONFLICT and rotates on a non-retryable refusal', async () => {
    providerAddCommentMutateMock.mockRejectedValueOnce(new Error('operation_in_progress'));
    useCreateReviewCommentMutation(GITLAB_REF);
    await expect(lastCapturedOptions?.mutationFn?.({ body: 'x' })).rejects.toBeInstanceOf(Error);
    expect(hoistedKeys.rotateKey).not.toHaveBeenCalled();

    const refused = new Error('Merge request is locked');
    Object.assign(refused, { data: { code: 'BAD_REQUEST' } });
    providerAddCommentMutateMock.mockRejectedValueOnce(refused);
    await expect(lastCapturedOptions?.mutationFn?.({ body: 'x' })).rejects.toMatchObject({
      message: 'Merge request is locked',
    });
    expect(hoistedKeys.rotateKey).toHaveBeenCalledTimes(1);
  });

  it('onSettled invalidates the provider caches (overview + discussions)', async () => {
    useCreateReviewCommentMutation(GITLAB_REF);

    await lastCapturedOptions?.onSettled?.();

    expect(invalidateQueriesMock).toHaveBeenCalledWith({
      queryKey: ['providerReview', 'getPullRequest'],
    });
    expect(invalidateQueriesMock).toHaveBeenCalledWith(['providerReview', 'listDiscussions']);
  });
});

describe('useCreateReviewCommentMutation (s6 bitbucket arm)', () => {
  beforeEach(() => {
    resetMocks();
    scopeOverride = { ref: BITBUCKET_REF, organizationId: 'org-9' };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('routes through providerReview.addComment with the workspace identity', async () => {
    providerAddCommentMutateMock.mockResolvedValueOnce({ done: true, replayed: false });
    useCreateReviewCommentMutation(BITBUCKET_REF);

    await lastCapturedOptions?.mutationFn?.({ body: 'inline nit' });
    expect(providerAddCommentMutateMock).toHaveBeenCalledWith({
      ...BITBUCKET_IDENTITY,
      body: 'inline nit',
      operationKey: 'hoisted-op-key',
    });
  });

  it('folds the workspace into the fingerprint (identity rule 17)', async () => {
    providerAddCommentMutateMock.mockResolvedValueOnce({ done: true, replayed: false });
    useCreateReviewCommentMutation(BITBUCKET_REF);

    await lastCapturedOptions?.mutationFn?.({ body: 'inline nit' });
    expect(hoistedKeys.getKey).toHaveBeenCalledWith(
      '{"resource":["bitbucket","acme","widgets",77],"body":"inline nit"}'
    );
  });

  it('sends the anchor through the seam with the workspace fingerprint (c3)', async () => {
    providerAddCommentMutateMock.mockResolvedValueOnce({ done: true, replayed: false });
    useCreateReviewCommentMutation(BITBUCKET_REF);

    await lastCapturedOptions?.mutationFn?.({
      body: 'inline nit',
      anchor: { path: 'src/a.ts', side: 'LEFT', line: 5 },
    });
    expect(providerAddCommentMutateMock).toHaveBeenCalledWith({
      ...BITBUCKET_IDENTITY,
      body: 'inline nit',
      anchor: { path: 'src/a.ts', side: 'LEFT', line: 5 },
      operationKey: 'hoisted-op-key',
    });
    expect(hoistedKeys.getKey).toHaveBeenCalledWith(
      '{"resource":["bitbucket","acme","widgets",77],"body":"inline nit","path":"src/a.ts","line":5,"side":"LEFT"}'
    );
  });
});

describe('useSubmitReviewMutation (P1-A-08c wiring)', () => {
  beforeEach(() => {
    resetMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('delegates the input to submitReview.mutate and resolves the result', async () => {
    const result = { id: 7, reviewDecision: 'APPROVED' };
    submitReviewMutateMock.mockResolvedValueOnce(result);
    useSubmitReviewMutation(REF);

    await expect(lastCapturedOptions?.mutationFn?.(REVIEW_INPUT)).resolves.toEqual(result);
    expect(submitReviewMutateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'octocat',
        repo: 'hello',
        number: 1,
        event: 'APPROVE',
        commitSha: 'a'.repeat(40),
      })
    );
  });

  it('merges the hoisted operation key into the review input (P1-A-08c)', async () => {
    submitReviewMutateMock.mockResolvedValueOnce({ id: 7 });
    useSubmitReviewMutation(REF);

    await lastCapturedOptions?.mutationFn?.(REVIEW_INPUT);

    // The fingerprint is the dedupe identity the server hashes into
    // `resource_key` for 30 days. Pin the exact bytes: a drift in the shared
    // field list must fail here instead of silently rotating in-flight keys.
    expect(hoistedKeys.getKey).toHaveBeenCalledWith(
      '{"resource":["octocat","hello",1],"event":"APPROVE","body":"LGTM","commitSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","comments":[{"path":"README.md","line":3,"side":"RIGHT","body":"nit"}]}'
    );
    expect(submitReviewMutateMock).toHaveBeenCalledWith(
      expect.objectContaining({ operationKey: 'hoisted-op-key' })
    );
  });

  it('regenerates the key after a successful submit (fresh intent next)', async () => {
    submitReviewMutateMock.mockResolvedValueOnce({ id: 7 });
    useSubmitReviewMutation(REF);

    await lastCapturedOptions?.mutationFn?.(REVIEW_INPUT);

    expect(hoistedKeys.rotateKey).toHaveBeenCalledTimes(1);
  });

  it('keeps the key on an in-progress CONFLICT and maps it onto the submit retryable copy', async () => {
    submitReviewMutateMock.mockRejectedValueOnce(new Error('operation_in_progress'));
    useSubmitReviewMutation(REF);

    await expect(lastCapturedOptions?.mutationFn?.(REVIEW_INPUT)).rejects.toMatchObject({
      message: 'Could not submit review. Check your connection and try again.',
    });
    expect(hoistedKeys.rotateKey).not.toHaveBeenCalled();
  });

  it('regenerates the key on a non-retryable failure (bad-request ends the intent)', async () => {
    const badRequest = new Error('Cannot approve your own pull request');
    Object.assign(badRequest, { data: { code: 'BAD_REQUEST' } });
    submitReviewMutateMock.mockRejectedValueOnce(badRequest);
    useSubmitReviewMutation(REF);

    await expect(lastCapturedOptions?.mutationFn?.(REVIEW_INPUT)).rejects.toMatchObject({
      message: 'Cannot approve your own pull request',
    });
    expect(hoistedKeys.rotateKey).toHaveBeenCalledTimes(1);
  });

  it('maps the ambiguous ledger marker onto the verify-before-retrying copy in onError', () => {
    useSubmitReviewMutation(REF);
    lastCapturedOptions?.onError?.(new Error("Couldn't confirm — check the PR before retrying."));
    expect(toastErrorMock).toHaveBeenCalledWith("Couldn't confirm — check the PR before retrying.");
  });

  it('onSettled invalidates the PR review caches (overview + threads)', async () => {
    useSubmitReviewMutation(REF);

    await lastCapturedOptions?.onSettled?.();

    expect(invalidateQueriesMock).toHaveBeenCalledWith({
      queryKey: ['githubPrReview', 'getPullRequest'],
    });
    expect(invalidateQueriesMock).toHaveBeenCalledWith(['githubPrReview', 'listReviewThreads']);
  });
});

describe('useSubmitReviewMutation (s6 provider arms)', () => {
  beforeEach(() => {
    resetMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('gitlab: routes event + summary through providerReview.submitReview', async () => {
    scopeOverride = { ref: GITLAB_REF, organizationId: 'org-9' };
    providerSubmitReviewMutateMock.mockResolvedValueOnce({ done: true, replayed: false });
    useSubmitReviewMutation(GITLAB_REF);

    await lastCapturedOptions?.mutationFn?.({ event: 'approve', body: 'LGTM' });
    expect(submitReviewMutateMock).not.toHaveBeenCalled();
    expect(providerSubmitReviewMutateMock).toHaveBeenCalledWith({
      ...GITLAB_IDENTITY,
      event: 'approve',
      body: 'LGTM',
      operationKey: 'hoisted-op-key',
    });
    // Pinned bytes mirroring the server's submitReview fingerprint input.
    expect(hoistedKeys.getKey).toHaveBeenCalledWith(
      '{"resource":["gitlab","https://gl.example.com","group/sub/app",12],"event":"approve","body":"LGTM"}'
    );
  });

  it('gitlab: an event-only review omits the body from the input and the fingerprint', async () => {
    scopeOverride = { ref: GITLAB_REF, organizationId: 'org-9' };
    providerSubmitReviewMutateMock.mockResolvedValueOnce({ done: true, replayed: false });
    useSubmitReviewMutation(GITLAB_REF);

    await lastCapturedOptions?.mutationFn?.({ event: 'comment' });
    const sent = providerSubmitReviewMutateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent).not.toHaveProperty('body');
    expect(hoistedKeys.getKey).toHaveBeenCalledWith(
      '{"resource":["gitlab","https://gl.example.com","group/sub/app",12],"event":"comment"}'
    );
  });

  it('gitlab: sends the anchored comments batch and folds it into the fingerprint (c3)', async () => {
    scopeOverride = { ref: GITLAB_REF, organizationId: 'org-9' };
    providerSubmitReviewMutateMock.mockResolvedValueOnce({ done: true, replayed: false });
    useSubmitReviewMutation(GITLAB_REF);

    const comments = [
      { path: 'src/a.ts', side: 'RIGHT' as const, line: 10, body: 'first' },
      { path: 'src/b.ts', side: 'LEFT' as const, line: 2, startLine: 1, body: 'second' },
    ];
    await lastCapturedOptions?.mutationFn?.({ event: 'approve', body: 'LGTM', comments });
    expect(providerSubmitReviewMutateMock).toHaveBeenCalledWith({
      ...GITLAB_IDENTITY,
      event: 'approve',
      body: 'LGTM',
      comments,
      operationKey: 'hoisted-op-key',
    });
    // Pinned bytes mirroring the server's submitReview fingerprint input:
    // the batch serializes in the router's field order (path, side, line,
    // startLine, body), so a retried batch keeps its ledger identity.
    expect(hoistedKeys.getKey).toHaveBeenCalledWith(
      '{"resource":["gitlab","https://gl.example.com","group/sub/app",12],"event":"approve","body":"LGTM","comments":[{"path":"src/a.ts","side":"RIGHT","line":10,"body":"first"},{"path":"src/b.ts","side":"LEFT","line":2,"startLine":1,"body":"second"}]}'
    );
  });

  it('gitlab: an empty comments batch is no batch — pre-c3 bytes unchanged (c3)', async () => {
    scopeOverride = { ref: GITLAB_REF, organizationId: 'org-9' };
    providerSubmitReviewMutateMock.mockResolvedValueOnce({ done: true, replayed: false });
    useSubmitReviewMutation(GITLAB_REF);

    await lastCapturedOptions?.mutationFn?.({ event: 'approve', body: 'LGTM', comments: [] });
    const sent = providerSubmitReviewMutateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent).not.toHaveProperty('comments');
    expect(hoistedKeys.getKey).toHaveBeenCalledWith(
      '{"resource":["gitlab","https://gl.example.com","group/sub/app",12],"event":"approve","body":"LGTM"}'
    );
  });

  it('bitbucket: routes request-changes through the seam with the workspace fingerprint', async () => {
    scopeOverride = { ref: BITBUCKET_REF, organizationId: 'org-9' };
    providerSubmitReviewMutateMock.mockResolvedValueOnce({ done: true, replayed: false });
    useSubmitReviewMutation(BITBUCKET_REF);

    await lastCapturedOptions?.mutationFn?.({ event: 'request_changes', body: 'Fix this' });
    expect(providerSubmitReviewMutateMock).toHaveBeenCalledWith({
      ...BITBUCKET_IDENTITY,
      event: 'request_changes',
      body: 'Fix this',
      operationKey: 'hoisted-op-key',
    });
    expect(hoistedKeys.getKey).toHaveBeenCalledWith(
      '{"resource":["bitbucket","acme","widgets",77],"event":"request_changes","body":"Fix this"}'
    );
  });
});

describe('create_review_comment fingerprint (P1-A-08c changed-input)', () => {
  it('stays stable for a retry of the same comment and rotates when any intent input changes', () => {
    const original = prIntentFingerprint('create_review_comment', COMMENT_INPUT);
    expect(prIntentFingerprint('create_review_comment', COMMENT_INPUT)).toBe(original);

    const editedBody = prIntentFingerprint('create_review_comment', {
      ...COMMENT_INPUT,
      body: 'inline nit (edited)',
    });
    expect(editedBody).not.toBe(original);

    const movedLine = prIntentFingerprint('create_review_comment', { ...COMMENT_INPUT, line: 4 });
    expect(movedLine).not.toBe(original);

    const newCommitSha = prIntentFingerprint('create_review_comment', {
      ...COMMENT_INPUT,
      commitSha: 'b'.repeat(40),
    });
    expect(newCommitSha).not.toBe(original);

    const otherRepo = prIntentFingerprint('create_review_comment', {
      ...COMMENT_INPUT,
      repo: 'world',
    });
    expect(otherRepo).not.toBe(original);
  });
});

describe('submit_review fingerprint (P1-A-08c changed-input)', () => {
  it('stays stable for a retry of the same review and rotates when the event or any comment changes', () => {
    const original = prIntentFingerprint('submit_review', REVIEW_INPUT);
    expect(prIntentFingerprint('submit_review', REVIEW_INPUT)).toBe(original);

    const changedEvent = prIntentFingerprint('submit_review', {
      ...REVIEW_INPUT,
      event: 'REQUEST_CHANGES',
    });
    expect(changedEvent).not.toBe(original);

    const changedSummary = prIntentFingerprint('submit_review', {
      ...REVIEW_INPUT,
      body: 'LGTM!!',
    });
    expect(changedSummary).not.toBe(original);

    const changedComment = prIntentFingerprint('submit_review', {
      ...REVIEW_INPUT,
      comments: [{ path: 'README.md', line: 4, side: 'RIGHT' as const, body: 'nit' }],
    });
    expect(changedComment).not.toBe(original);
  });
});

describe('provider pending-comment body builders (s6, c3)', () => {
  it('formatPendingCommentBody anchors a single-line position like the pending list shows it', async () => {
    const { formatPendingCommentBody } = await import('./use-pr-review-mutations');
    expect(formatPendingCommentBody({ path: 'src/a.ts', line: 10, body: 'note' })).toBe(
      'src/a.ts:L10\n\nnote'
    );
    expect(
      formatPendingCommentBody({ path: 'src/a.ts', line: 12, startLine: 10, body: 'range' })
    ).toBe('src/a.ts:L10–L12\n\nrange');
  });
  it('buildProviderSubmitInput sends anchored items as a real comments batch (c3)', async () => {
    const { buildProviderSubmitInput } = await import('./use-pr-review-mutations');
    expect(
      buildProviderSubmitInput('Looks good overall.', [
        { path: 'src/a.ts', side: 'RIGHT' as const, line: 10, body: 'first' },
        { path: 'src/b.ts', side: 'LEFT' as const, line: 2, startLine: 1, body: 'second' },
      ])
    ).toEqual({
      body: 'Looks good overall.',
      comments: [
        { path: 'src/a.ts', side: 'RIGHT', line: 10, body: 'first' },
        { path: 'src/b.ts', side: 'LEFT', line: 2, startLine: 1, body: 'second' },
      ],
    });
  });
  it('buildProviderSubmitInput keeps the text-anchored body for items without an anchor (c3)', async () => {
    const { buildProviderSubmitInput } = await import('./use-pr-review-mutations');
    expect(
      buildProviderSubmitInput('Summary.', [
        { path: 'src/a.ts', line: 10, body: 'folded' },
        { path: 'src/b.ts', side: 'RIGHT' as const, line: 2, body: 'anchored' },
      ])
    ).toEqual({
      body: 'Summary.\n\nsrc/a.ts:L10\n\nfolded',
      comments: [{ path: 'src/b.ts', side: 'RIGHT', line: 2, body: 'anchored' }],
    });
  });
  it('buildProviderSubmitInput drops empty parts: a summary-only approve posts exactly the summary', async () => {
    const { buildProviderSubmitInput } = await import('./use-pr-review-mutations');
    expect(buildProviderSubmitInput('  LGTM  ', [])).toEqual({ body: 'LGTM', comments: [] });
    expect(buildProviderSubmitInput('', [])).toEqual({ body: '', comments: [] });
  });
});
