import { describe, it, expect } from '@jest/globals';

// The legacy /api/security-advisor/analyze route re-exports POST from the
// canonical /api/shell-security/analyze route. This smoke test guards the
// re-export so a typo or accidental removal doesn't silently break existing
// @kilocode/openclaw-security-advisor@0.1.x plugin installs still calling
// the legacy path. Behavior is covered in depth by the shell-security
// route tests.
describe('POST /api/security-advisor/analyze (legacy re-export)', () => {
  it('re-exports the same POST handler as /api/shell-security/analyze', async () => {
    const [legacy, canonical] = await Promise.all([
      import('./route'),
      import('../../shell-security/analyze/route'),
    ]);
    expect(legacy.POST).toBe(canonical.POST);
  });
});
