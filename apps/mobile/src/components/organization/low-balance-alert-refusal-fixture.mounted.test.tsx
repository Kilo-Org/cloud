// The low-balance alert refusal fixture's two readers: the billing role gets
// the sentence that offers the step plus the step itself, and a member gets the
// sentence that names the owner with no control at all. The design gate opens
// both through `?billing=1`, so the fixture must paint exactly what each reader
// of the real sheet sees on a rejected save.

import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { LowBalanceAlertRefusalFixture } from '@/components/organization/low-balance-alert-refusal-fixture';
import { i18n } from '@/i18n';
import { renderWithProviders } from '@/test/render-with-providers';
import { type ReactTestInstance, type ReactTestRenderer } from '@/test/renderer';

vi.mock('react-native', () => ({
  I18nManager: { isRTL: false },
  Platform: { OS: 'android' },
  Pressable: 'Pressable',
  View: 'View',
}));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'ScrollView' }));
vi.mock('@/components/ui/accessible-status', () => ({ AccessibleStatus: 'AccessibleStatus' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/utils', () => ({ cn: (...parts: unknown[]) => parts.filter(Boolean).join(' ') }));

function statusMessages(renderer: ReactTestRenderer): string[] {
  return renderer.root
    .findAll(node => String(node.type) === 'AccessibleStatus')
    .map(node => node.props.message)
    .filter((message): message is string => typeof message === 'string');
}

/** The steps painted under the refusal line, in screen order. */
function steps(renderer: ReactTestRenderer): ReactTestInstance[] {
  return renderer.root.findAll(node => String(node.type) === 'Pressable');
}

describe('LowBalanceAlertRefusalFixture', () => {
  it('gives a billing role the refusal copy that offers the step and the manage-billing step', async () => {
    const { renderer, unmount } = await renderWithProviders(
      createElement(LowBalanceAlertRefusalFixture, { canManageBilling: true })
    );

    expect(statusMessages(renderer)).toEqual([i18n.t('common.organizationTrialEndedBilling')]);
    expect(statusMessages(renderer)).not.toContain(i18n.t('common.organizationTrialEnded'));

    const controls = steps(renderer);
    expect(controls.map(control => control.props.accessibilityLabel)).toEqual([
      i18n.t('organization.hub.manageBilling'),
    ]);
    expect(controls[0]?.props.accessibilityRole).toBe('button');
    // The step is a no-op on purpose: the fixture must not reach billing.
    expect(() => {
      (controls[0]?.props.onPress as (() => void) | undefined)?.();
    }).not.toThrow();

    unmount();
  });

  it('gives a member the copy that names the owner and no control to press', async () => {
    const { renderer, unmount } = await renderWithProviders(
      createElement(LowBalanceAlertRefusalFixture, { canManageBilling: false })
    );

    expect(statusMessages(renderer)).toEqual([i18n.t('common.organizationTrialEnded')]);
    expect(statusMessages(renderer)).not.toContain(i18n.t('common.organizationTrialEndedBilling'));
    expect(steps(renderer)).toEqual([]);

    unmount();
  });

  it('carries the gate readiness testIDs and the disabled Save the refusal sits above', async () => {
    const { renderer, unmount } = await renderWithProviders(
      createElement(LowBalanceAlertRefusalFixture, { canManageBilling: false })
    );

    expect(
      renderer.root.findAll(node => node.props.testID === 'low-balance-alert-refusal')
    ).toHaveLength(1);
    expect(
      renderer.root.findAll(node => node.props.testID === 'low-balance-alert-refusal-status')
    ).toHaveLength(1);
    const save = renderer.root.find(node => String(node.type) === 'Button');
    expect(save.props.disabled).toBe(true);

    unmount();
  });
});
