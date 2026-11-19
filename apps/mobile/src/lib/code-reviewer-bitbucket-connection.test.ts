import { describe, expect, it, vi } from 'vitest';

import {
  type BitbucketIntegrationStatus,
  type BitbucketReadiness,
  bitbucketRowStatus,
  classifyBitbucketConnection,
} from './code-reviewer-bitbucket';

/**
 * One readiness state, from the connected-and-ready shape plus the fields a
 * case changes. The server answers a discriminated union per connection state,
 * so the assembled object is named as one member at this test seam rather than
 * repeated in full by every case.
 */
function readiness(overrides: Partial<BitbucketReadiness> = {}): BitbucketReadiness {
  const assembled = {
    connected: true,
    ready: true,
    integrationId: 'integration-1',
    workspace: { uuid: 'workspace-1', slug: 'acme', displayName: 'Acme' },
    missingRequiredScopes: [],
    repositoryCache: {
      status: 'available',
      repositories: [],
      syncedAt: '2026-01-01T00:00:00.000Z',
    },
    canManage: true,
    canTriggerManualReview: false,
    ...overrides,
  };
  // The server answers one union member per connection state; this fixture
  // assembles the connected shape and each case names the fields it changes.
  return assembled as BitbucketReadiness;
}

/**
 * One integration-status state, from the OAuth connected shape plus the fields
 * a case changes. The token connection's method is spelled
 * `workspace_access_token`; only an existing OAuth integration answers with
 * `oauth`.
 */
function status(
  overrides: Partial<BitbucketIntegrationStatus> & {
    method?: 'oauth' | 'workspace_access_token';
  } = {}
): BitbucketIntegrationStatus {
  const assembled = {
    method: 'oauth',
    status: 'connected',
    integrationId: 'oauth-1',
    integrationStatus: 'active',
    recoveryAction: null,
    workspace: { uuid: 'workspace-1', slug: 'acme', displayName: 'Acme' },
    authorizingNickname: 'acme-authorizer',
    invalidatedAt: null,
    invalidationReason: null,
    expiresAt: null,
    lastValidatedAt: '2026-01-01T00:00:00.000Z',
    repositoryCache: {
      status: 'available',
      repositories: [],
      syncedAt: '2026-01-01T00:00:00.000Z',
    },
    canManage: true,
    ...overrides,
  };
  return assembled as BitbucketIntegrationStatus;
}

