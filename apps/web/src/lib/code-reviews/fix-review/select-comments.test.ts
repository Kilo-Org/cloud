import { describe, expect, it, jest } from '@jest/globals';
import type { CollaboratorPermission } from '@/lib/integrations/platforms/github/adapter';
import {
  FIX_REVIEW_COMMENT_BODY_MAX_LENGTH,
  FIX_REVIEW_MAX_COMMENTS,
  selectFixReviewComments,
  selectFixReviewCommentsForReview,
  type FixReviewComment,
  type FixReviewCommentClient,
  type FixReviewSelectionDeps,
} from './select-comments';

function comment(overrides: Partial<FixReviewComment> = {}): FixReviewComment {
  return {
    id: 1,
    authorLogin: 'octocat',
    authorType: 'User',
    authorId: 583231,
    path: 'src/widget.ts',
    line: 12,
    body: 'This branch is wrong.',
    ...overrides,
  };
}

function permissionTable(
  table: Record<string, CollaboratorPermission | null>
): (login: string) => Promise<CollaboratorPermission | null> {
  return async login => table[login] ?? null;
}

const NO_SETTLED = new Set<number>();

describe('selectFixReviewComments', () => {
  it('keeps a commenter with write permission and drops read, none, and unknown accounts', async () => {
    const lookupPermission = jest.fn(
      permissionTable({
        maintainer: 'write',
        reader: 'read',
        outsider: 'none',
        ghost: null,
      })
    );

    const selected = await selectFixReviewComments({
      comments: [
        comment({ id: 1, authorLogin: 'maintainer' }),
        comment({ id: 2, authorLogin: 'reader' }),
        comment({ id: 3, authorLogin: 'outsider' }),
        comment({ id: 4, authorLogin: 'ghost' }),
      ],
      trustedLogins: [],
      settledCommentIds: NO_SETTLED,
      lookupPermission,
    });

    expect(selected.map(entry => entry.id)).toEqual([1]);
  });

  it('keeps the run initiator regardless of repository permission', async () => {
    const lookupPermission = jest.fn(permissionTable({}));

    const selected = await selectFixReviewComments({
      comments: [comment({ id: 7, authorLogin: 'Initiator' })],
      trustedLogins: ['initiator'],
      settledCommentIds: NO_SETTLED,
      lookupPermission,
    });

    expect(selected.map(entry => entry.id)).toEqual([7]);
    expect(lookupPermission).not.toHaveBeenCalled();
  });

  it('keeps Kilo review-bot comments by exact bot identity', async () => {
    const lookupPermission = jest.fn(permissionTable({}));

    const selected = await selectFixReviewComments({
      comments: [
        comment({
          id: 11,
          authorLogin: 'kiloconnect[bot]',
          authorType: 'Bot',
          authorId: 240665456,
        }),
        comment({ id: 12, authorLogin: 'kilo-code-bot[bot]', authorType: 'Bot', authorId: 1 }),
        comment({ id: 13, authorLogin: 'some-app[bot]', authorType: 'Bot', authorId: 2 }),
      ],
      trustedLogins: [],
      settledCommentIds: NO_SETTLED,
      lookupPermission,
    });

    expect(selected.map(entry => entry.id)).toEqual([11, 12]);
  });

  it('rejects a human account that imitates a Kilo bot login', async () => {
    const lookupPermission = jest.fn(permissionTable({ 'kiloconnect[bot]': 'read' }));

    const selected = await selectFixReviewComments({
      comments: [
        comment({
          id: 21,
          authorLogin: 'kiloconnect[bot]',
          authorType: 'User',
          authorId: 999,
        }),
      ],
      trustedLogins: [],
      settledCommentIds: NO_SETTLED,
      lookupPermission,
    });

    expect(selected).toEqual([]);
    expect(lookupPermission).toHaveBeenCalledWith('kiloconnect[bot]');
  });

  it('drops comments whose thread is already settled', async () => {
    const selected = await selectFixReviewComments({
      comments: [comment({ id: 31 }), comment({ id: 32 })],
      trustedLogins: ['octocat'],
      settledCommentIds: new Set([31]),
      lookupPermission: permissionTable({}),
    });

    expect(selected.map(entry => entry.id)).toEqual([32]);
  });

  it('looks up each commenter once', async () => {
    const lookupPermission = jest.fn(permissionTable({ maintainer: 'admin' }));

    const selected = await selectFixReviewComments({
      comments: [
        comment({ id: 41, authorLogin: 'maintainer' }),
        comment({ id: 42, authorLogin: 'Maintainer' }),
        comment({ id: 43, authorLogin: 'maintainer' }),
      ],
      trustedLogins: [],
      settledCommentIds: NO_SETTLED,
      lookupPermission,
    });

    expect(selected.map(entry => entry.id)).toEqual([41, 42, 43]);
    expect(lookupPermission).toHaveBeenCalledTimes(1);
  });

  it('caps an oversized comment body and marks it', async () => {
    const [selected] = await selectFixReviewComments({
      comments: [
        comment({
          id: 51,
          authorLogin: 'octocat',
          body: 'x'.repeat(FIX_REVIEW_COMMENT_BODY_MAX_LENGTH + 10),
        }),
      ],
      trustedLogins: ['octocat'],
      settledCommentIds: NO_SETTLED,
      lookupPermission: permissionTable({}),
    });

    expect(selected.body).toBe(
      `${'x'.repeat(FIX_REVIEW_COMMENT_BODY_MAX_LENGTH)}\n[comment truncated]`
    );
  });

  it('does not treat a bot account as the initiator whose name it borrows', async () => {
    const lookupPermission = jest.fn(permissionTable({ 'octocat[bot]': 'read' }));

    const selected = await selectFixReviewComments({
      comments: [
        comment({ id: 61, authorLogin: 'octocat[bot]', authorType: 'Bot', authorId: 991 }),
      ],
      trustedLogins: ['octocat'],
      settledCommentIds: NO_SETTLED,
      lookupPermission,
    });

    expect(selected).toEqual([]);
    expect(lookupPermission).toHaveBeenCalledWith('octocat[bot]');
  });
});

