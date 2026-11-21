import { CONTROL_PLANE_TIMEOUT_MESSAGE } from '@kilocode/app-shared/control-plane';
import { USAGE_SOURCE_NOT_CONFIGURED_MESSAGE } from '@kilocode/app-shared/usage-source';
import { RequestDeadlineError } from '@kilocode/event-service';
import { describe, expect, it } from 'vitest';

import {
  isAccountBlockedTrpcError,
  isControlPlaneTimeout,
  isUsageSourceUnavailable,
  readAccountBlockedReason,
  readTrpcServerMessage,
  trpcErrorVariant,
} from '@/lib/trpc-error';

/** The shape the tRPC client rejects with once it has a server answer. */
function trpcCode(code: string): unknown {
  return { data: { code } };
}

/** The answer the server's procedure budget settles a mobile call with. */
function budgetTimeout(): unknown {
  return {
    data: {
      code: 'INTERNAL_SERVER_ERROR',
      httpStatus: 500,
      message: CONTROL_PLANE_TIMEOUT_MESSAGE,
    },
  };
}

describe('isControlPlaneTimeout', () => {
  it('recognizes the budget message on a tRPC client error', () => {
    // The production shape: the client keeps the code under data and the
    // server's message as the error's own message.
    const error = Object.assign(new Error(CONTROL_PLANE_TIMEOUT_MESSAGE), {
      data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500, path: 'agentProfiles.list' },
    });
    expect(isControlPlaneTimeout(error)).toBe(true);
    expect(trpcErrorVariant(error)).toBe('timeout');
  });

  it('recognizes a bare answer whose message sits under data', () => {
    expect(isControlPlaneTimeout(budgetTimeout())).toBe(true);
  });

  it('recognizes the client deadline error itself', () => {
    expect(isControlPlaneTimeout(new RequestDeadlineError(15_000))).toBe(true);
  });

  it('unwraps the tRPC client error that carries the deadline as its cause', () => {
    const wrapped = Object.assign(new Error('Request timed out after 15000ms'), {
      cause: new RequestDeadlineError(15_000),
    });
    expect(isControlPlaneTimeout(wrapped)).toBe(true);
  });

  it('walks a nested cause chain', () => {
    const nested = Object.assign(new Error('outer'), {
      cause: Object.assign(new Error('inner'), { cause: new RequestDeadlineError(15_000) }),
    });
    expect(isControlPlaneTimeout(nested)).toBe(true);
  });

  it('is false for a server answer, an unknown failure, and no error at all', () => {
    expect(isControlPlaneTimeout(trpcCode('INTERNAL_SERVER_ERROR'))).toBe(false);
    expect(isControlPlaneTimeout(new Error('network down'))).toBe(false);
    expect(isControlPlaneTimeout(undefined)).toBe(false);
    expect(isControlPlaneTimeout(null)).toBe(false);
  });
});

describe('trpcErrorVariant', () => {
  it('names a server budget answer as the retryable slow-response state', () => {
    expect(trpcErrorVariant(budgetTimeout())).toBe('timeout');
  });

  it('names a client deadline abort as the retryable slow-response state', () => {
    expect(trpcErrorVariant(new RequestDeadlineError(15_000))).toBe('timeout');
    expect(
      trpcErrorVariant(
        Object.assign(new Error('aborted'), { cause: new RequestDeadlineError(15_000) })
      )
    ).toBe('timeout');
  });

  it('keeps the code mapping for a server answer', () => {
    expect(trpcErrorVariant(trpcCode('FORBIDDEN'))).toBe('permission');
    expect(trpcErrorVariant(trpcCode('UNAUTHORIZED'))).toBe('permission');
    expect(trpcErrorVariant(trpcCode('NOT_FOUND'))).toBe('not-found');
    expect(trpcErrorVariant(trpcCode('INTERNAL_SERVER_ERROR'))).toBe('server');
    expect(trpcErrorVariant(trpcCode('BAD_REQUEST'))).toBe('server');
  });

  it('falls back to the server state for a failure it cannot explain', () => {
    expect(trpcErrorVariant(new Error('network down'))).toBe('server');
    expect(trpcErrorVariant(undefined)).toBe('server');
    expect(trpcErrorVariant(null)).toBe('server');
  });
});

describe('isAccountBlockedTrpcError', () => {
  it('recognizes the flag on a direct tRPC client error envelope', () => {
    expect(isAccountBlockedTrpcError({ data: { code: 'FORBIDDEN', accountBlocked: true } })).toBe(
      true
    );
  });

  it('recognizes the flag on the server-shaped envelope', () => {
    expect(
      isAccountBlockedTrpcError({ shape: { data: { code: 'FORBIDDEN', accountBlocked: true } } })
    ).toBe(true);
  });

  it('is false for an ordinary permission denial', () => {
    expect(isAccountBlockedTrpcError(trpcCode('FORBIDDEN'))).toBe(false);
    expect(isAccountBlockedTrpcError({ data: { code: 'FORBIDDEN', accountBlocked: false } })).toBe(
      false
    );
  });

  it('requires the boolean true, not a truthy stand-in', () => {
    expect(isAccountBlockedTrpcError({ data: { accountBlocked: 'true' } })).toBe(false);
  });

  it('is false when there is no error at all', () => {
    expect(isAccountBlockedTrpcError(undefined)).toBe(false);
    expect(isAccountBlockedTrpcError(null)).toBe(false);
    expect(isAccountBlockedTrpcError(new Error('network down'))).toBe(false);
  });
});

