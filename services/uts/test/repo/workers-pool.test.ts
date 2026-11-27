import { describe, expect, it } from 'vitest';
import workersPoolConfig from '../../vitest.config';

describe('the Workers test pool config', () => {
  it('keeps console calls out of vitest RPC, where an aborted Durable Object leaves a call unanswered', () => {
    // vitest waits for every pending RPC call before it ends a test file, with no timeout; see
    // the comment on the setting in vitest.config.ts.
    expect(workersPoolConfig.test?.disableConsoleIntercept).toBe(true);
  });
});
