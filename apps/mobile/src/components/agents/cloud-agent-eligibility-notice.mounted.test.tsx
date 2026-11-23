import { createElement } from 'react';
import type * as ReactI18next from 'react-i18next';
import { describe, expect, it, vi } from 'vitest';
import { act, TestRenderer } from '@/test/renderer';

import { i18n } from '@/i18n';
import { type CloudAgentEligibilityState } from '@/lib/cloud-agent-eligibility';
import { CloudAgentEligibilityNotice } from './cloud-agent-eligibility-notice';

vi.mock('react-i18next', async importOriginal => {
  const actual = await importOriginal<typeof ReactI18next>();
  return { ...actual, useTranslation: () => ({ t: actual.getI18n().t.bind(actual.getI18n()) }) };
});
vi.mock('react-native', () => ({ Platform: { OS: 'ios' }, Pressable: 'Pressable', View: 'View' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/add-credits-row', () => ({ AddCreditsRow: 'AddCreditsRow' }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: () => undefined }) }));
vi.mock('@/components/ui/icons', () => ({ Info: 'Info' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ info: '#2260EB' }),
}));

const LIMITED: CloudAgentEligibilityState = {
  kind: 'ready',
  eligibility: { balance: 0.4, minBalance: 1, accessLevel: 'limited', isEligible: false },
};
const FULL: CloudAgentEligibilityState = {
  kind: 'ready',
  eligibility: { balance: 12, minBalance: 1, accessLevel: 'full', isEligible: true },
};

async function renderNotice(state: CloudAgentEligibilityState, organizationId?: string) {
  const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
    current: undefined,
  };
  await act(async () => {
    await vi.waitFor(() => {
      expect(i18n.t('agentChat.newSession.eligibility.limitedTitle')).toBe('Free models available');
    });
    rendererRef.current = TestRenderer.create(
      createElement(CloudAgentEligibilityNotice, {
        state,
        organizationId,
        onRetry: () => undefined,
      })
    );
  });
  const renderer = rendererRef.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

function textsOf(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAll(node => typeof node.props.children === 'string')
    .map(node => node.props.children as string)
    .join(' ');
}

describe('CloudAgentEligibilityNotice', () => {
  it('draws nothing while the read is pending', async () => {
    const renderer = await renderNotice({ kind: 'pending' });
    expect(renderer.toJSON()).toBeNull();
  });

  it('draws nothing for an account whose balance is enough', async () => {
    const renderer = await renderNotice(FULL);
    expect(renderer.toJSON()).toBeNull();
  });

  it('states the limited balance and offers the top-up', async () => {
    const renderer = await renderNotice(LIMITED);

    const text = textsOf(renderer);
    expect(text).toContain('Free models available');
    // The balance reaches the sentence the reader sees, in the money shape the
    // rest of the app uses.
    expect(text).toContain('$0.40');

    const credits = renderer.root.findAll(node => (node.type as string) === 'AddCreditsRow');
    expect(credits).toHaveLength(1);
    // A personal account buys its own credits in the app, so the row carries the
    // press handler rather than the organization's external billing page.
    expect(credits[0]?.props.onPress).toBeTypeOf('function');
    expect(credits[0]?.props.url).toBeUndefined();
  });

  it('sends an organization top-up to its own billing page', async () => {
    const renderer = await renderNotice(LIMITED, '5f0e2b7a-0000-4000-8000-000000000001');
    const credits = renderer.root.findAll(node => (node.type as string) === 'AddCreditsRow');
    expect(credits[0]?.props.url).toContain('/payment-details');
    expect(credits[0]?.props.onPress).toBeUndefined();
  });

  it('states a failed read and offers its retry, without claiming a balance', async () => {
    const renderer = await renderNotice({ kind: 'failed', isRetrying: false });

    const text = textsOf(renderer);
    expect(text).toContain("Couldn't check your balance.");
    // No balance and no top-up: the read never answered, so the block claims
    // nothing it cannot support.
    expect(renderer.root.findAll(node => (node.type as string) === 'AddCreditsRow')).toHaveLength(
      0
    );

    const retry = renderer.root.findAll(
      node => (node.type as string) === 'Pressable' && node.props.accessibilityRole === 'button'
    );
    expect(retry).toHaveLength(1);
    expect(retry[0]?.props.accessibilityLabel).toBe(i18n.t('common.retry'));
  });

  it('keeps the failed line up while its retry runs, with the control disabled', async () => {
    const renderer = await renderNotice({ kind: 'failed', isRetrying: true });

    expect(textsOf(renderer)).toContain("Couldn't check your balance.");
    const retry = renderer.root.findAll(
      node => (node.type as string) === 'Pressable' && node.props.accessibilityRole === 'button'
    );
    expect(retry).toHaveLength(1);
    expect(retry[0]?.props.disabled).toBe(true);
    expect(retry[0]?.props.accessibilityState).toEqual({ disabled: true });
  });

  it('announces the limited state as an alert, because it arrives after mount', async () => {
    const renderer = await renderNotice(LIMITED);
    const alerts = renderer.root.findAll(node => node.props.accessibilityRole === 'alert');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.props.testID).toBe('cloud-agent-eligibility-notice');
  });
});
