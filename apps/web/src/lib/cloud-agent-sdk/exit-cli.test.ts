import { parseExitCliResponse } from './exit-cli';

describe('parseExitCliResponse', () => {
  it('accepts only a plain empty object', () => {
    expect(parseExitCliResponse({})).toEqual({ ok: true });
  });

  it.each([null, [], { extra: true }, undefined, 'ok', 1])('rejects %p', value => {
    expect(parseExitCliResponse(value)).toEqual({ ok: false, reason: 'invalid' });
  });
});
