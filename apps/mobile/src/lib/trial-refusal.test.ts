import { canManageOrganizationBilling } from '@kilocode/app-shared/organizations';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { act, TestRenderer } from '@/test/renderer';
import {
  billingHrefFor,
  ORGANIZATION_BILLING_HREF,
  TRIAL_ENDED_BILLING_AT_KILO_AI_COPY_KEY,
  TRIAL_ENDED_BILLING_COPY_KEY,
  TRIAL_ENDED_COPY_KEY,
  type TrialRefusalAction,
  trialRefusalCopyKey,
  trialRefusalMessage,
  useBillingAction,
} from '@/lib/trial-refusal';

const state = vi.hoisted(() => ({
  role: undefined as string | undefined,
  push: vi.fn(),
}));

// This test asserts the surface `trial-refusal.ts` publishes, and that module
// also holds the hooks: they reach expo-router and the organization query chain,
// which the pure project has no build for. Only the module-load chain is
// stubbed, and the role predicate stays the real one so a hook mounted here
// resolves the same answer production would.
vi.mock('expo-router', () => ({ useRouter: () => ({ push: state.push }) }));
vi.mock('@/lib/hooks/use-organization-queries', () => ({
  isMoneyRole: canManageOrganizationBilling,
  useOrgBoundary: () => ({ role: state.role }),
}));

/** The step `useBillingAction` returns for one organization id. */
function mountBillingAction(organizationId?: string): TrialRefusalAction | undefined {
  let step: TrialRefusalAction | undefined = undefined;
  function Probe() {
    step = useBillingAction(organizationId);
    return null;
  }
  act(() => {
    TestRenderer.create(createElement(Probe));
  });
  return step;
}

beforeEach(() => {
  state.role = undefined;
  state.push.mockClear();
});

describe('trialRefusalCopyKey', () => {
  it('gives a role that can change the plan the copy that offers the step', () => {
    expect(trialRefusalCopyKey(true)).toBe(TRIAL_ENDED_BILLING_COPY_KEY);
  });

  it('gives everyone else the copy that names the owner who can', () => {
    expect(trialRefusalCopyKey(false)).toBe(TRIAL_ENDED_COPY_KEY);
  });

  it('names the destination when the surface renders no billing step', () => {
    expect(trialRefusalCopyKey(true, 'absent')).toBe(TRIAL_ENDED_BILLING_AT_KILO_AI_COPY_KEY);
  });

  // A reader who cannot change the plan gets the owner-naming copy however the
  // surface is built: the destination sentence would hand a member an
  // instruction the server would refuse anyway.
  it('keeps the owner-naming copy for a member whatever the step is', () => {
    expect(trialRefusalCopyKey(false, 'absent')).toBe(TRIAL_ENDED_COPY_KEY);
  });

  it('keeps the three readers on three keys', () => {
    expect(TRIAL_ENDED_COPY_KEY).not.toBe(TRIAL_ENDED_BILLING_COPY_KEY);
    expect(TRIAL_ENDED_BILLING_COPY_KEY).not.toBe(TRIAL_ENDED_BILLING_AT_KILO_AI_COPY_KEY);
    expect(TRIAL_ENDED_COPY_KEY).not.toBe(TRIAL_ENDED_BILLING_AT_KILO_AI_COPY_KEY);
  });
});

describe('trialRefusalMessage', () => {
  it('translates the key each reader gets', () => {
    expect(trialRefusalMessage(true)).toBe(i18n.t(TRIAL_ENDED_BILLING_COPY_KEY));
    expect(trialRefusalMessage(false)).toBe(i18n.t(TRIAL_ENDED_COPY_KEY));
    expect(trialRefusalMessage(true, 'absent')).toBe(
      i18n.t(TRIAL_ENDED_BILLING_AT_KILO_AI_COPY_KEY)
    );
  });

  it('holds different copy for every reader', () => {
    expect(trialRefusalMessage(true)).not.toBe(trialRefusalMessage(false));
    expect(trialRefusalMessage(true, 'absent')).not.toBe(trialRefusalMessage(true));
    expect(trialRefusalMessage(true, 'absent')).not.toBe(trialRefusalMessage(false));
  });

  // All three sentences must state the state; only the role that can end it is
  // offered a step, and only its destination-less surface offers the step in
  // prose, so each sentence differs in who is asked to act and where.
  it('states the ended trial and differs in who is asked to act', () => {
    expect(trialRefusalMessage(true)).toContain("The organization's trial has ended");
    expect(trialRefusalMessage(false)).toContain("The organization's trial has ended");
    expect(trialRefusalMessage(true, 'absent')).toContain("The organization's trial has ended");
    expect(trialRefusalMessage(true)).toContain('You can update billing');
    expect(trialRefusalMessage(true, 'absent')).toContain('at kilo.ai');
    expect(trialRefusalMessage(false)).toContain('An organization owner can update billing');
    expect(trialRefusalMessage(false)).not.toContain('You can update billing');
  });
});

/** The route string, so an expectation reads without stringifying an `Href`. */
const BILLING_PATH = '/(app)/(tabs)/(3_profile)/organization/billing';

describe('billingHrefFor', () => {
  // The screen reads its organization from `?org=`, so a caller that resolved a
  // role against one organization must name it or the step opens another.
  it('names the organization whose role the caller read', () => {
    expect(billingHrefFor('org-1')).toBe(`${BILLING_PATH}?org=org-1`);
  });

  it('keeps the screen default when the caller read no organization', () => {
    expect(billingHrefFor()).toBe(ORGANIZATION_BILLING_HREF);
    expect(billingHrefFor(null)).toBe(ORGANIZATION_BILLING_HREF);
  });

  it('encodes an id that is not already a query-safe value', () => {
    expect(billingHrefFor('org/1 +2')).toBe(`${BILLING_PATH}?org=org%2F1%20%2B2`);
  });
});

describe('useBillingAction', () => {
  it('opens billing for the organization whose role it read', () => {
    state.role = 'owner';

    const step = mountBillingAction('org-1');
    expect(step?.label).toBe(i18n.t('organization.hub.manageBilling'));
    step?.onPress();

    expect(state.push).toHaveBeenCalledWith(`${BILLING_PATH}?org=org-1`);
  });

  it('keeps the selection for a caller that read no organization', () => {
    state.role = 'owner';

    mountBillingAction()?.onPress();

    expect(state.push).toHaveBeenCalledWith(ORGANIZATION_BILLING_HREF);
  });

  it('offers no step to a role the server would refuse', () => {
    state.role = 'member';

    expect(mountBillingAction('org-1')).toBeUndefined();
  });
});
