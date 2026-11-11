import { describe, expect, it, jest } from '@jest/globals';
// Must load before the module under test: it registers the log recorder.
import { diagnostics } from './diagnostic-recorder.test-harness';
import { createServer } from 'node:http';
import { Octokit } from '@octokit/rest';
import { inArray } from 'drizzle-orm';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { kilocode_users, user_github_app_tokens } from '@kilocode/db/schema';
import type { CollaboratorPermission } from '@/lib/integrations/platforms/github/adapter';
import {
  FIX_REVIEW_COMMENT_BODY_MAX_LENGTH,
  FIX_REVIEW_MAX_COMMENTS,
  FIX_REVIEW_PERMISSION_LOOKUP_CONCURRENCY,
  FIX_REVIEW_TOTAL_BODY_MAX_LENGTH,
  createFixReviewCommentClient,
  getFixReviewInitiatorIdentity,
  selectFixReviewComments,
  selectFixReviewCommentsForReview,
  type FixReviewComment,
  type FixReviewCommentClient,
  type FixReviewSelectionDeps,
} from './select-comments';

function comment(overrides: Partial<FixReviewComment> = {}): FixReviewComment {
  return {
    id: 1,
    inReplyToId: null,
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
      initiator: null,
      settledCommentIds: NO_SETTLED,
      lookupPermission,
    });

    expect(selected.map(entry => entry.id)).toEqual([1]);
  });

  it('keeps the run initiator regardless of repository permission', async () => {
    const lookupPermission = jest.fn(permissionTable({}));

    const selected = await selectFixReviewComments({
      comments: [comment({ id: 7, authorLogin: 'Initiator' })],
      initiator: { login: 'initiator', githubUserId: null },
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
      initiator: null,
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
      initiator: null,
      settledCommentIds: NO_SETTLED,
      lookupPermission,
    });

    expect(selected).toEqual([]);
    expect(lookupPermission).toHaveBeenCalledWith('kiloconnect[bot]');
  });

  it('drops comments whose thread is already settled', async () => {
    const selected = await selectFixReviewComments({
      comments: [comment({ id: 31 }), comment({ id: 32 })],
      initiator: { login: 'octocat', githubUserId: null },
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
      initiator: null,
      settledCommentIds: NO_SETTLED,
      lookupPermission,
    });

    expect(selected.map(entry => entry.id)).toEqual([41, 42, 43]);
    expect(lookupPermission).toHaveBeenCalledTimes(1);
  });

  it('keeps no more permission lookups in flight than the limit', async () => {
    const authors = Array.from({ length: 20 }, (_, index) => `author-${index}`);
    let inFlight = 0;
    let peakInFlight = 0;
    const lookupPermission = jest.fn(async (_login: string) => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return 'write' as CollaboratorPermission;
    });

    const selected = await selectFixReviewComments({
      comments: authors.flatMap((author, index) => [
        comment({ id: 100 + index * 2, authorLogin: author }),
        comment({ id: 101 + index * 2, authorLogin: author }),
      ]),
      initiator: null,
      settledCommentIds: NO_SETTLED,
      lookupPermission,
    });

    expect(peakInFlight).toBe(FIX_REVIEW_PERMISSION_LOOKUP_CONCURRENCY);
    expect(lookupPermission).toHaveBeenCalledTimes(authors.length);
    expect(selected).toHaveLength(authors.length * 2);
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
      initiator: { login: 'octocat', githubUserId: null },
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
      initiator: { login: 'octocat', githubUserId: null },
      settledCommentIds: NO_SETTLED,
      lookupPermission,
    });

    expect(selected).toEqual([]);
    expect(lookupPermission).toHaveBeenCalledWith('octocat[bot]');
  });

  it('acts on top-level comments only, never on replies', async () => {
    const selected = await selectFixReviewComments({
      comments: [
        comment({ id: 71, authorLogin: 'initiator' }),
        comment({ id: 72, authorLogin: 'initiator', inReplyToId: 71, body: 'Fixed in abc1234.' }),
      ],
      initiator: { login: 'initiator', githubUserId: null },
      settledCommentIds: NO_SETTLED,
      lookupPermission: permissionTable({}),
    });

    expect(selected.map(entry => entry.id)).toEqual([71]);
  });

  it('keeps the initiator account after its login changed', async () => {
    const lookupPermission = jest.fn(permissionTable({}));

    const selected = await selectFixReviewComments({
      comments: [comment({ id: 73, authorLogin: 'current-login' })],
      initiator: { login: 'previous-login', githubUserId: '583231' },
      settledCommentIds: NO_SETTLED,
      lookupPermission,
    });

    expect(selected.map(entry => entry.id)).toEqual([73]);
    expect(lookupPermission).not.toHaveBeenCalled();
  });

  it('does not trust an account that took over the initiator login', async () => {
    const lookupPermission = jest.fn(permissionTable({ octocat: 'read' }));

    const selected = await selectFixReviewComments({
      comments: [comment({ id: 74, authorLogin: 'octocat', authorId: 999_999 })],
      initiator: { login: 'octocat', githubUserId: '583231' },
      settledCommentIds: NO_SETTLED,
      lookupPermission,
    });

    expect(selected).toEqual([]);
    expect(lookupPermission).toHaveBeenCalledWith('octocat');
  });

  it('compares the login when the listing carries no account id', async () => {
    const lookupPermission = jest.fn(permissionTable({}));

    const selected = await selectFixReviewComments({
      comments: [comment({ id: 75, authorLogin: 'Octocat', authorId: null })],
      initiator: { login: 'octocat', githubUserId: '583231' },
      settledCommentIds: NO_SETTLED,
      lookupPermission,
    });

    expect(selected.map(entry => entry.id)).toEqual([75]);
    expect(lookupPermission).not.toHaveBeenCalled();
  });

  it('authorizes only through repository permission with no initiator identity', async () => {
    const lookupPermission = jest.fn(permissionTable({ keeper: 'write', reader: 'read' }));

    const selected = await selectFixReviewComments({
      comments: [
        comment({ id: 76, authorLogin: 'keeper' }),
        comment({ id: 77, authorLogin: 'reader' }),
      ],
      initiator: null,
      settledCommentIds: NO_SETTLED,
      lookupPermission,
    });

    expect(selected.map(entry => entry.id)).toEqual([76]);
  });
});