describe('readAccountBlockedReason', () => {
  it('reads the account refusal off a direct envelope', () => {
    expect(
      readAccountBlockedReason({
        data: { code: 'FORBIDDEN', accountBlocked: true, accountBlockedReason: 'account_blocked' },
      })
    ).toBe('account_blocked');
  });

  it('reads the domain refusal off a shaped envelope', () => {
    expect(
      readAccountBlockedReason({
        shape: {
          data: {
            code: 'FORBIDDEN',
            accountBlocked: true,
            accountBlockedReason: 'email_domain_blocked',
          },
        },
      })
    ).toBe('email_domain_blocked');
  });

  it('reads the reason off a real tRPC client error', () => {
    const error = Object.assign(new Error('Access denied'), {
      data: {
        code: 'FORBIDDEN',
        accountBlocked: true,
        accountBlockedReason: 'email_domain_blocked',
      },
    });
    expect(readAccountBlockedReason(error)).toBe('email_domain_blocked');
  });

  it('is null when the envelope carries no reason', () => {
    expect(
      readAccountBlockedReason({ data: { code: 'FORBIDDEN', accountBlocked: true } })
    ).toBeNull();
  });

  it('is null for a reason this client does not know', () => {
    expect(
      readAccountBlockedReason({
        data: { code: 'FORBIDDEN', accountBlocked: true, accountBlockedReason: 'rate_limited' },
      })
    ).toBeNull();
  });

  it('keeps the blocked flag when a future server names a reason this build does not know', () => {
    // An older client must not read a newer refusal as an unexplained error.
    const futureRefusal = {
      data: { code: 'FORBIDDEN', accountBlocked: true, accountBlockedReason: 'rate_limited' },
    };
    expect(isAccountBlockedTrpcError(futureRefusal)).toBe(true);
    expect(readAccountBlockedReason(futureRefusal)).toBeNull();
  });

  it('is null when there is no error at all', () => {
    expect(readAccountBlockedReason(undefined)).toBeNull();
    expect(readAccountBlockedReason(null)).toBeNull();
    expect(readAccountBlockedReason(new Error('network down'))).toBeNull();
  });
});

