import { describe, expect, it } from 'vitest';

import {
  BITBUCKET_TOKEN_MAX_LENGTH,
  bitbucketConnectionFailure,
  type BitbucketReadiness,
  bitbucketRepair,
  readBitbucketToken,
} from './code-reviewer-bitbucket';

const translate = (key: string) => key;

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

describe('readBitbucketToken', () => {
  it('treats an empty or whitespace-only field as empty', () => {
    expect(readBitbucketToken('')).toEqual({ kind: 'empty' });
    expect(readBitbucketToken('   \n ')).toEqual({ kind: 'empty' });
  });

  it('trims the token the server would receive', () => {
    expect(readBitbucketToken('  token-value  ')).toEqual({
      kind: 'ready',
      token: 'token-value',
    });
  });

  it('accepts a token at the server limit and refuses a longer one', () => {
    const atLimit = 'a'.repeat(BITBUCKET_TOKEN_MAX_LENGTH);
    expect(readBitbucketToken(atLimit)).toEqual({ kind: 'ready', token: atLimit });
    expect(readBitbucketToken(`${atLimit}a`)).toEqual({ kind: 'too-long' });
  });
});

describe('bitbucketRepair', () => {
  it('connects a workspace with no integration', () => {
    expect(
      bitbucketRepair(
        readiness({
          connected: false,
          ready: false,
          integrationId: null,
          workspace: null,
          missingRequiredScopes: ['account', 'repository'],
          repositoryCache: { status: 'uninitialized', repositories: [], syncedAt: null },
        })
      )
    ).toEqual({ kind: 'connect' });
  });

  it('replaces the token of an integration Bitbucket refused', () => {
    expect(
      bitbucketRepair(
        readiness({
          connected: false,
          ready: false,
          workspace: null,
          missingRequiredScopes: ['account'],
          repositoryCache: { status: 'uninitialized', repositories: [], syncedAt: null },
        })
      )
    ).toEqual({ kind: 'replace-token' });
  });

  it('replaces a token that is missing a required scope', () => {
    expect(
      bitbucketRepair(readiness({ ready: false, missingRequiredScopes: ['webhook'] }))
    ).toEqual({ kind: 'replace-token' });
  });

  it('refreshes the cache of a workspace whose token still works', () => {
    expect(
      bitbucketRepair(
        readiness({
          ready: false,
          repositoryCache: { status: 'uninitialized', repositories: [], syncedAt: null },
        })
      )
    ).toEqual({ kind: 'refresh-repositories', integrationId: 'integration-1' });
  });

  it('names the web page for a workspace connected through Bitbucket OAuth', () => {
    // The readiness read describes workspace access tokens only, so an OAuth
    // organization reaches the repair looking like one with no integration.
    expect(
      bitbucketRepair(
        readiness({
          connected: false,
          ready: false,
          integrationId: null,
          workspace: null,
          missingRequiredScopes: ['account', 'repository'],
          repositoryCache: { status: 'uninitialized', repositories: [], syncedAt: null },
        }),
        { method: 'oauth' }
      )
    ).toEqual({ kind: 'manage-connection' });
  });

  it('connects when the status read names a token row the readiness read cannot name', () => {
    // Only an OAuth authorization makes the form refuse to connect; a token
    // row the readiness read did not report still needs the token form.
    expect(
      bitbucketRepair(
        readiness({
          connected: false,
          ready: false,
          integrationId: null,
          workspace: null,
          missingRequiredScopes: ['account'],
          repositoryCache: { status: 'uninitialized', repositories: [], syncedAt: null },
        }),
        { method: 'workspace_access_token' }
      )
    ).toEqual({ kind: 'connect' });
  });

  it('does not send a usable workspace to the web page for a stale OAuth answer', () => {
    // One integration per organization: a readiness answer that names a working
    // token integration outranks a status read that still calls it OAuth.
    expect(bitbucketRepair(readiness(), { method: 'oauth' })).toEqual({
      kind: 'refresh-repositories',
      integrationId: 'integration-1',
    });
  });
});

describe('bitbucketConnectionFailure', () => {
  it('reads a refused token as a token problem', () => {
    expect(
      bitbucketConnectionFailure(
        {
          data: { code: 'UNAUTHORIZED', message: 'Bitbucket rejected the Workspace Access Token' },
        },
        translate
      )
    ).toEqual({
      kind: 'token-refused',
      message: 'prReview.reconnectNotice.bitbucketTitle',
    });
  });

  it('reads the shaped envelope a cache refresh rejects with', () => {
    expect(
      bitbucketConnectionFailure(
        { shape: { data: { code: 'UNAUTHORIZED', message: 'The saved token expired' } } },
        translate
      )
    ).toEqual({
      kind: 'token-refused',
      message: 'prReview.reconnectNotice.bitbucketTitle',
    });
  });

  it('reads every refusal sentence for a lost billing role as a role problem', () => {
    for (const message of [
      'You do not have the required organizational role to access this feature',
      'You do not have access to this organization',
      'The current user cannot manage this organization integration',
    ]) {
      expect(
        bitbucketConnectionFailure({ data: { code: 'UNAUTHORIZED', message } }, translate)
      ).toEqual({
        kind: 'role-refused',
        message: 'prReview.connect.bitbucketAdminOnlyDescription',
      });
    }
  });

  it('reads an unprocessable token as a token problem', () => {
    for (const code of ['BAD_REQUEST', 'FORBIDDEN', 'UNPROCESSABLE_CONTENT']) {
      expect(bitbucketConnectionFailure({ data: { code } }, translate).kind).toBe('token-refused');
    }
  });

  it('reads a changed connection as one the sheet must reopen', () => {
    for (const code of ['CONFLICT', 'NOT_FOUND']) {
      expect(bitbucketConnectionFailure({ data: { code } }, translate).kind).toBe(
        'connection-changed'
      );
    }
  });

  it('reads a rate limit, a timeout, an outage or a lost connection as retryable', () => {
    for (const error of [
      { data: { code: 'TOO_MANY_REQUESTS' } },
      { data: { code: 'TIMEOUT' } },
      { data: { code: 'INTERNAL_SERVER_ERROR' } },
      new Error('Network request failed'),
    ]) {
      expect(bitbucketConnectionFailure(error, translate)).toEqual({
        kind: 'retryable',
        message: 'prReview.connect.providerCheckFailedMessage',
      });
    }
  });
});
