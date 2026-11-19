// The link control: the storefront rule is the caller's (BillingWebSettings), so
// this component always draws the control it was asked for.

import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import { ExternalBillingLink } from './external-billing-link';

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
vi.mock('@/lib/external-link', () => ({ openExternalUrl }));
vi.mock('@/lib/utils', () => ({ cn: (...parts: unknown[]) => parts.filter(Boolean).join(' ') }));

const URL = 'http://localhost:3000/organizations/org-1/subscriptions/seats';
const LABEL = 'Buy seats';

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

function renderLink() {
  act(() => {
    const element = createElement(ExternalBillingLink, { url: URL, label: LABEL });
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
  openExternalUrl.mockClear();
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

describe('ExternalBillingLink', () => {
  it('draws the action and opens the web page it names', () => {
    const root = renderLink();

    const [control] = root.findAllByType('Button');
    if (!control) {
      throw new Error('link control not found');
    }
    expect(control.props.accessibilityRole).toBe('button');
    expect(control.props.accessibilityLabel).toBe(LABEL);
    expect(control.props.accessibilityHint).toBe('organization.billing.opensOnWeb');
    const label = root.findByType('Text');
    expect(label.props.children).toBe(LABEL);

    act(() => {
      (control.props.onPress as () => void)();
    });
    expect(openExternalUrl).toHaveBeenCalledWith(URL, { label: LABEL });
  });
});
