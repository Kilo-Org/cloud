// The settings card's two shapes: a storefront that may link to web billing
// gets the heading and the three destinations; every other storefront gets one
// statement and no heading naming the web.

import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/render-with-providers';

import { BillingWebSettings } from './billing-web-settings';

import '@/i18n';

const storefront = vi.hoisted(() => ({ linkAllowed: false }));

vi.mock('@/components/ui/text', async () => {
  const { createElement: h } = await import('react');
  return {
    Text: (props: Record<string, unknown> & { children?: unknown }) =>
      h('Text', props, props.children as never),
  };
});
vi.mock('@/components/ui/section', async () => {
  const { createElement: h } = await import('react');
  return {
    Section: (props: Record<string, unknown> & { children?: unknown }) =>
      h('Section', props, props.children as never),
  };
});
vi.mock('@/components/ui/card', async () => {
  const { createElement: h } = await import('react');
  return {
    Card: (props: Record<string, unknown> & { children?: unknown }) =>
      h('Card', props, props.children as never),
  };
});
vi.mock('@/lib/billing/external-purchase-link', () => ({
  useCanLinkExternalPurchase: () => storefront.linkAllowed,
}));
vi.mock('@/components/organization/external-billing-link', async () => {
  const { createElement: h } = await import('react');
  return {
    ExternalBillingLink: (props: Record<string, unknown>) => h('ExternalBillingLink', props),
  };
});

const SUBSCRIPTIONS_URL = 'http://localhost:3000/organizations/org-1/subscriptions';
const AUTO_TOP_UP_URL = 'http://localhost:3000/org-1';

type Destination = Readonly<{ url?: string; label?: string }>;

function renderSettings(planLabel: string | null) {
  return renderWithProviders(
    createElement(BillingWebSettings, {
      subscriptionsUrl: SUBSCRIPTIONS_URL,
      planLabel,
      autoTopUpUrl: AUTO_TOP_UP_URL,
      autoTopUpLabel: 'Manage auto top-up',
    })
  );
}

function texts(renderer: {
  root: { findAllByType: (type: never) => { props: { children?: unknown } }[] };
}) {
  return renderer.root
    .findAllByType('Text' as never)
    .map(node => node.props.children)
    .filter((child): child is string => typeof child === 'string');
}

describe('BillingWebSettings', () => {
  beforeEach(() => {
    storefront.linkAllowed = false;
  });

  it('states once, with no heading, where the settings live off the link storefront', async () => {
    const { renderer, unmount } = await renderSettings('Change plan');

    expect(renderer.root.findAllByType('ExternalBillingLink' as never)).toEqual([]);
    expect(renderer.root.findAllByType('Section' as never)).toEqual([]);
    expect(texts(renderer)).toEqual(['The plan, seats and auto top-up are managed on the web.']);
    unmount();
  });

  it('offers the three destinations under their heading where the storefront may link', async () => {
    storefront.linkAllowed = true;
    const { renderer, unmount } = await renderSettings('Change plan');

    const nodes = renderer.root.findAllByType('ExternalBillingLink' as never);
    expect(nodes.map(node => node.props as Destination)).toEqual([
      { url: SUBSCRIPTIONS_URL, label: 'Change plan' },
      { url: `${SUBSCRIPTIONS_URL}/seats`, label: 'Buy seats' },
      { url: AUTO_TOP_UP_URL, label: 'Manage auto top-up' },
    ]);
    const [section] = renderer.root.findAllByType('Section' as never);
    expect(section.props.label).toBe('Billing settings on the web');
    unmount();
  });

  it('drops the plan row when the ended-plan banner already carries it', async () => {
    storefront.linkAllowed = true;
    const { renderer, unmount } = await renderSettings(null);

    const nodes = renderer.root.findAllByType('ExternalBillingLink' as never);
    expect(nodes.map(node => (node.props as Destination).url)).toEqual([
      `${SUBSCRIPTIONS_URL}/seats`,
      AUTO_TOP_UP_URL,
    ]);
    unmount();
  });
});
