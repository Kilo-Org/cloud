/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (node env, no jsdom) */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { type ProviderReviewCapability } from '@kilocode/app-shared/provider-review';
import type * as ReactI18next from 'react-i18next';
import { PrReviewCapabilityBanner } from './pr-review-capability-banner';

vi.mock('react-i18next', async importOriginal => {
  const actual = await importOriginal<typeof ReactI18next>();
  return {
    ...actual,
    useTranslation: () => {
      const i18n = actual.getI18n();
      return { t: i18n.t.bind(i18n), i18n };
    },
  };
});

vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('react-native-reanimated', () => ({
  default: { View: 'Animated.View' },
  FadeIn: { duration: () => ({}) },
  FadeOut: { duration: () => ({}) },
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

const UNSUPPORTED: ProviderReviewCapability = {
  supported: false,
  reason: 'Bitbucket Cloud does not expose auto-merge in its API',
};
const SUPPORTED: ProviderReviewCapability = { supported: true, reason: '' };

function renderBanner(
  capability: ProviderReviewCapability | undefined,
  overrides?: { title?: string; reason?: string }
): TestRenderer.ReactTestRenderer {
  let renderer: TestRenderer.ReactTestRenderer | null = null;
  act(() => {
    renderer = TestRenderer.create(
      createElement(PrReviewCapabilityBanner, { capability, ...overrides })
    );
  });
  // eslint-disable-next-line typescript-eslint/no-unnecessary-condition -- the act() callback runs synchronously; this narrows the definite assignment
  if (!renderer) {
    throw new Error('Failed to create test renderer');
  }
  return renderer;
}

function textsOf(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAll(node => (node.type as string) === 'Text')
    .flatMap(node => [node.props.children as string])
    .flat()
    .filter((child): child is string => typeof child === 'string');
}

describe('PrReviewCapabilityBanner', () => {
  it('renders the localized title and the provider reason for a supported:false capability', () => {
    const renderer = renderBanner(UNSUPPORTED);
    const texts = textsOf(renderer);
    expect(texts).toContain('Not available on this provider');
    expect(texts).toContain(UNSUPPORTED.reason);
    renderer.unmount();
  });

  it('announces title and reason together for accessibility', () => {
    const renderer = renderBanner(UNSUPPORTED);
    const view = renderer.root.find(node => (node.type as string) === 'Animated.View');
    expect(view.props.accessibilityLabel).toBe(
      `Not available on this provider: ${UNSUPPORTED.reason}`
    );
    renderer.unmount();
  });

  it('renders a localized title/reason override instead of the generic banner copy', () => {
    const renderer = renderBanner(UNSUPPORTED, {
      title: 'Auto-merge is not available',
      reason: 'Bitbucket Cloud does not expose auto-merge in its API',
    });
    const texts = textsOf(renderer);
    expect(texts).toContain('Auto-merge is not available');
    expect(texts).toContain('Bitbucket Cloud does not expose auto-merge in its API');
    expect(texts).not.toContain('Not available on this provider');
    renderer.unmount();
  });

  it('keeps capability.reason as the fallback when no override is passed', () => {
    const unknownCapability: ProviderReviewCapability = {
      supported: false,
      reason: 'Some provider answers a reason the catalog does not name',
    };
    const renderer = renderBanner(unknownCapability);
    const texts = textsOf(renderer);
    expect(texts).toContain('Not available on this provider');
    expect(texts).toContain(unknownCapability.reason);
    renderer.unmount();
  });

  it('renders nothing for a supported capability — the affordance itself shows', () => {
    const renderer = renderBanner(SUPPORTED);
    expect(renderer.toJSON()).toBeNull();
    renderer.unmount();
  });

  it('renders nothing while the capability is not loaded (undefined)', () => {
    const renderer = renderBanner(undefined);
    expect(renderer.toJSON()).toBeNull();
    renderer.unmount();
  });
});
