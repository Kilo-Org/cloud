import type { TRPC_ERROR_CODE_KEY } from '@trpc/server/rpc';
import {
  HTTP_STATUS_TO_TRPC_CODE,
  isTRPCErrorCode,
  readCloudAgentErrorCode,
} from './cloud-agent-error';

const NOT_FOUND_ONLY = new Set<TRPC_ERROR_CODE_KEY>(['NOT_FOUND']);
const CONFLICT_OR_NOT_FOUND = new Set<TRPC_ERROR_CODE_KEY>(['CONFLICT', 'NOT_FOUND']);

describe('HTTP_STATUS_TO_TRPC_CODE', () => {
  it.each([
    [400, 'BAD_REQUEST'],
    [401, 'UNAUTHORIZED'],
    [402, 'PAYMENT_REQUIRED'],
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [408, 'TIMEOUT'],
    [409, 'CONFLICT'],
    [412, 'PRECONDITION_FAILED'],
    [422, 'UNPROCESSABLE_CONTENT'],
    [429, 'TOO_MANY_REQUESTS'],
    [500, 'INTERNAL_SERVER_ERROR'],
    [502, 'BAD_GATEWAY'],
    [503, 'SERVICE_UNAVAILABLE'],
    [504, 'GATEWAY_TIMEOUT'],
  ] as const)('maps %i to %s', (status, code) => {
    expect(HTTP_STATUS_TO_TRPC_CODE.get(status)).toBe(code);
  });

  it('has no entry for an unmapped status', () => {
    expect(HTTP_STATUS_TO_TRPC_CODE.get(418)).toBeUndefined();
  });
});

describe('isTRPCErrorCode', () => {
  it('accepts a real tRPC code and rejects other strings', () => {
    expect(isTRPCErrorCode('CONFLICT')).toBe(true);
    expect(isTRPCErrorCode('NOT_A_CODE')).toBe(false);
    // `Object.hasOwn` rather than `in`, so an inherited Object key is rejected.
    expect(isTRPCErrorCode('toString')).toBe(false);
  });
});

describe('readCloudAgentErrorCode', () => {
  it('returns an accepted code', () => {
    expect(readCloudAgentErrorCode({ data: { code: 'NOT_FOUND' } }, NOT_FOUND_ONLY)).toBe(
      'NOT_FOUND'
    );
  });

  it('falls through to the status map for a known but unaccepted code', () => {
    expect(
      readCloudAgentErrorCode({ data: { code: 'CONFLICT', httpStatus: 404 } }, NOT_FOUND_ONLY)
    ).toBe('NOT_FOUND');
  });

  it('returns undefined for a known but unaccepted code with no status', () => {
    expect(readCloudAgentErrorCode({ data: { code: 'CONFLICT' } }, NOT_FOUND_ONLY)).toBeUndefined();
  });

  it('returns undefined when the status maps to an unaccepted code', () => {
    expect(
      readCloudAgentErrorCode({ data: { httpStatus: 404 } }, new Set(['CONFLICT']))
    ).toBeUndefined();
  });

  it('uses the status map for an unknown code string', () => {
    expect(
      readCloudAgentErrorCode(
        { data: { code: 'NOT_A_TRPC_CODE', httpStatus: 404 } },
        NOT_FOUND_ONLY
      )
    ).toBe('NOT_FOUND');
  });

  it('prefers the code over the status when both are accepted', () => {
    expect(
      readCloudAgentErrorCode(
        { data: { code: 'CONFLICT', httpStatus: 404 } },
        CONFLICT_OR_NOT_FOUND
      )
    ).toBe('CONFLICT');
  });

  it('reads `shape.data.code` when `data.code` is absent', () => {
    expect(
      readCloudAgentErrorCode({ data: {}, shape: { data: { code: 'NOT_FOUND' } } }, NOT_FOUND_ONLY)
    ).toBe('NOT_FOUND');
  });

  it('returns undefined for a non-object input', () => {
    expect(readCloudAgentErrorCode('boom', NOT_FOUND_ONLY)).toBeUndefined();
    expect(readCloudAgentErrorCode(null, NOT_FOUND_ONLY)).toBeUndefined();
    expect(readCloudAgentErrorCode(undefined, NOT_FOUND_ONLY)).toBeUndefined();
  });
});
