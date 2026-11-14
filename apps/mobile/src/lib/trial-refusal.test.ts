import { describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import {
  TRIAL_ENDED_BILLING_COPY_KEY,
  TRIAL_ENDED_COPY_KEY,
  trialRefusalCopyKey,
  trialRefusalMessage,
} from '@/lib/trial-refusal';

// This test asserts the surface `trial-refusal.ts` publishes, and that module
// also holds the hooks: they reach expo-router and the organization query chain,
// which the pure project has no build for. Only the module-load chain is
// stubbed; no hook is mounted and every reader asserted here is pure.
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/lib/hooks/use-organization-queries', () => ({
  isMoneyRole: () => false,
  useOrgBoundary: () => ({ role: undefined }),
}));

describe('trialRefusalCopyKey', () => {
  it('gives a role that can change the plan the copy that offers the step', () => {
    expect(trialRefusalCopyKey(true)).toBe(TRIAL_ENDED_BILLING_COPY_KEY);
  });

  it('gives everyone else the copy that names the owner who can', () => {
    expect(trialRefusalCopyKey(false)).toBe(TRIAL_ENDED_COPY_KEY);
  });

  it('keeps the two readers on two keys', () => {
    expect(TRIAL_ENDED_COPY_KEY).not.toBe(TRIAL_ENDED_BILLING_COPY_KEY);
  });
});

describe('trialRefusalMessage', () => {
  it('translates the key each reader gets', () => {
    expect(trialRefusalMessage(true)).toBe(i18n.t(TRIAL_ENDED_BILLING_COPY_KEY));
    expect(trialRefusalMessage(false)).toBe(i18n.t(TRIAL_ENDED_COPY_KEY));
  });

  it('holds different copy for the two readers', () => {
    expect(trialRefusalMessage(true)).not.toBe(trialRefusalMessage(false));
  });

  // Both sentences must state the state; only the role that can end it is
  // offered the step, so the member copy keeps naming who can.
  it('states the ended trial and differs in who is asked to act', () => {
    expect(trialRefusalMessage(true)).toContain("The organization's trial has ended");
    expect(trialRefusalMessage(false)).toContain("The organization's trial has ended");
    expect(trialRefusalMessage(true)).toContain('You can update billing');
    expect(trialRefusalMessage(false)).toContain('An organization owner can update billing');
    expect(trialRefusalMessage(false)).not.toContain('You can update billing');
  });
});
