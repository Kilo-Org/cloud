// The settings card's contract: the three destinations the web owns, each with
// the action label the US storefront may draw and the statement every other
// storefront reads instead.

import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/render-with-providers';

import { BillingWebSettings } from './billing-web-settings';

import '@/i18n';

vi.mock('react-native', () => ({ View: 'View' }));

vi.mock('@/components/organization/external-billing-link', async () => {
  const { createElement: h } = await import('react');
  return {
    ExternalBillingLink: (props: Record<string, unknown>) => h('ExternalBillingLink', props),
  };
});

const SUBSCRIPTIONS_URL = 'http://localhost:3000/organizations/org-1/subscriptions';
const AUTO_TOP_UP_URL = 'http://localhost:3000/org-1';

type Destination = Readonly<{ url?: string; label?: string; description?: string }>;

describe('BillingWebSettings', () => {
  it('offers the plan, the seats and auto top-up as the web settings they are', async () => {
    const { renderer, unmount } = await renderWithProviders(
      createElement(BillingWebSettings, {
        subscriptionsUrl: SUBSCRIPTIONS_URL,
        planLabel: 'Change plan',
        autoTopUpUrl: AUTO_TOP_UP_URL,
        autoTopUpLabel: 'Manage auto top-up',
      })
    );

    const nodes = renderer.root.findAllByType('ExternalBillingLink' as never);
    expect(nodes.map(node => node.props as Destination)).toEqual([
      {
        url: SUBSCRIPTIONS_URL,
        label: 'Change plan',
        description: 'The plan is managed on the web.',
      },
      {
        url: `${SUBSCRIPTIONS_URL}/seats`,
        label: 'Buy seats',
        description: 'Seats are managed on the web.',
      },
      {
        url: AUTO_TOP_UP_URL,
        label: 'Manage auto top-up',
        description: 'Auto top-up is managed on the web.',
      },
    ]);
    unmount();
  });

  it('drops the plan row when the ended-plan banner already carries it', async () => {
    const { renderer, unmount } = await renderWithProviders(
      createElement(BillingWebSettings, {
        subscriptionsUrl: SUBSCRIPTIONS_URL,
        planLabel: null,
        autoTopUpUrl: AUTO_TOP_UP_URL,
        autoTopUpLabel: 'Set up auto top-up',
      })
    );

    const nodes = renderer.root.findAllByType('ExternalBillingLink' as never);
    expect(nodes.map(node => (node.props as Destination).url)).toEqual([
      `${SUBSCRIPTIONS_URL}/seats`,
      AUTO_TOP_UP_URL,
    ]);
    unmount();
  });
});
