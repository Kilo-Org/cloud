import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { ProfileManageSlot } from '@/components/profiles/profile-manage-slot';
import { renderWithProviders } from '@/test/render-with-providers';

vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

/** Stands in for the add, edit or delete control the caller would supply. */
const ACTION = 'Profile action';

const SENTENCE = i18n.t('profiles.organizationRoleRequired');
// A `plan-ended` reader is an owner or an admin, which is always a billing
// role, and this slot renders no billing step: the sentence names kilo.ai.
const PLAN_ENDED_SENTENCE = i18n.t('common.organizationTrialEndedBillingAtKiloAi');
const OWNER_NAMING_SENTENCE = i18n.t('common.organizationTrialEnded');

describe('ProfileManageSlot', () => {
  it('allowed: renders the child and not the sentence', async () => {
    const { renderer, unmount } = await renderWithProviders(
      createElement(
        ProfileManageSlot,
        { permission: 'allowed' },
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

    unmount();
  });

  it('read-only: renders the sentence in place of the action, and not the action', async () => {
    const { renderer, unmount } = await renderWithProviders(
      createElement(
        ProfileManageSlot,
        { permission: 'read-only' },
        createElement('Action', null, ACTION)
      )
    );

    const texts = renderer.root
      .findAll(node => String(node.type) === 'Text')
      .map(node => node.props.children);

    expect(texts).toEqual([SENTENCE]);
    expect(renderer.root.findAll(node => String(node.type) === 'Action')).toHaveLength(0);

    unmount();
  });

  it('plan-ended: renders the ended-plan sentence in place of the action', async () => {
    const { renderer, unmount } = await renderWithProviders(
      createElement(
        ProfileManageSlot,
        { permission: 'plan-ended' },
        createElement('Action', null, ACTION)
      )
    );

    const texts = renderer.root
      .findAll(node => String(node.type) === 'Text')
      .map(node => node.props.children);

    // The plan, not the role, is what stops this manager: an action here would
    // be refused by the server on every press. The manager can change the plan,
    // so the sentence names the destination instead of the owner who can.
    expect(texts).toEqual([PLAN_ENDED_SENTENCE]);
    expect(texts).not.toContain(OWNER_NAMING_SENTENCE);
    expect(renderer.root.findAll(node => String(node.type) === 'Action')).toHaveLength(0);

    unmount();
  });

  it('resolving: renders neither the action nor the sentence', async () => {
    const { renderer, unmount } = await renderWithProviders(
      createElement(
        ProfileManageSlot,
        { permission: 'resolving' },
        createElement('Action', null, ACTION)
      )
    );

    // Neither claim is safe before the role is known: an action a member would be
    // refused, and the sentence would tell a manager they cannot act on what they can.
    expect(renderer.root.findAll(node => String(node.type) === 'Action')).toHaveLength(0);
    expect(renderer.root.findAll(node => String(node.type) === 'Text')).toHaveLength(0);
    expect(renderer.root.findAll(node => String(node.type) === 'View')).toHaveLength(0);

    unmount();
  });
});
