import { describe, expect, it } from 'vitest';

import {
  classifyReadFailureKind,
  classifyReadFailureVariant,
  isReadPausedBeforeData,
  readFailureKindIsRetryable,
  readFailureKindVariant,
  type SelectReadFailureVariantInput,
} from './read-failure-variant';

/** A tRPC client rejection, as `readTrpcErrorField` reads it. */
function serverError(code: string, data: Record<string, unknown> = {}): Error {
  return Object.assign(new Error('boom'), { data: { code, message: 'boom', ...data } });
}

function variantFor(patch: Partial<SelectReadFailureVariantInput>): 'offline' | 'server' {
  return classifyReadFailureVariant({
    errors: [],
    isPaused: false,
    connectivity: 'online',
    ...patch,
  });
}

describe('classifyReadFailureVariant', () => {
  it('names the connection when the failed read never reached the server', () => {
    // A fetch rejection (timeout, refused, cut) carries no tRPC code and no
    // HTTP status: NetInfo may still report online, and the system wording
    // would blame the app.
    expect(variantFor({ errors: [new TypeError('Network request failed')] })).toBe('offline');
  });

  it('keeps the server wording when a failed read answered with a code', () => {
    expect(variantFor({ errors: [serverError('FORBIDDEN')] })).toBe('server');
  });

  it('names the connection for a read paused by the online manager', () => {
    expect(variantFor({ isPaused: true, errors: [], connectivity: 'online' })).toBe('offline');
  });

  it('names the connection on a confirmed-offline device even for a coded error', () => {
    expect(
      variantFor({ errors: [serverError('INTERNAL_SERVER_ERROR')], connectivity: 'offline' })
    ).toBe('offline');
  });

  it('keeps the server wording for a plain HTTP answer without a tRPC code', () => {
    // A model-catalogue 500 is a real answer from the server, so the system
    // wording stays even though the error carries no tRPC envelope.
    expect(
      variantFor({
        errors: [
          Object.assign(new Error('Failed to fetch models: 500 Internal Server Error'), {
            status: 500,
          }),
        ],
      })
    ).toBe('server');
  });

  it('reads the model-catalogue error status field', () => {
    // `ModelCatalogFetchError` carries the answer's status as a property.
    expect(
      variantFor({
        errors: [
          Object.assign(new Error('Failed to fetch models: 401 Unauthorized'), {
            name: 'ModelCatalogFetchError',
            status: 401,
          }),
        ],
      })
    ).toBe('server');
  });

  it('names the connection for a failed read with no server evidence', () => {
    expect(
      variantFor({ errors: [new TypeError('failure')], isPaused: false, connectivity: 'online' })
    ).toBe('offline');
  });

  it('does not claim the connection without a failure to classify', () => {
    expect(variantFor({ errors: [], isPaused: false, connectivity: 'unknown' })).toBe('server');
  });

  it('reads the server answer from the shipped tRPC error shapes', () => {
    expect(
      variantFor({ errors: [Object.assign(new Error('boom'), { data: { code: 'NOT_FOUND' } })] })
    ).toBe('server');
    expect(
      variantFor({
        errors: [Object.assign(new Error('boom'), { shape: { data: { code: 'FORBIDDEN' } } })],
      })
    ).toBe('server');
  });

  it('names the connection for a client-side failure that carries a bare code', () => {
    // The Expo fetch cancellation names itself in `code`, and other transport
    // errors can too: a bare top-level `code` is not a server answer.
    expect(
      variantFor({
        errors: [
          Object.assign(new Error('Aborted'), {
            name: 'FetchRequestCanceledException',
            code: 'FetchRequestCanceledException',
          }),
        ],
      })
    ).toBe('offline');
  });

  it('names the connection when the caller also pauses a coded failure', () => {
    expect(variantFor({ errors: [serverError('FORBIDDEN')], isPaused: true })).toBe('offline');
  });
});

