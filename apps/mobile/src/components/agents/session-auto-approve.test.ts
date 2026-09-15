import { describe, expect, it } from 'vitest';

import {
  canAutoApprovePermissions,
  canAutoApproveReply,
  clearSessionAutoApprove,
  getSessionAutoApproveEnabled,
  MAX_REMEMBERED_REQUEST_IDS,
  planAutoApproveReply,
  rememberRequestId,
  resolveSessionAutoApproveState,
  setSessionAutoApproveEnabled,
} from './session-auto-approve';

const NONE = new Set<string>();

describe('canAutoApprovePermissions', () => {
  it('allows remote and cloud-agent transports', () => {
    expect(canAutoApprovePermissions({ activeSessionType: 'remote', isReadOnly: false })).toBe(
      true
    );
    expect(canAutoApprovePermissions({ activeSessionType: 'cloud-agent', isReadOnly: false })).toBe(
      true
    );
  });

  it('rejects the read-only transport', () => {
    expect(canAutoApprovePermissions({ activeSessionType: 'read-only', isReadOnly: false })).toBe(
      false
    );
  });

  // The toggle is a client-side per-session preference: the transport resolves
  // only after the metadata and transcript, so the settings must stay usable
  // while the session is still opening (or has failed to open). Only a session
  // known to be read-only is excluded.
  it('allows an unresolved transport so the session settings stay reachable', () => {
    expect(canAutoApprovePermissions({ activeSessionType: null, isReadOnly: false })).toBe(true);
  });

  it('rejects every transport when the session is read-only', () => {
    expect(canAutoApprovePermissions({ activeSessionType: 'remote', isReadOnly: true })).toBe(
      false
    );
    expect(canAutoApprovePermissions({ activeSessionType: 'cloud-agent', isReadOnly: true })).toBe(
      false
    );
    expect(canAutoApprovePermissions({ activeSessionType: 'read-only', isReadOnly: true })).toBe(
      false
    );
    expect(canAutoApprovePermissions({ activeSessionType: null, isReadOnly: true })).toBe(false);
  });
});

describe('canAutoApproveReply', () => {
  it('allows a resolved remote or cloud-agent transport', () => {
    expect(canAutoApproveReply({ activeSessionType: 'remote', isReadOnly: false })).toBe(true);
    expect(canAutoApproveReply({ activeSessionType: 'cloud-agent', isReadOnly: false })).toBe(true);
  });

  // The settings row stays reachable while the transport is unresolved, but an
  // unresolved transport cannot deliver a permission ask, so it must not make
  // an auto-reply eligible.
  it('rejects an unresolved transport even though its settings stay reachable', () => {
    expect(canAutoApprovePermissions({ activeSessionType: null, isReadOnly: false })).toBe(true);
    expect(canAutoApproveReply({ activeSessionType: null, isReadOnly: false })).toBe(false);
  });

  it('rejects a read-only session', () => {
    expect(canAutoApproveReply({ activeSessionType: 'read-only', isReadOnly: false })).toBe(false);
    expect(canAutoApproveReply({ activeSessionType: 'remote', isReadOnly: true })).toBe(false);
    expect(canAutoApproveReply({ activeSessionType: null, isReadOnly: true })).toBe(false);
  });
});

describe('resolveSessionAutoApproveState', () => {
  it('returns unavailable whenever the session is not available', () => {
    expect(resolveSessionAutoApproveState({ enabled: false, available: false })).toBe(
      'unavailable'
    );
    expect(resolveSessionAutoApproveState({ enabled: true, available: false })).toBe('unavailable');
  });

  it('returns on or off from the enabled flag when available', () => {
    expect(resolveSessionAutoApproveState({ enabled: true, available: true })).toBe('on');
    expect(resolveSessionAutoApproveState({ enabled: false, available: true })).toBe('off');
  });
});