const baseInput = {
  repositoryFullName: 'owner/repo',
  pullNumber: 123,
  prAuthor: 'author',
  initiatorKiloUserId: 'kilo-user',
};

function clientFixture(overrides: Partial<FixReviewCommentClient> = {}): FixReviewCommentClient {
  return {
    listComments: async () => ({ comments: [], unreadCount: 0 }),
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
    getInitiatorIdentity: async () => ({ login: 'initiator', githubUserId: null }),
    getUserAccessToken: async () => connectedCredential('initiator'),
    generateInstallationToken: async () => ({ token: 'installation-token' }),
    createCommentClient: () => client,
    ...overrides,
  };
}

/** A marker value that a thrown error carries nowhere. */
const PROVIDER_CREDENTIAL = 'sentinel-provider-credential';

/** A read failure as the provider client reports it, including its request metadata. */
function providerFailure(status: number): Error {
  return Object.assign(new Error(`Provider failure ${PROVIDER_CREDENTIAL}`), {
    status,
    request: {
      method: 'GET',
      url: 'https://api.github.com/repos/owner/repo/pulls/123/comments',
      headers: { authorization: `token ${PROVIDER_CREDENTIAL}` },
    },
    response: { status, headers: {}, data: { message: PROVIDER_CREDENTIAL } },
  });
}

function connectWith(login: string, source: 'github_app' | 'provided_token') {
  return {
    status: 'connected' as const,
    credential: {
      connected: true as const,
      token: 'user-token',
      expiresAtEpochMs: Date.now() + 60_000,
      credentialSource: source,
      refreshSupported: source === 'github_app',
      githubLogin: login,
      authorizationId: 'auth-1',
      credentialVersion: 1,
    },
  };
}

/**
 * Asserts the shape of a rejected call: the expected message, no request or
 * provider payload, and no occurrence of the marker value anywhere it reaches.
 */