function clientFixture(overrides: Partial<FixReviewCommentClient> = {}): FixReviewCommentClient {
  return {
    listComments: async () => [],
    lookupPermission: async () => null,
    listSettledCommentIds: async () => new Set(),
    ...overrides,
  };
}

function connectedCredential(login: string) {
  return {
    status: 'connected' as const,
    credential: {
      connected: true as const,
      token: 'user-token',
      expiresAtEpochMs: Date.now() + 60_000,
      githubLogin: login,
      authorizationId: 'auth-1',
      credentialVersion: 1,
    },
  };
}

function depsFixture(
  client: FixReviewCommentClient,
  overrides: Partial<FixReviewSelectionDeps> = {}
): FixReviewSelectionDeps {
  return {
    getInitiatorGitHubLogin: async () => 'initiator',
    getUserAccessToken: async () => connectedCredential('initiator'),
    generateInstallationToken: async () => ({ token: 'installation-token' }),
    createCommentClient: () => client,
    ...overrides,
  };
}

describe('selectFixReviewCommentsForReview', () => {
  const baseInput = {
    repositoryFullName: 'owner/repo',
    pullNumber: 123,
    prAuthor: 'author',
    initiatorKiloUserId: 'kilo-user',
  };

  it('reads comments with the linked integration credential and filters them', async () => {
    const client = clientFixture({
      listComments: async () => [
        comment({ id: 1, authorLogin: 'initiator' }),
        comment({ id: 2, authorLogin: 'stranger' }),
      ],
      lookupPermission: async () => 'read',
      listSettledCommentIds: async prAuthor => {
        expect(prAuthor).toBe('author');
        return new Set([3]);
      },
    });
    const createCommentClient = jest.fn<FixReviewSelectionDeps['createCommentClient']>(
      () => client
    );
    const getUserAccessToken = jest.fn<FixReviewSelectionDeps['getUserAccessToken']>();

    const selected = await selectFixReviewCommentsForReview({
      ...baseInput,
      integration: { platform_installation_id: '42', github_app_type: 'lite' },
      deps: depsFixture(client, {
        createCommentClient,
        getUserAccessToken,
        generateInstallationToken: async (installationId, appType) => {
          expect(installationId).toBe('42');
          expect(appType).toBe('lite');
          return { token: 'installation-token' };
        },
      }),
    });

    expect(selected.comments.map(entry => entry.id)).toEqual([1]);
    expect(selected.omittedCount).toBe(0);
    expect(createCommentClient).toHaveBeenCalledWith('installation-token', {
      owner: 'owner',
      repo: 'repo',
      pullNumber: 123,
    });
    expect(getUserAccessToken).not.toHaveBeenCalled();
  });

  it('falls back to the initiator user token when the review has no integration', async () => {
    const client = clientFixture({
      listComments: async () => [comment({ id: 5, authorLogin: 'linked-user' })],
    });
    const createCommentClient = jest.fn<FixReviewSelectionDeps['createCommentClient']>(
      () => client
    );

    const selected = await selectFixReviewCommentsForReview({
      ...baseInput,
      integration: null,
      deps: depsFixture(client, {
        createCommentClient,
        getInitiatorGitHubLogin: async () => null,
        getUserAccessToken: async () => connectedCredential('linked-user'),
      }),
    });

    expect(selected.comments.map(entry => entry.id)).toEqual([5]);
    expect(createCommentClient).toHaveBeenCalledWith('user-token', {
      owner: 'owner',
      repo: 'repo',
      pullNumber: 123,
    });
  });

  it('refuses to select when no GitHub credential is available', async () => {
    const client = clientFixture();

    await expect(
      selectFixReviewCommentsForReview({
        ...baseInput,
        integration: null,
        deps: depsFixture(client, {
          getUserAccessToken: async () => ({ status: 'disconnected', reason: 'not_connected' }),
        }),
      })
    ).rejects.toThrow('No GitHub credential available to verify review comments');
  });

  it('propagates a failed comment listing so the caller can refuse the session', async () => {
    const client = clientFixture({
      listComments: async () => {
        throw new Error('GitHub unavailable');
      },
    });

    await expect(
      selectFixReviewCommentsForReview({
        ...baseInput,
        integration: { platform_installation_id: '42', github_app_type: 'standard' },
        deps: depsFixture(client),
      })
    ).rejects.toThrow('GitHub unavailable');
  });

  it('keeps the prompt within its comment budget and reports the rest', async () => {
    const client = clientFixture({
      listComments: async () =>
        Array.from({ length: FIX_REVIEW_MAX_COMMENTS + 2 }, (_, index) =>
          comment({ id: index + 1, authorLogin: 'initiator' })
        ),
    });

    const selection = await selectFixReviewCommentsForReview({
      ...baseInput,
      integration: { platform_installation_id: '42', github_app_type: 'standard' },
      deps: depsFixture(client),
    });

    expect(selection.comments).toHaveLength(FIX_REVIEW_MAX_COMMENTS);
    expect(selection.omittedCount).toBe(2);
  });
});
