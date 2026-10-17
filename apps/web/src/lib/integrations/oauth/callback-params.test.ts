import { describe, expect, it } from '@jest/globals';
import { getCallbackReportParams } from './callback-params';

describe('getCallbackReportParams', () => {
  it('builds the callback report representation', () => {
    const params = new URLSearchParams(
      'code=first&state=context&code=second&scope=read&scope=write'
    );
    const original = params.toString();
    expect(getCallbackReportParams(params)).toEqual({
      code: '***',
      state: 'context',
      scope: 'write',
    });
    expect(params.toString()).toBe(original);
  });

  it('handles empty parameter values', () => {
    expect(getCallbackReportParams(new URLSearchParams('code=&state='))).toEqual({
      code: '***',
      state: '',
    });
  });

  it('preserves the available parameter set', () => {
    expect(getCallbackReportParams(new URLSearchParams('state=context&error=cancelled'))).toEqual({
      state: 'context',
      error: 'cancelled',
    });
    expect(getCallbackReportParams(new URLSearchParams())).toEqual({});
  });
});