describe('readTrpcServerMessage', () => {
  it('returns the sentence of a real server answer, whose data carries the code only', () => {
    // The production shape, measured against the local server: the formatted
    // data carries code, httpStatus, stack and path, never a message; the
    // server's sentence is the error's own message.
    const answered = Object.assign(new Error('A profile with this name already exists'), {
      name: 'TRPCClientError',
      data: { code: 'CONFLICT', httpStatus: 409, path: 'agentProfiles.create', zodError: null },
    });
    expect(readTrpcServerMessage(answered)).toBe('A profile with this name already exists');
  });

  it('yields no sentence for an internal server error', () => {
    // An unexpected failure carries diagnostic text. Only a sentence the
    // application wrote for a person reaches the sheet.
    const failed = Object.assign(new Error('probe diagnostic text'), {
      name: 'TRPCClientError',
      data: {
        code: 'INTERNAL_SERVER_ERROR',
        httpStatus: 500,
        path: 'agentProfiles.create',
        stack: 'probe stack',
      },
    });
    expect(readTrpcServerMessage(failed)).toBeUndefined();
  });

  it('yields no sentence for the internal server error of an unset key', () => {
    const unconfigured = Object.assign(
      new Error('Agent environment encryption key not configured'),
      {
        name: 'TRPCClientError',
        data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500, path: 'agentProfiles.create' },
      }
    );
    expect(readTrpcServerMessage(unconfigured)).toBeUndefined();
  });

  it('yields no sentence for a context auth failure, whatever the envelope carries', () => {
    // The session failure carries the server's diagnostic text and is handled
    // by the sign-out path, so it is not a sentence for this sheet.
    const signedOut = Object.assign(
      new Error('User not authenticated - no user to set on context'),
      {
        name: 'TRPCClientError',
        data: {
          code: 'UNAUTHORIZED',
          httpStatus: 401,
          path: 'agentProfiles.create',
          authRequired: true,
        },
      }
    );
    expect(readTrpcServerMessage(signedOut)).toBeUndefined();
    expect(
      readTrpcServerMessage({
        shape: {
          data: {
            code: 'UNAUTHORIZED',
            message: 'User not authenticated - no user to set on context',
            authRequired: true,
          },
        },
      })
    ).toBeUndefined();
  });

  it('yields no sentence for a procedure-level auth denial', () => {
    // Every procedure-level denial carries an org-access diagnostic, so the
    // caller states its own line instead of showing that text.
    const denied = Object.assign(
      new Error('You do not have the required organizational role to access this feature'),
      {
        name: 'TRPCClientError',
        data: {
          code: 'UNAUTHORIZED',
          httpStatus: 401,
          path: 'agentProfiles.create',
        },
      }
    );
    expect(readTrpcServerMessage(denied)).toBeUndefined();
    expect(
      readTrpcServerMessage({
        shape: {
          data: {
            code: 'UNAUTHORIZED',
            message: 'You do not have the required organizational role to access this feature',
          },
        },
      })
    ).toBeUndefined();
  });

  it('yields no sentence for a validation payload', () => {
    const invalid = Object.assign(new Error('Input validation failed'), {
      name: 'TRPCClientError',
      data: {
        code: 'BAD_REQUEST',
        httpStatus: 400,
        path: 'agentProfiles.create',
        zodError: { formErrors: [['Too small']], fieldErrors: { name: ['Required'] } },
      },
    });
    expect(readTrpcServerMessage(invalid)).toBeUndefined();
  });

  it('yields no sentence for a framework code, whatever human-looking text it carries', () => {
    // The allowlist decides, not the presence of text: a framework code is not
    // a refusal the application wrote for a person.
    for (const code of [
      'PARSE_ERROR',
      'METHOD_NOT_SUPPORTED',
      'NOT_IMPLEMENTED',
      'CLIENT_CLOSED_REQUEST',
      'PAYLOAD_TOO_LARGE',
      'TIMEOUT',
      'UNPROCESSABLE_CONTENT',
    ]) {
      const framework = Object.assign(new Error('Something went wrong. Please try again.'), {
        name: 'TRPCClientError',
        data: { code, httpStatus: 400, path: 'agentProfiles.create' },
      });
      expect(readTrpcServerMessage(framework), code).toBeUndefined();
      expect(readTrpcServerMessage({ data: { code } }), code).toBeUndefined();
      expect(
        readTrpcServerMessage({ shape: { data: { code, message: 'Please try again.' } } }),
        code
      ).toBeUndefined();
    }
  });

  it('returns the sentence of an allowlisted application refusal', () => {
    const cases: [string, string][] = [
      ['BAD_REQUEST', 'The name is too long.'],
      ['PRECONDITION_FAILED', 'Add a variable before saving.'],
      ['NOT_FOUND', 'That profile no longer exists.'],
      ['TOO_MANY_REQUESTS', 'Too many attempts. Wait a moment.'],
      ['FORBIDDEN', 'You cannot change this profile.'],
      ['CONFLICT', 'A profile with this name already exists'],
    ];
    for (const [code, sentence] of cases) {
      const answered = Object.assign(new Error(sentence), {
        name: 'TRPCClientError',
        data: { code, httpStatus: 400, path: 'agentProfiles.create', zodError: null },
      });
      expect(readTrpcServerMessage(answered), code).toBe(sentence);
      expect(readTrpcServerMessage({ shape: { data: { code, message: sentence } } }), code).toBe(
        sentence
      );
    }
  });

  it('returns a message carried under a shaped answer', () => {
    expect(
      readTrpcServerMessage({
        shape: { data: { code: 'CONFLICT', message: 'Name already taken' } },
      })
    ).toBe('Name already taken');
  });

  it('refuses the payload-less transport error named like a tRPC client error', () => {
    expect(
      readTrpcServerMessage(
        Object.assign(new Error('Request timed out after 15000ms'), { name: 'TRPCClientError' })
      )
    ).toBeUndefined();
    expect(
      readTrpcServerMessage(
        Object.assign(new Error('fetch failed: Unable to resolve host'), {
          name: 'TRPCClientError',
        })
      )
    ).toBeUndefined();
  });

  it('refuses a bare Error and a value that is no error at all', () => {
    expect(readTrpcServerMessage(new Error('network down'))).toBeUndefined();
    expect(readTrpcServerMessage(undefined)).toBeUndefined();
    expect(readTrpcServerMessage(null)).toBeUndefined();
  });
});

describe('isUsageSourceUnavailable', () => {
  it('recognizes the unconfigured-source message under the tRPC envelope', () => {
    expect(
      isUsageSourceUnavailable({ data: { message: USAGE_SOURCE_NOT_CONFIGURED_MESSAGE } })
    ).toBe(true);
  });

  it('recognizes the message on a bare Error of the same text', () => {
    expect(isUsageSourceUnavailable(new Error(USAGE_SOURCE_NOT_CONFIGURED_MESSAGE))).toBe(true);
  });

  it('refuses the sanitized warehouse-failure message, which stays retryable', () => {
    expect(
      isUsageSourceUnavailable({ data: { message: 'Usage data temporarily unavailable' } })
    ).toBe(false);
  });

  it('refuses other messages, shaped errors without one, and non-errors', () => {
    expect(isUsageSourceUnavailable(new Error('network down'))).toBe(false);
    expect(isUsageSourceUnavailable(trpcCode('INTERNAL_SERVER_ERROR'))).toBe(false);
    expect(isUsageSourceUnavailable(undefined)).toBe(false);
    expect(isUsageSourceUnavailable(null)).toBe(false);
  });
});
