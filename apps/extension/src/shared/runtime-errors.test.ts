import { describe, expect, it } from 'vitest';
import { isMissingContentScriptConnectionError } from './runtime-errors';

describe('runtime errors', () => {
  it('recognizes browser errors raised when a tab has no content script receiver', () => {
    expect.assertions(3);

    expect(
      isMissingContentScriptConnectionError(
        new Error('Could not establish connection. Receiving end does not exist.')
      )
    ).toBe(true);
    expect(
      isMissingContentScriptConnectionError(
        new Error('Could not establish connection. Receiving end does not exist')
      )
    ).toBe(true);
    expect(isMissingContentScriptConnectionError(new Error('Permission denied.'))).toBe(false);
  });
});