describe('isReadPausedBeforeData', () => {
  it('names a pending read the online manager paused offline', () => {
    expect(
      isReadPausedBeforeData({ isPending: true, fetchStatus: 'paused', connectivity: 'offline' })
    ).toBe(true);
  });

  it('keeps the loading gate only while connectivity is unsettled', () => {
    // The manager also pauses on an `unknown` NetInfo report, which is the
    // normal cold-launch window: a pause there is not a connection failure.
    expect(
      isReadPausedBeforeData({ isPending: true, fetchStatus: 'paused', connectivity: 'unknown' })
    ).toBe(false);
    // A settled online connection still names the pause offline: the read sent
    // nothing, so the app's probe is the more recent answer than NetInfo.
    expect(
      isReadPausedBeforeData({ isPending: true, fetchStatus: 'paused', connectivity: 'online' })
    ).toBe(true);
  });

  it('is false for a pending read still in flight', () => {
    expect(
      isReadPausedBeforeData({ isPending: true, fetchStatus: 'fetching', connectivity: 'offline' })
    ).toBe(false);
  });

  it('is false for a settled read whose refetch is paused', () => {
    expect(
      isReadPausedBeforeData({ isPending: false, fetchStatus: 'paused', connectivity: 'offline' })
    ).toBe(false);
  });
});

describe('classifyReadFailureKind', () => {
  const kindFor = (patch: Partial<SelectReadFailureVariantInput>) =>
    classifyReadFailureKind({ errors: [], isPaused: false, connectivity: 'online', ...patch });

  it('names the connection for a read that never reached the server', () => {
    expect(kindFor({ errors: [new TypeError('Network request failed')] })).toBe('offline');
  });

  it('names the connection for a paused read', () => {
    expect(kindFor({ isPaused: true })).toBe('offline');
  });

  it('names a refusal as permission, not a transient server failure', () => {
    expect(kindFor({ errors: [serverError('FORBIDDEN')] })).toBe('permission');
    expect(kindFor({ errors: [serverError('UNAUTHORIZED')] })).toBe('permission');
  });

  it('names a removed read as not-found, its own copy', () => {
    expect(kindFor({ errors: [serverError('NOT_FOUND')] })).toBe('not-found');
  });

  it('keeps the server copy for the terminal codes that are not a missing item', () => {
    // The read was answered, so neither the connection nor "this item may have
    // been removed" describes a contract failure. The retry stays withheld.
    expect(kindFor({ errors: [serverError('BAD_REQUEST')] })).toBe('terminal');
    expect(kindFor({ errors: [serverError('UNPROCESSABLE_CONTENT')] })).toBe('terminal');
  });

  it('names a client-side deadline as a timeout, not the connection', () => {
    // The app's control-plane deadline rejects with no tRPC code and no HTTP
    // status; the server was reachable and slow, so the copy must say so.
    expect(kindFor({ errors: [{ name: 'RequestDeadlineError' }] })).toBe('timeout');
  });

  it('names a 5xx as retryable', () => {
    expect(kindFor({ errors: [serverError('INTERNAL_SERVER_ERROR')] })).toBe('retryable');
  });

  it('names the connection only while NO read reached the server', () => {
    // One coded answer proves the server was reachable, so the refusal is the
    // more specific truth about the surface than the transport error beside it.
    expect(
      kindFor({
        errors: [new TypeError('Network request failed'), serverError('FORBIDDEN')],
      })
    ).toBe('permission');
    // Nothing reached the server at all: the connection is the cause.
    expect(
      kindFor({ errors: [new TypeError('Network request failed'), new TypeError('timeout')] })
    ).toBe('offline');
  });

  it('lets a refusal outrank a terminal code', () => {
    // `FORBIDDEN` is itself in the terminal set; the refusal copy is the one
    // that explains it.
    expect(kindFor({ errors: [serverError('FORBIDDEN'), serverError('NOT_FOUND')] })).toBe(
      'permission'
    );
  });

  it('offers a retry only for the kinds a second attempt can fix', () => {
    expect(readFailureKindIsRetryable('retryable')).toBe(true);
    expect(readFailureKindIsRetryable('offline')).toBe(true);
    expect(readFailureKindIsRetryable('timeout')).toBe(true);
    expect(readFailureKindIsRetryable('permission')).toBe(false);
    expect(readFailureKindIsRetryable('not-found')).toBe(false);
    expect(readFailureKindIsRetryable('terminal')).toBe(false);
  });

  it('maps each kind to the variant that carries its copy', () => {
    expect(readFailureKindVariant('offline')).toBe('offline');
    expect(readFailureKindVariant('timeout')).toBe('timeout');
    expect(readFailureKindVariant('permission')).toBe('permission');
    expect(readFailureKindVariant('not-found')).toBe('not-found');
    expect(readFailureKindVariant('terminal')).toBe('server');
    expect(readFailureKindVariant('retryable')).toBe('server');
  });
});
