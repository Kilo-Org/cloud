// The storefront fork: only an iOS build in the US storefront draws the
// control. Every other surface shows the destination as a statement, never the
// action label — a purchase call to action stays one even when it is not a link.

import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import { ExternalBillingLink } from './external-billing-link';

const platform = vi.hoisted(() => ({ linkAllowed: true }));
const openExternalUrl = vi.hoisted(() => vi.fn());

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/ui/button', async () => {
  const { createElement: h } = await import('react');
  return {
    Button: (props: Record<string, unknown> & { children?: unknown }) =>
      h('Button', props, props.children as never),
  };
});
vi.mock('@/components/ui/text', async () => {
  const { createElement: h } = await import('react');
  return {
    Text: (props: Record<string, unknown> & { children?: unknown }) =>
      h('Text', props, props.children as never),
  };
});
vi.mock('@/lib/a11y/tap-target', () => ({ STATE_ACTION_CLASS: 'state-action' }));
vi.mock('@/lib/billing/external-purchase-link', () => ({
  useCanLinkExternalPurchase: () => platform.linkAllowed,
}));
vi.mock('@/lib/external-link', () => ({ openExternalUrl }));
vi.mock('@/lib/utils', () => ({ cn: (...parts: unknown[]) => parts.filter(Boolean).join(' ') }));

const URL = 'http://localhost:3000/organizations/org-1/subscriptions/seats';
const LABEL = 'Buy seats';
const DESCRIPTION = 'Seats are managed on the web.';

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

function renderLink() {
  act(() => {
    const element = createElement(ExternalBillingLink, { url: URL, label: LABEL, description: DESCRIPTION });
    if (renderer) {
      renderer.update(element);
    } else {
      renderer = TestRenderer.create(element);
    }
  });
  if (!renderer) {
    throw new Error('Missing link renderer');
  }
  return renderer.root;
}

beforeEach(() => {
  platform.linkAllowed = true;
  openExternalUrl.mockClear();
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

describe('ExternalBillingLink', () => {
  it('draws the action where the storefront rule allows the link', () => {
    const root = renderLink();

    const [control] = root.findAllByType('Button');
    if (!control) {
      throw new Error('link control not found');
    }
    expect(control.props.accessibilityRole).toBe('button');
    expect(control.props.accessibilityLabel).toBe(LABEL);
    const label = root.findByType('Text');
    expect(label.props.children).toBe(LABEL);

    act(() => {
      (control.props.onPress as () => void)();
    });
    expect(openExternalUrl).toHaveBeenCalledWith(URL, { label: LABEL });
  });

  it('states the destination instead of calling for the purchase where the rule refuses', () => {
    platform.linkAllowed = false;
    const root = renderLink();

    expect(root.findAllByType('Button')).toHaveLength(0);
    const statement = root.findByType('Text');
    expect(statement.props.children).toBe(DESCRIPTION);
  });
});