describe('classifyBitbucketConnection', () => {
  /** Both reads settled on their answers with nothing in flight. */
  function settled() {
    return {
      isLoading: false,
      isPending: false,
      isError: false,
      isFetching: false,
      refetch: vi.fn<() => void>(),
    };
  }

  it('prefers a token connection over a stale OAuth status answer', () => {
    expect(
      classifyBitbucketConnection({
        readiness: { ...settled(), data: readiness() },
        status: { ...settled(), data: status() },
      })
    ).toEqual({ kind: 'token-connected', readiness: readiness() });
  });

  it('reports an OAuth connected workspace from the status read alone', () => {
    expect(
      classifyBitbucketConnection({
        readiness: {
          ...settled(),
          data: readiness({
            connected: false,
            ready: false,
            integrationId: null,
            workspace: null,
            missingRequiredScopes: ['account', 'repository'],
            repositoryCache: { status: 'uninitialized', repositories: [], syncedAt: null },
          }),
        },
        status: { ...settled(), data: status() },
      })
    ).toEqual({
      kind: 'oauth-connected',
      workspace: { slug: 'acme', displayName: 'Acme' },
    });
  });

  it('names a missing OAuth workspace with nulls instead of undefined fields', () => {
    expect(
      classifyBitbucketConnection({
        readiness: { ...settled(), data: undefined },
        status: { ...settled(), data: status({ workspace: null }) },
      })
    ).toEqual({
      kind: 'oauth-connected',
      workspace: { slug: null, displayName: null },
    });
  });

  it('keeps the read-only surface for both authorized-but-unusable OAuth statuses', () => {
    for (const oauthStatus of ['workspace_selection_required', 'reconnect_required'] as const) {
      expect(
        classifyBitbucketConnection({
          readiness: { ...settled(), data: undefined },
          status: { ...settled(), data: status({ status: oauthStatus, workspace: null }) },
        })
      ).toEqual({ kind: 'oauth-attention' });
    }
  });

  it('reads one pending read with no error as still loading', () => {
    expect(
      classifyBitbucketConnection({
        readiness: { ...settled(), isLoading: true, isPending: true, data: undefined },
        status: { ...settled(), isPending: true, data: undefined },
      })
    ).toEqual({ kind: 'loading' });
    // The status read alone can still be deciding: the loading state is the
    // surface's cue to wait for both.
    expect(
      classifyBitbucketConnection({
        readiness: { ...settled(), data: undefined },
        status: { ...settled(), isLoading: true, isPending: true, data: undefined },
      })
    ).toEqual({ kind: 'loading' });
  });

  it('does not read a settled read with no data and nothing in flight as loading', () => {
    // react-query with `enabled: false` settles on `pending` with no fetch and
    // no error: the readiness read answered off, so the loading cue is the
    // status read's alone.
    expect(
      classifyBitbucketConnection({
        readiness: { ...settled(), data: undefined },
        status: { ...settled(), isPending: true, data: undefined },
      })
    ).toEqual({ kind: 'loading' });
  });

  it('classifies a failed read without data as the error state', () => {
    const retryStatusRefetch = vi.fn<() => void>();
    const connection = classifyBitbucketConnection({
      readiness: {
        ...settled(),
        isError: true,
        error: { data: { code: 'INTERNAL_SERVER_ERROR' } },
        data: undefined,
      },
      status: { ...settled(), refetch: retryStatusRefetch, data: undefined },
    });
    expect(connection).toMatchObject({
      kind: 'error',
      permanent: false,
      variant: 'server',
    });
    // The two reads name one connection: a retry re-runs both.
    if (connection.kind === 'error') {
      connection.refetch();
    }
    expect(retryStatusRefetch).toHaveBeenCalledTimes(1);
  });

  it('reads a denied readiness read as a permanent permission error', () => {
    const connection = classifyBitbucketConnection({
      readiness: {
        ...settled(),
        isError: true,
        error: { data: { code: 'UNAUTHORIZED' } },
        data: undefined,
      },
      status: { ...settled(), data: undefined },
    });
    expect(connection).toMatchObject({ kind: 'error', permanent: true, variant: 'permission' });
  });

  it('prefers the readiness failure when both reads failed', () => {
    expect(
      classifyBitbucketConnection({
        readiness: {
          ...settled(),
          isError: true,
          error: { data: { code: 'NOT_FOUND' } },
          data: undefined,
        },
        status: {
          ...settled(),
          isError: true,
          error: { data: { code: 'INTERNAL_SERVER_ERROR' } },
          data: undefined,
        },
      })
    ).toMatchObject({ kind: 'error', permanent: true, variant: 'not-found' });
  });

  it('falls through to not-connected when neither read names a connection', () => {
    const readinessData = readiness({
      connected: false,
      ready: false,
      integrationId: null,
      workspace: null,
      missingRequiredScopes: ['account', 'repository'],
      repositoryCache: { status: 'uninitialized', repositories: [], syncedAt: null },
    });
    expect(
      classifyBitbucketConnection({
        readiness: { ...settled(), data: readinessData },
        status: {
          ...settled(),
          data: status({ method: 'workspace_access_token', status: 'not_connected' }),
        },
      })
    ).toEqual({ kind: 'not-connected', readiness: readinessData });
  });

  it('carries an undefined readiness answer into not-connected', () => {
    expect(
      classifyBitbucketConnection({
        readiness: { ...settled(), data: undefined },
        status: { ...settled(), data: status({ method: 'workspace_access_token' }) },
      })
    ).toEqual({ kind: 'not-connected', readiness: undefined });
  });
});

describe('bitbucketRowStatus', () => {
  it('maps every connection state to its one row word', () => {
    const connectedReadiness = readiness();
    const notConnectedReadiness = readiness({
      connected: false,
      ready: false,
      integrationId: null,
      workspace: null,
      missingRequiredScopes: ['account', 'repository'],
      repositoryCache: { status: 'uninitialized', repositories: [], syncedAt: null },
    });
    const cases = [
      { connection: { kind: 'loading' }, row: 'checking' },
      {
        connection: {
          kind: 'error',
          permanent: false,
          variant: 'server',
          refetch: () => undefined,
          isRetrying: false,
        },
        row: 'status-unavailable',
      },
      { connection: { kind: 'token-connected', readiness: connectedReadiness }, row: 'connected' },
      {
        connection: { kind: 'oauth-connected', workspace: { slug: 'acme', displayName: 'Acme' } },
        row: 'connected',
      },
      { connection: { kind: 'oauth-attention' }, row: 'needs-attention' },
      {
        connection: { kind: 'not-connected', readiness: notConnectedReadiness },
        row: 'not-connected',
      },
    ] as const;
    for (const { connection, row } of cases) {
      expect(bitbucketRowStatus(connection)).toBe(row);
    }
  });
});
