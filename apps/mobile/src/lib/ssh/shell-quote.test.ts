import { describe, expect, it } from 'vitest';

import { quoteShellArg } from './shell-quote';

describe('quoteShellArg', () => {
  it('wraps a plain word', () => {
    expect(quoteShellArg('kilo')).toBe("'kilo'");
  });

  it('keeps spaces inside one word', () => {
    expect(quoteShellArg('my shell')).toBe("'my shell'");
  });

  it('closes and reopens around an embedded quote', () => {
    expect(quoteShellArg("it's")).toBe(String.raw`'it'\''s'`);
  });

  it('neutralises shell syntax', () => {
    expect(quoteShellArg('a; rm -rf ~')).toBe("'a; rm -rf ~'");
    expect(quoteShellArg('$(whoami)')).toBe("'$(whoami)'");
  });
});
