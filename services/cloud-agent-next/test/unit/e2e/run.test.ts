import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseArgs } from '../../e2e/run.js';

describe('run timeout option', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('accepts an overall timeout only for file-state scenarios', () => {
    expect(parseArgs(['--timeout-ms=1234', 'cold-resume', '_'])).toMatchObject({
      lifecycle: 'cold-resume',
      timeoutMs: 1234,
    });
  });

  it('rejects timeout overrides for legacy scenarios', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(parseArgs(['--timeout-ms=1234', 'hot', 'echo:hi'])).toBeNull();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('--timeout-ms is only supported'));
  });
});
