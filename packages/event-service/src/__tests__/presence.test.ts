import { describe, expect, it } from 'vitest';

import { presenceContextForCliSession } from '../presence';

describe('presence context builders', () => {
  it('builds CLI session presence contexts', () => {
    expect(presenceContextForCliSession('ses_1')).toBe('/presence/cli-session/ses_1');
  });
});
