import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  applyForceStatePath,
  getForcedMode,
  isForcedProcedure,
  resetForceStateForTests,
  withForceState,
} from '@/lib/force-state-fixture';

const LINK = `kiloapp:///dev/force-state/retryable?next=${encodeURIComponent(
  'kiloapp:///(app)/(tabs)/(3_profile)/passkeys'
)}`;

beforeEach(() => {
  resetForceStateForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetForceStateForTests();
});

// The module guards itself, so a release build stays safe whatever its callers
// (`+native-intent.tsx`, the tRPC links, the connectivity stores) check.
describe('force-state release guard', () => {
  it('applies a link and forces a procedure in a dev build', () => {
    expect(applyForceStatePath(LINK, new QueryClient())).toBe(
      'kiloapp:///(app)/(tabs)/(3_profile)/passkeys'
    );
    expect(getForcedMode()).toBe('retryable');
    expect(isForcedProcedure('codeReviews.listForUser')).toBe(true);
  });

  it('applies nothing and wraps nothing in a release build', () => {
    vi.stubGlobal('__DEV__', false);
    const plainFetch: typeof fetch = vi.fn<typeof fetch>();

    expect(applyForceStatePath(LINK, new QueryClient())).toBeUndefined();
    expect(getForcedMode()).toBeNull();
    expect(isForcedProcedure('codeReviews.listForUser')).toBe(false);
    expect(withForceState(plainFetch)).toBe(plainFetch);
  });
});
