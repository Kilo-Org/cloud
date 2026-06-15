import { describe, expect, it } from 'vitest';
import { TRPC_ERROR_CODES_BY_KEY } from '@trpc/server/rpc';

import { buildTrpcErrorResponse, createClientError, projectTrpcErrorData } from './trpc-error.js';

describe('createClientError', () => {
  it.each([
    'PARSE_ERROR',
    'BAD_REQUEST',
    'UNAUTHORIZED',
    'PAYMENT_REQUIRED',
    'FORBIDDEN',
    'NOT_FOUND',
    'METHOD_NOT_SUPPORTED',
    'NOT_IMPLEMENTED',
    'CONFLICT',
    'PRECONDITION_FAILED',
    'PAYLOAD_TOO_LARGE',
    'UNSUPPORTED_MEDIA_TYPE',
    'UNPROCESSABLE_CONTENT',
  ])('classifies %s as non-retryable', code => {
    expect(createClientError(code, 'public message')).toEqual({
      code,
      message: 'public message',
      retryable: false,
    });
  });

  it.each([
    'TOO_MANY_REQUESTS',
    'TIMEOUT',
    'CLIENT_CLOSED_REQUEST',
    'INTERNAL_SERVER_ERROR',
    'SERVICE_UNAVAILABLE',
    'FUTURE_ERROR',
  ])('classifies %s as retryable', code => {
    expect(createClientError(code, 'public message').retryable).toBe(true);
  });

  it('uses a valid explicit legacy cause without replacing the tRPC message', () => {
    expect(
      projectTrpcErrorData(
        { code: 'SERVICE_UNAVAILABLE', httpStatus: 503, path: 'send' },
        'Admission failed',
        { error: 'SANDBOX_CONNECT_FAILED', message: 'internal detail', retryable: true }
      )
    ).toEqual({
      code: 'SERVICE_UNAVAILABLE',
      httpStatus: 503,
      path: 'send',
      error: 'SANDBOX_CONNECT_FAILED',
      retryable: true,
      clientError: {
        code: 'SANDBOX_CONNECT_FAILED',
        message: 'Admission failed',
        retryable: true,
      },
    });
  });

  it('keeps known non-retryable codes non-retryable despite an inconsistent cause', () => {
    expect(
      projectTrpcErrorData({ code: 'BAD_REQUEST', httpStatus: 400 }, 'Invalid request', {
        error: 'BAD_REQUEST',
        retryable: true,
      })
    ).toMatchObject({
      error: 'BAD_REQUEST',
      retryable: false,
      clientError: {
        code: 'BAD_REQUEST',
        message: 'Invalid request',
        retryable: false,
      },
    });
  });

  it.each([
    null,
    'failure',
    { error: 'lowercase', retryable: false },
    { error: 'VALID_CODE' },
    { error: 'VALID_CODE', retryable: 'yes' },
    { error: 'VALID_CODE', retryable: true, message: 42 },
    { arbitrary: 'exception detail' },
  ])('ignores malformed cause %j', cause => {
    expect(
      projectTrpcErrorData(
        { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500 },
        'Safe message',
        cause
      )
    ).toEqual({
      code: 'INTERNAL_SERVER_ERROR',
      httpStatus: 500,
      clientError: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Safe message',
        retryable: true,
      },
    });
  });
});

describe('buildTrpcErrorResponse', () => {
  it.each([
    [405, 'METHOD_NOT_SUPPORTED', false],
    [408, 'TIMEOUT', true],
    [409, 'CONFLICT', false],
    [412, 'PRECONDITION_FAILED', false],
    [413, 'PAYLOAD_TOO_LARGE', false],
    [415, 'UNSUPPORTED_MEDIA_TYPE', false],
    [422, 'UNPROCESSABLE_CONTENT', false],
    [429, 'TOO_MANY_REQUESTS', true],
    [499, 'CLIENT_CLOSED_REQUEST', true],
    [501, 'NOT_IMPLEMENTED', false],
    [503, 'SERVICE_UNAVAILABLE', true],
  ] as const)(
    'maps HTTP %i to %s without changing envelope metadata',
    async (status, code, retryable) => {
      const response = buildTrpcErrorResponse(status, 'Original message', 'send');
      const body = await response.json();

      expect(response.status).toBe(status);
      expect(body).toEqual({
        error: {
          message: 'Original message',
          code: TRPC_ERROR_CODES_BY_KEY[code],
          data: {
            code,
            httpStatus: status,
            path: 'send',
            clientError: {
              code,
              message: 'Original message',
              retryable,
            },
          },
        },
      });
    }
  );
});
