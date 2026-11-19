import { type TFunction } from 'i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';

import { organizationPlanRefusalFor } from './plan-refusal-copy';

const opened = vi.hoisted(() => ({ openExternalUrl: vi.fn<() => Promise<void>>() }));

vi.mock('@/lib/external-link', () => ({
  openExternalUrl: opened.openExternalUrl,
}));

const t = i18n.t as TFunction;
const BILLING_URL = 'https://app.kilo.ai/organizations/org-1/subscriptions';

beforeEach(() => {
  opened.openExternalUrl.mockReset();
  opened.openExternalUrl.mockResolvedValue(undefined);
});

describe('organizationPlanRefusalFor', () => {
  it('offers the billing step to a role that can change the plan', () => {
    const refusal = organizationPlanRefusalFor({
      role: 'owner',
      canLinkBilling: true,
      billingUrl: BILLING_URL,
      t,
    });

    expect(refusal.message).toBe(i18n.t('organization.hub.planEnded'));
    expect(refusal.action?.label).toBe(i18n.t('organization.hub.manageBilling'));

    refusal.action?.onPress();

    expect(opened.openExternalUrl).toHaveBeenCalledTimes(1);
    expect(opened.openExternalUrl).toHaveBeenCalledWith(BILLING_URL, {
      label: i18n.t('organization.hub.manageBilling'),
    });
  });

  it('keeps the state sentence without a step when the storefront rule refuses the link', () => {
    const refusal = organizationPlanRefusalFor({
      role: 'billing_manager',
      canLinkBilling: false,
      billingUrl: BILLING_URL,
      t,
    });

    expect(refusal.message).toBe(i18n.t('organization.hub.planEnded'));
    expect(refusal.action).toBeUndefined();
    expect(opened.openExternalUrl).not.toHaveBeenCalled();
  });

  it('names the owner to a member, with no step even when the link is allowed', () => {
    const refusal = organizationPlanRefusalFor({
      role: 'member',
      canLinkBilling: true,
      billingUrl: BILLING_URL,
      t,
    });

    expect(refusal.message).toBe(i18n.t('common.organizationTrialEnded'));
    expect(refusal.message).not.toBe(i18n.t('organization.hub.planEnded'));
    expect(refusal.action).toBeUndefined();
  });

  it('treats an unresolved role as no billing authority', () => {
    const refusal = organizationPlanRefusalFor({
      role: undefined,
      canLinkBilling: true,
      billingUrl: BILLING_URL,
      t,
    });

    expect(refusal.message).toBe(i18n.t('common.organizationTrialEnded'));
    expect(refusal.action).toBeUndefined();
  });
});
