import { describe, expect, it } from 'vitest';
import { setupCommandsSchema, SETUP_SCRIPT_LIMITS } from './setup-script';

describe('shared setup script contract', () => {
  it('accepts a multiline script longer than the old short-command limit', () => {
    const script = '#!/bin/bash\n' + 'echo setup\n'.repeat(100);
    expect(setupCommandsSchema.parse([script])).toEqual([script]);
  });
  it('bounds script size and count at every consumer', () => {
    expect(
      setupCommandsSchema.safeParse(['x'.repeat(SETUP_SCRIPT_LIMITS.MAX_LENGTH)]).success
    ).toBe(true);
    expect(
      setupCommandsSchema.safeParse(['x'.repeat(SETUP_SCRIPT_LIMITS.MAX_LENGTH + 1)]).success
    ).toBe(false);
    expect(
      setupCommandsSchema.safeParse(
        Array.from({ length: SETUP_SCRIPT_LIMITS.MAX_SCRIPTS + 1 }, () => 'true')
      ).success
    ).toBe(false);
  });
});
