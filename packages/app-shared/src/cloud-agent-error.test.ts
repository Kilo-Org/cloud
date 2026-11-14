import { describe, expect, it } from 'vitest';

import { readCloudAgentErrorFields } from './cloud-agent-error';

describe('readCloudAgentErrorFields', () => {
  it('reads code and httpStatus from data', () => {
    expect(readCloudAgentErrorFields({ data: { code: 'CONFLICT', httpStatus: 409 } })).toEqual({
      code: 'CONFLICT',
      httpStatus: 409,
      answeredByServer: true,
    });
  });

  it('falls back to shape.code for the code only', () => {
    expect(readCloudAgentErrorFields({ data: {}, shape: { code: 'PAYMENT_REQUIRED' } })).toEqual({
      code: 'PAYMENT_REQUIRED',
      answeredByServer: true,
    });
  });

  it('falls back to shape.data for code and httpStatus', () => {
    expect(
      readCloudAgentErrorFields({
        data: {},
        shape: { data: { code: 'FORBIDDEN', httpStatus: 403 } },
      })
    ).toEqual({ code: 'FORBIDDEN', httpStatus: 403, answeredByServer: true });
  });

  it('prefers the semantic code over the numeric JSON-RPC code', () => {
    expect(
      readCloudAgentErrorFields({
        data: { code: 'NOT_FOUND', httpStatus: 404 },
        shape: { code: -32001, data: { code: 'NOT_FOUND', httpStatus: 404 } },
      })
    ).toEqual({ code: 'NOT_FOUND', httpStatus: 404, answeredByServer: true });
  });

  it('prefers data over shape.data when they disagree', () => {
    expect(
      readCloudAgentErrorFields({
        data: { code: 'BAD_REQUEST' },
        shape: { data: { code: 'CONFLICT' } },
      })
    ).toEqual({ code: 'BAD_REQUEST', answeredByServer: true });
  });

  it('ignores wrong-typed fields', () => {
    expect(readCloudAgentErrorFields({ data: { code: 409, httpStatus: '409' } })).toEqual({
      answeredByServer: false,
    });
  });

  it('reports a server answer without a code for a numeric JSON-RPC code alone', () => {
    const fields = readCloudAgentErrorFields({ shape: { code: -32000 } });

    expect(fields).toEqual({ answeredByServer: true });
    expect(fields.code).toBeUndefined();
  });

  it('reports no server answer for passthrough-only fields', () => {
    expect(readCloudAgentErrorFields({ data: { message: 'x' } })).toEqual({
      answeredByServer: false,
    });
  });

  it.each([null, undefined, 'boom', 42])('returns no fields for the non-object %j', error => {
    expect(readCloudAgentErrorFields(error)).toEqual({ answeredByServer: false });
  });
});