describe('planAutoApproveReply', () => {
  it('does not reply or suppress when the toggle is off', () => {
    expect(
      planAutoApproveReply({
        enabled: false,
        available: true,
        requestId: 'req-1',
        handledRequestIds: NONE,
        failedRequestIds: NONE,
      })
    ).toEqual({ replyRequestId: null, suppressedRequestId: null });
  });

  it('does not reply or suppress when the session is unavailable', () => {
    expect(
      planAutoApproveReply({
        enabled: true,
        available: false,
        requestId: 'req-1',
        handledRequestIds: NONE,
        failedRequestIds: NONE,
      })
    ).toEqual({ replyRequestId: null, suppressedRequestId: null });
  });

  it('does not reply or suppress without a request id', () => {
    expect(
      planAutoApproveReply({
        enabled: true,
        available: true,
        requestId: null,
        handledRequestIds: NONE,
        failedRequestIds: NONE,
      })
    ).toEqual({ replyRequestId: null, suppressedRequestId: null });
  });

  it('replies and suppresses a fresh request id', () => {
    expect(
      planAutoApproveReply({
        enabled: true,
        available: true,
        requestId: 'req-1',
        handledRequestIds: NONE,
        failedRequestIds: NONE,
      })
    ).toEqual({ replyRequestId: 'req-1', suppressedRequestId: 'req-1' });
  });

  it('suppresses only an already handled request id', () => {
    expect(
      planAutoApproveReply({
        enabled: true,
        available: true,
        requestId: 'req-1',
        handledRequestIds: new Set(['req-1']),
        failedRequestIds: NONE,
      })
    ).toEqual({ replyRequestId: null, suppressedRequestId: 'req-1' });
  });

  it('neither replies nor suppresses a failed request id', () => {
    expect(
      planAutoApproveReply({
        enabled: true,
        available: true,
        requestId: 'req-1',
        handledRequestIds: NONE,
        failedRequestIds: new Set(['req-1']),
      })
    ).toEqual({ replyRequestId: null, suppressedRequestId: null });
    expect(
      planAutoApproveReply({
        enabled: true,
        available: true,
        requestId: 'req-1',
        handledRequestIds: new Set(['req-1']),
        failedRequestIds: new Set(['req-1']),
      })
    ).toEqual({ replyRequestId: null, suppressedRequestId: null });
  });
});

describe('session auto-approve store', () => {
  it('defaults an unknown session to off and reflects set values', () => {
    expect(getSessionAutoApproveEnabled('store-session-a')).toBe(false);
    setSessionAutoApproveEnabled('store-session-a', true);
    expect(getSessionAutoApproveEnabled('store-session-a')).toBe(true);
    setSessionAutoApproveEnabled('store-session-a', false);
    expect(getSessionAutoApproveEnabled('store-session-a')).toBe(false);
  });

  it('scopes the value to one session id', () => {
    setSessionAutoApproveEnabled('store-session-b', true);
    setSessionAutoApproveEnabled('store-session-c', false);

    expect(getSessionAutoApproveEnabled('store-session-b')).toBe(true);
    expect(getSessionAutoApproveEnabled('store-session-c')).toBe(false);

    setSessionAutoApproveEnabled('store-session-b', false);

    expect(getSessionAutoApproveEnabled('store-session-b')).toBe(false);
    expect(getSessionAutoApproveEnabled('store-session-c')).toBe(false);
  });

  it('turns every session off on sign-out or account switch', () => {
    setSessionAutoApproveEnabled('clear-session-a', true);
    setSessionAutoApproveEnabled('clear-session-b', true);

    clearSessionAutoApprove();

    expect(getSessionAutoApproveEnabled('clear-session-a')).toBe(false);
    expect(getSessionAutoApproveEnabled('clear-session-b')).toBe(false);
  });
});

describe('rememberRequestId', () => {
  it('evicts the oldest id once the window is full', () => {
    const remembered = new Set<string>();

    for (let index = 0; index <= MAX_REMEMBERED_REQUEST_IDS; index += 1) {
      rememberRequestId(remembered, `req-${index}`);
    }

    expect(remembered.size).toBe(MAX_REMEMBERED_REQUEST_IDS);
    // The oldest id is evicted first; the newest stays.
    expect(remembered.has('req-0')).toBe(false);
    expect(remembered.has(`req-${MAX_REMEMBERED_REQUEST_IDS}`)).toBe(true);
  });

  it('does not grow past the window for a long run of distinct ids', () => {
    const remembered = new Set<string>();

    for (let index = 0; index < MAX_REMEMBERED_REQUEST_IDS * 10; index += 1) {
      rememberRequestId(remembered, `req-${index}`);
    }

    expect(remembered.size).toBe(MAX_REMEMBERED_REQUEST_IDS);
  });
});