async function expectSanitizedRejection(
  call: Promise<unknown>,
  expectedMessage: string
): Promise<void> {
  const error: unknown = await call.then(
    () => new Error('the call resolved instead of rejecting'),
    (rejection: unknown) => rejection
  );
  expect(error).toBeInstanceOf(Error);
  if (!(error instanceof Error)) return;
  expect(error.message).toBe(expectedMessage);
  expect(error).not.toHaveProperty('request');
  expect(error).not.toHaveProperty('response');
  expect(error).not.toHaveProperty('status');
  expect(error).not.toHaveProperty('cause');
  expect(error.cause).toBeUndefined();
  expect(JSON.stringify(error)).not.toContain(PROVIDER_CREDENTIAL);
  expect(String(error.stack)).not.toContain(PROVIDER_CREDENTIAL);
  expect(JSON.stringify(diagnostics)).not.toContain(PROVIDER_CREDENTIAL);
}

describe('selectFixReviewCommentsForReview', () => {
  it('reads comments with the linked integration credential and filters them', async () => {
    const client = clientFixture({
      listComments: async () => ({
        comments: [
          comment({ id: 1, authorLogin: 'initiator' }),
          comment({ id: 2, authorLogin: 'stranger' }),
        ],
        unreadCount: 0,
      }),
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
      integration: {
        id: 'integration-1',
        platform_installation_id: '42',
        github_app_type: 'lite',
      },
      deps: depsFixture(client, {
        createCommentClient,
        getUserAccessToken,
        generateInstallationToken: async (installationId, appType, expectedIntegrationId) => {
          expect(installationId).toBe('42');
          expect(appType).toBe('lite');
          expect(expectedIntegrationId).toBe('integration-1');
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
      listComments: async () => ({
        comments: [comment({ id: 5, authorLogin: 'linked-user' })],
        unreadCount: 0,
      }),
    });
    const createCommentClient = jest.fn<FixReviewSelectionDeps['createCommentClient']>(
      () => client
    );

    const selected = await selectFixReviewCommentsForReview({
      ...baseInput,
      integration: null,
      deps: depsFixture(client, {
        createCommentClient,
        getInitiatorIdentity: async () => ({ login: 'linked-user', githubUserId: null }),
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

  it('trusts no login when the user token has no usable binding behind it', async () => {
    const lookupPermission = jest.fn(async (_login: string) => 'read' as CollaboratorPermission);
    const client = clientFixture({
      listComments: async () => ({
        comments: [comment({ id: 6, authorLogin: 'linked-user' })],
        unreadCount: 0,
      }),
      lookupPermission,
    });

    const selected = await selectFixReviewCommentsForReview({
      ...baseInput,
      integration: null,
      deps: depsFixture(client, {
        getInitiatorIdentity: async () => null,
        getUserAccessToken: async () => connectedCredential('linked-user'),
      }),
    });

    expect(selected.comments).toEqual([]);
    expect(lookupPermission).toHaveBeenCalledWith('linked-user');
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

  describe('failure from the GitHub read', () => {
    beforeEach(() => {
      diagnostics.length = 0;
    });

    it('answers a failed comment read on the installation token with one user-facing message', async () => {
      const getUserAccessToken = jest.fn<FixReviewSelectionDeps['getUserAccessToken']>();
      const client = clientFixture({
        listComments: async () => {
          throw providerFailure(403);
        },
      });

      await expectSanitizedRejection(
        selectFixReviewCommentsForReview({
          ...baseInput,
          integration: {
            id: 'integration-1',
            platform_installation_id: '42',
            github_app_type: 'standard',
          },
          deps: depsFixture(client, { getUserAccessToken }),
        }),
        'GitHub review comments are unavailable. Try again.'
      );

      expect(getUserAccessToken).not.toHaveBeenCalled();
      expect(diagnostics).toEqual([
        ['Fix-review comment read failed', { credential: 'installation', status: 403 }],
      ]);
    });

    it('answers a failed review-thread read on the installation token with the same message', async () => {
      const client = clientFixture({
        listSettledCommentIds: async () => {
          throw providerFailure(502);
        },
      });

      await expectSanitizedRejection(
        selectFixReviewCommentsForReview({
          ...baseInput,
          integration: {
            id: 'integration-1',
            platform_installation_id: '42',
            github_app_type: 'standard',
          },
          deps: depsFixture(client),
        }),
        'GitHub review comments are unavailable. Try again.'
      );

      expect(diagnostics).toEqual([
        ['Fix-review comment read failed', { credential: 'installation', status: 502 }],
      ]);
    });

    it('answers a failed read on a refreshable personal credential with the personal-connection message', async () => {
      const getUserAccessToken = jest
        .fn<FixReviewSelectionDeps['getUserAccessToken']>()
        .mockResolvedValueOnce(connectWith('linked-user', 'github_app'));
      const client = clientFixture({
        listComments: async () => {
          throw providerFailure(403);
        },
      });

      await expectSanitizedRejection(
        selectFixReviewCommentsForReview({
          ...baseInput,
          integration: null,
          deps: depsFixture(client, { getUserAccessToken }),
        }),
        'GitHub review comments are unavailable. Check your personal connection and try again.'
      );

      // The token service refreshes a GitHub App credential itself, so the read
      // failure is not reported as a rejected credential.
      expect(getUserAccessToken).toHaveBeenCalledTimes(1);
      expect(getUserAccessToken).toHaveBeenCalledWith(baseInput.initiatorKiloUserId, {
        op: 'fetch',
      });
      expect(diagnostics).toEqual([
        ['Fix-review comment read failed', { credential: 'github_app', status: 403 }],
      ]);
    });

    it('answers an authentication rejection on a refreshable personal credential without reporting it', async () => {
      const getUserAccessToken = jest
        .fn<FixReviewSelectionDeps['getUserAccessToken']>()
        .mockResolvedValueOnce(connectWith('linked-user', 'github_app'));
      const client = clientFixture({
        listComments: async () => {
          throw providerFailure(401);
        },
      });

      await expectSanitizedRejection(
        selectFixReviewCommentsForReview({
          ...baseInput,
          integration: null,
          deps: depsFixture(client, { getUserAccessToken }),
        }),
        'GitHub review comments are unavailable. Check your personal connection and try again.'
      );

      expect(getUserAccessToken).toHaveBeenCalledTimes(1);
    });

    it('answers a real provider client failure with one user-facing message', async () => {
      const receivedAuthorization: (string | undefined)[] = [];
      const server = createServer((request, response) => {
        receivedAuthorization.push(request.headers.authorization);
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ message: 'Bad credentials' }));
      });
      const listening = Promise.withResolvers<void>();
      server.listen(0, '127.0.0.1', listening.resolve);
      await listening.promise;
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('no server address');
      const baseUrl = `http://127.0.0.1:${address.port}`;

      try {
        await expectSanitizedRejection(
          selectFixReviewCommentsForReview({
            ...baseInput,
            integration: {
              id: 'integration-1',
              platform_installation_id: '42',
              github_app_type: 'standard',
            },
            deps: {
              generateInstallationToken: async () => ({ token: PROVIDER_CREDENTIAL }),
              createCommentClient: (token, target) =>
                createFixReviewCommentClient(
                  new Octokit({
                    auth: token,
                    baseUrl,
                    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
                  }),
                  target
                ),
            },
          }),
          'GitHub review comments are unavailable. Try again.'
        );
      } finally {
        const closed = Promise.withResolvers<void>();
        server.close(() => closed.resolve());
        await closed.promise;
      }

      // Every read reached the local server with the token, so each failure came
      // from the real provider client.
      expect(receivedAuthorization.length).toBeGreaterThan(0);
      expect(receivedAuthorization).toEqual(
        receivedAuthorization.map(() => `token ${PROVIDER_CREDENTIAL}`)
      );
    });
  });

  it('keeps the most recent comments within the prompt budget and reports the rest', async () => {
    const client = clientFixture({
      listComments: async () => ({
        comments: Array.from({ length: FIX_REVIEW_MAX_COMMENTS + 2 }, (_, index) =>
          comment({ id: index + 1, authorLogin: 'initiator' })
        ),
        unreadCount: 0,
      }),
    });

    const selection = await selectFixReviewCommentsForReview({
      ...baseInput,
      integration: {
        id: 'integration-1',
        platform_installation_id: '42',
        github_app_type: 'standard',
      },
      deps: depsFixture(client),
    });

    expect(selection.comments).toHaveLength(FIX_REVIEW_MAX_COMMENTS);
    expect(selection.comments[0].id).toBe(3);
    expect(selection.comments.at(-1)?.id).toBe(FIX_REVIEW_MAX_COMMENTS + 2);
    expect(selection.omittedCount).toBe(2);
  });

  it('also bounds the total comment text in the prompt', async () => {
    const body = 'x'.repeat(4_000);
    const client = clientFixture({
      listComments: async () => ({
        comments: Array.from({ length: 12 }, (_, index) =>
          comment({ id: index + 1, authorLogin: 'initiator', body })
        ),
        unreadCount: 0,
      }),
    });

    const selection = await selectFixReviewCommentsForReview({
      ...baseInput,
      integration: {
        id: 'integration-1',
        platform_installation_id: '42',
        github_app_type: 'standard',
      },
      deps: depsFixture(client),
    });

    expect(selection.comments).toHaveLength(FIX_REVIEW_TOTAL_BODY_MAX_LENGTH / body.length);
    expect(selection.omittedCount).toBe(2);
  });

  it('reports the comments the read did not fetch as omitted', async () => {
    const client = clientFixture({
      listComments: async () => ({
        comments: Array.from({ length: FIX_REVIEW_MAX_COMMENTS + 2 }, (_, index) =>
          comment({ id: index + 1, authorLogin: 'initiator' })
        ),
        unreadCount: 7,
      }),
    });

    const selection = await selectFixReviewCommentsForReview({
      ...baseInput,
      integration: {
        id: 'integration-1',
        platform_installation_id: '42',
        github_app_type: 'standard',
      },
      deps: depsFixture(client),
    });

    expect(selection.comments).toHaveLength(FIX_REVIEW_MAX_COMMENTS);
    expect(selection.omittedCount).toBe(9);
  });
  it.each([401, 403, 404, 500])(
    'handles provided credential failure %s without exposing the provider request',
    async status => {
      diagnostics.length = 0;
      const credential = connectedCredential('linked-user');
      const getUserAccessToken = jest
        .fn<FixReviewSelectionDeps['getUserAccessToken']>()
        .mockResolvedValueOnce({
          ...credential,
          credential: {
            ...credential.credential,
            expiresAtEpochMs: null,
            credentialSource: 'provided_token',
            refreshSupported: false,
          },
        })
        .mockResolvedValueOnce({ status: 'disconnected', reason: 'revoked' });
      const client = clientFixture({
        listComments: async () => {
          throw providerFailure(status);
        },
      });
      await expectSanitizedRejection(
        selectFixReviewCommentsForReview({
          ...baseInput,
          integration: null,
          deps: depsFixture(client, { getUserAccessToken }),
        }),
        'GitHub review comments are unavailable. Check your personal connection and try again.'
      );
      expect(getUserAccessToken).toHaveBeenCalledTimes(status === 401 ? 2 : 1);
      if (status === 401)
        expect(getUserAccessToken).toHaveBeenLastCalledWith(baseInput.initiatorKiloUserId, {
          op: 'reportRejected',
          authorizationId: credential.credential.authorizationId,
          credentialVersion: credential.credential.credentialVersion,
        });
      expect(diagnostics).toEqual([
        ['Fix-review comment read failed', { credential: 'provided_token', status }],
      ]);
    }
  );
});

describe('initiator identity from the personal GitHub binding', () => {
  let createdUserIds: string[] = [];
  const HOUR = 3_600_000;
  const reviewInput = {
    repositoryFullName: 'owner/repo',
    pullNumber: 123,
    prAuthor: 'author',
  };

  afterEach(async () => {
    if (createdUserIds.length > 0) {
      await db
        .delete(user_github_app_tokens)
        .where(inArray(user_github_app_tokens.kilo_user_id, createdUserIds));
      await db.delete(kilocode_users).where(inArray(kilocode_users.id, createdUserIds));
    }
    createdUserIds = [];
  });

  async function insertBinding(
    overrides: Partial<typeof user_github_app_tokens.$inferInsert> = {}
  ): Promise<{ kiloUserId: string; githubUserId: string; login: string }> {
    const user = await insertTestUser();
    createdUserIds.push(user.id);
    const githubUserId = '583231';
    const login = 'octocat';
    await db.insert(user_github_app_tokens).values({
      kilo_user_id: user.id,
      github_app_type: 'standard',
      github_user_id: githubUserId,
      github_login: login,
      access_token_encrypted: 'envelope:access-token:test',
      access_token_expires_at: new Date(Date.now() + HOUR).toISOString(),
      refresh_token_encrypted: 'envelope:refresh-token:test',
      refresh_token_expires_at: new Date(Date.now() + 2 * HOUR).toISOString(),
      ...overrides,
    });
    return { kiloUserId: user.id, githubUserId, login };
  }

  it('resolves the recorded account while the binding is live', async () => {
    const binding = await insertBinding();

    await expect(getFixReviewInitiatorIdentity(binding.kiloUserId)).resolves.toEqual({
      login: 'octocat',
      githubUserId: '583231',
    });
  });

  it('resolves no account for a revoked binding', async () => {
    const binding = await insertBinding({
      revoked_at: new Date(Date.now() - 1_000).toISOString(),
      revocation_reason: 'github_app_authorization',
    });

    await expect(getFixReviewInitiatorIdentity(binding.kiloUserId)).resolves.toBeNull();
  });

  it('resolves no account for an expired provided token', async () => {
    const binding = await insertBinding({
      credential_source: 'provided_token',
      access_token_expires_at: new Date(Date.now() - 1_000).toISOString(),
      refresh_token_encrypted: null,
      refresh_token_expires_at: null,
    });

    await expect(getFixReviewInitiatorIdentity(binding.kiloUserId)).resolves.toBeNull();
  });

  it('resolves no account when the user never connected one', async () => {
    const user = await insertTestUser();
    createdUserIds.push(user.id);

    await expect(getFixReviewInitiatorIdentity(user.id)).resolves.toBeNull();
  });

  it('trusts the live binding without a permission lookup', async () => {
    const binding = await insertBinding();
    const lookupPermission = jest.fn(async (_login: string) => 'read' as CollaboratorPermission);
    const client = clientFixture({
      listComments: async () => ({
        comments: [comment({ id: 81, authorLogin: 'octocat', authorId: 583_231 })],
        unreadCount: 0,
      }),
      lookupPermission,
    });
    const createCommentClient = jest.fn<FixReviewSelectionDeps['createCommentClient']>(
      () => client
    );

    const selection = await selectFixReviewCommentsForReview({
      ...reviewInput,
      initiatorKiloUserId: binding.kiloUserId,
      integration: {
        id: 'integration-1',
        platform_installation_id: '42',
        github_app_type: 'standard',
      },
      deps: {
        createCommentClient,
        generateInstallationToken: async () => ({ token: 'installation-token' }),
      },
    });

    expect(selection.comments.map(entry => entry.id)).toEqual([81]);
    expect(lookupPermission).not.toHaveBeenCalled();
  });

  it('falls back to the permission lookup when the binding is revoked', async () => {
    const binding = await insertBinding({
      revoked_at: new Date(Date.now() - 1_000).toISOString(),
      revocation_reason: 'github_app_authorization',
    });
    const lookupPermission = jest.fn(async (_login: string) => 'read' as CollaboratorPermission);
    const client = clientFixture({
      listComments: async () => ({
        comments: [comment({ id: 82, authorLogin: 'octocat', authorId: 583_231 })],
        unreadCount: 0,
      }),
      lookupPermission,
    });
    const createCommentClient = jest.fn<FixReviewSelectionDeps['createCommentClient']>(
      () => client
    );

    const selection = await selectFixReviewCommentsForReview({
      ...reviewInput,
      initiatorKiloUserId: binding.kiloUserId,
      integration: {
        id: 'integration-1',
        platform_installation_id: '42',
        github_app_type: 'standard',
      },
      deps: {
        createCommentClient,
        generateInstallationToken: async () => ({ token: 'installation-token' }),
      },
    });

    expect(selection.comments).toEqual([]);
    expect(lookupPermission).toHaveBeenCalledWith('octocat');
  });
});
