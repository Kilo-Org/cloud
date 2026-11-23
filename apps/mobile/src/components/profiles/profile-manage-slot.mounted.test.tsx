import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { ProfileManageSlot } from '@/components/profiles/profile-manage-slot';
import { renderWithProviders } from '@/test/render-with-providers';

vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
// The shared plan notice is asserted through its props, so a host element of
// the same name stands in for it.
vi.mock('@/components/organization/plan-notice', () => ({
  OrganizationPlanNotice: 'OrganizationPlanNotice',
}));
// The billing step reads the reader's membership list, a module chain the
// mounted project cannot load (see `vitest.setup.ts`), so the hook answers with
// a known step.
const BILLING_ACTION = vi.hoisted(() => ({
  label: 'Manage billing',
  onPress: () => undefined,
}));
vi.mock('@/lib/trial-refusal', () => ({ useBillingAction: () => BILLING_ACTION }));

/** Stands in for the add, edit or delete control the caller would supply. */
const ACTION = 'Profile action';

const SENTENCE = i18n.t('profiles.organizationRoleRequired');
// A `plan-ended` reader is an owner or an admin, which is always a billing
// role, and the slot pairs the step-offering sentence with that step.
const PLAN_ENDED_SENTENCE = i18n.t('common.organizationTrialEndedBilling');
// The state's own title, shared by every profile surface that states it.
const PLAN_TITLE = i18n.t('common.planRequiredTitle');
const OWNER_NAMING_SENTENCE = i18n.t('common.organizationTrialEnded');
const ORGANIZATION_ID = 'org-1';

describe('ProfileManageSlot', () => {
  it('allowed: renders the child and not the sentence', async () => {
    const { renderer, unmount } = await renderWithProviders(
      createElement(
        ProfileManageSlot,
        { permission: 'allowed', organizationId: ORGANIZATION_ID },
        createElement('Action', null, ACTION)
      )
    );

    const actions = renderer.root.findAll(node => String(node.type) === 'Action');
    const texts = renderer.root
      .findAll(node => String(node.type) === 'Text')
      .map(node => node.props.children);

    expect(actions).toHaveLength(1);
    expect(actions[0]?.props.children).toBe(ACTION);
    expect(texts).not.toContain(SENTENCE);
    expect(renderer.root.findAll(node => String(node.type) === 'OrganizationPlanNotice')).toEqual(
      []
    );

    unmount();
  });

  it('read-only: renders the sentence in place of the action, and not the action', async () => {
    const { renderer, unmount } = await renderWithProviders(
      createElement(
        ProfileManageSlot,
        { permission: 'read-only', organizationId: ORGANIZATION_ID },
        createElement('Action', null, ACTION)
      )
    );

    const texts = renderer.root
      .findAll(node => String(node.type) === 'Text')
      .map(node => node.props.children);

    expect(texts).toEqual([SENTENCE]);
    expect(renderer.root.findAll(node => String(node.type) === 'Action')).toHaveLength(0);
    expect(renderer.root.findAll(node => String(node.type) === 'OrganizationPlanNotice')).toEqual(
      []
    );

    unmount();
  });

  it('plan-ended: paints the titled plan notice with the step-offering copy and the billing step', async () => {
    const { renderer, unmount } = await renderWithProviders(
      createElement(
        ProfileManageSlot,
        { permission: 'plan-ended', organizationId: ORGANIZATION_ID },
        createElement('Action', null, ACTION)
      )
    );

    // The plan, not the role, is what stops this manager: an action here would
    // be refused by the server on every press. The reader can change the plan,
    // so the slot paints the shared titled notice with the sentence that pairs
    // with the billing step under it, and stretches across an `EmptyState`'s
    // centered action cell.
    const notices = renderer.root.findAll(node => String(node.type) === 'OrganizationPlanNotice');
    expect(notices).toHaveLength(1);
    expect(notices[0]?.props.title).toBe(PLAN_TITLE);
    expect(notices[0]?.props.message).toBe(PLAN_ENDED_SENTENCE);
    expect(notices[0]?.props.message).not.toBe(OWNER_NAMING_SENTENCE);
    expect(notices[0]?.props.className).toContain('self-stretch');
    expect(notices[0]?.props.action).toBe(BILLING_ACTION);
    expect(renderer.root.findAll(node => String(node.type) === 'Text')).toHaveLength(0);
    expect(renderer.root.findAll(node => String(node.type) === 'Action')).toHaveLength(0);

    unmount();
  });

  it('resolving: renders neither the action nor the sentence', async () => {
    const { renderer, unmount } = await renderWithProviders(
      createElement(
        ProfileManageSlot,
        { permission: 'resolving', organizationId: ORGANIZATION_ID },
        createElement('Action', null, ACTION)
      )
    );

    // Neither claim is safe before the role is known: an action a member would be
    // refused, and the sentence would tell a manager they cannot act on what they can.
    expect(renderer.root.findAll(node => String(node.type) === 'Action')).toHaveLength(0);
    expect(renderer.root.findAll(node => String(node.type) === 'Text')).toHaveLength(0);
    expect(renderer.root.findAll(node => String(node.type) === 'View')).toHaveLength(0);
    expect(renderer.root.findAll(node => String(node.type) === 'OrganizationPlanNotice')).toEqual(
      []
    );

    unmount();
  });
});
