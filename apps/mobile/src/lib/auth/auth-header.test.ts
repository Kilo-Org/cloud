import { describe, expect, it } from 'vitest';

import { buildAuthHeaders } from './auth-header';

describe('buildAuthHeaders', () => {
  it('uses only the current stored credential after refresh resolution', () => {
    expect(buildAuthHeaders('current-token')).toEqual({ Authorization: 'Bearer current-token' });
    expect(buildAuthHeaders(null)).toEqual({});
  });
});
