import { parseExitSessionResponse } from './exit-session';

describe('parseExitSessionResponse', () => {
  it('accepts only a plain empty object', () => {
    expect(parseExitSessionResponse({})).toEqual({ ok: true });
  });

  it.each([null, [], { extra: true }, undefined, 'ok', 1])('rejects %p', value => {
    expect(parseExitSessionResponse(value)).toEqual({ ok: false, reason: 'invalid' });
  });
});
