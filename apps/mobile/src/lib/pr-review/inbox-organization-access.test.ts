import { describe, expect, it } from 'vitest';

import { classifyInboxOrganizationScopeAccess } from './inbox-organization-access';

// A tRPC client error the way the app receives it: `data.code` (plus the
// procedure-level `authRequired` marker the transport adds to a session failure).
function trpcError(code: string, extra: Record<string, unknown> = {}) {
  return { data: { code, httpStatus: code === 'NOT_FOUND' ? 404 : 401, ...extra } };
}

function access(args: {
  organizationId?: string | null;
  statusErrors?: readonly unknown[];
  inboxErrors?: readonly unknown[];
}) {
  return classifyInboxOrganizationScopeAccess({
    organizationId: 'org-1',
    statusErrors: [],
    inboxErrors: [],
    ...args,
  });
}

describe('classifyInboxOrganizationScopeAccess', () => {
  it('grants a scope with no refusal', () => {
    expect(access({})).toBe('granted');
  });

  it('grants the personal scope, which has no membership to lose', () => {
    // Even a refused page there is a provider problem, not an organization.
    expect(
      access({
        organizationId: null,
        statusErrors: [trpcError('UNAUTHORIZED')],
        inboxErrors: [trpcError('UNAUTHORIZED')],
      })
    ).toBe('granted');
  });

  it.each([
    ['a removed membership', 'UNAUTHORIZED', 'denied'],
    ['a refused organization role', 'FORBIDDEN', 'denied'],
    ['a deleted organization', 'NOT_FOUND', 'not-found'],
  ] as const)('reports %s from the status reads as %s', (_case, code, expected) => {
    expect(access({ statusErrors: [trpcError(code)] })).toBe(expected);
  });

  it('keeps an unrelated status failure on the provider states', () => {
    // An outage of the status read says nothing about the reader's access.
    expect(access({ statusErrors: [trpcError('SERVICE_UNAVAILABLE')] })).toBe('granted');
  });

  it('keeps a session-level auth failure out of the access states', () => {
    // `authRequired` marks the context-level UNAUTHORIZED the client signs out
    // on; it is not this organization refusing the reader.
    expect(access({ statusErrors: [trpcError('UNAUTHORIZED', { authRequired: true })] })).toBe(
      'granted'
    );
  });

  it('reads a refused organization page as the organization, not the provider', () => {
    // The access guard runs before any provider call, so a page refused with
    // the procedure-level UNAUTHORIZED is the organization's own denial even
    // while the status reads still hold their cached answer.
    expect(access({ inboxErrors: [trpcError('UNAUTHORIZED')] })).toBe('denied');
  });

  it('keeps a refused provider credential on its reconnect surface', () => {
    // A connection the reader can re-establish arrives as PRECONDITION_FAILED;
    // claiming the organization is gone would offer the wrong remedy.
    expect(access({ inboxErrors: [trpcError('PRECONDITION_FAILED')] })).toBe('granted');
  });

  it('lets the status verdict outrank a refused page', () => {
    // A deleted organization is `not-found`, never the page's `denied`.
    expect(
      access({
        statusErrors: [trpcError('NOT_FOUND')],
        inboxErrors: [trpcError('UNAUTHORIZED')],
      })
    ).toBe('not-found');
  });
});
