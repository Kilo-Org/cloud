import { describe, expect, it } from 'vitest';

import * as kiloChatHooks from './index';

describe('public API', () => {
  it('does not expose XHR upload internals', () => {
    expect('mapXhrUploadResultToOutcome' in kiloChatHooks).toBe(false);
  });
});
