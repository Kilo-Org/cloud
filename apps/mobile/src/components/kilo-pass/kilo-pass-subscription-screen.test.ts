import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@/i18n';

import { KiloPassSubscriptionScreen } from './kilo-pass-subscription-screen';

const mockedPlatform = vi.hoisted(() => ({ OS: 'ios' as string }));
const mocks = vi.hoisted(() => ({
  presentation: {
    isPending: false,
    isError: false,
    data: null as { kind: string; webUrl: string | null } | null,
    refetch: vi.fn(),
  },
}));

vi.mock('react-native', () => ({ Platform: mockedPlatform, View: 'View' }));
vi.mock('@tanstack/react-query', () => ({ useQuery: () => mocks.presentation }));
vi.mock('@/components/centered-state', () => ({ CenteredState: 'CenteredState' }));
vi.mock('@/components/detail-screen', () => ({ DetailScreenScrollView: 'DetailScreenScrollView' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/external-link', () => ({ openExternalUrl: vi.fn() }));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({ kiloPass: { getPurchasePresentation: { queryOptions: () => ({}) } } }),
}));

async function renderScreen(): Promise<TestRenderer.ReactTestRenderer> {
  const holder: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    holder.current = TestRenderer.create(createElement(KiloPassSubscriptionScreen));
    await Promise.resolve();
  });
  const renderer = holder.current;
  if (!renderer) {
    throw new Error('Failed to create test renderer');
  }
  return renderer;
}

function allText(renderer: TestRenderer.ReactTestRenderer): string {
  const texts: string[] = [];
  const walk = (instance: TestRenderer.ReactTestInstance): void => {
    for (const child of instance.children) {
      if (typeof child === 'string') {
        texts.push(child);
      } else if (typeof child === 'number') {
        texts.push(String(child));
      } else {
        walk(child);
      }
    }
  };
  walk(renderer.root);
  return texts.join(' ');
}

describe('KiloPassSubscriptionScreen', () => {
  beforeEach(() => {
    mockedPlatform.OS = 'ios';
    mocks.presentation.isPending = false;
    mocks.presentation.isError = false;
    mocks.presentation.data = null;
  });

  it.each(['web_management', 'unavailable'])(
    'centers %s outside the purchase scroller',
    async kind => {
      mocks.presentation.data = { kind, webUrl: null };
      const renderer = await renderScreen();
      expect(renderer.root.findAll(node => String(node.type) === 'CenteredState')).toHaveLength(1);
      expect(
        renderer.root.findAll(node => String(node.type) === 'DetailScreenScrollView')
      ).toHaveLength(0);
      renderer.unmount();
    }
  );

  it('keeps a cached presentation after a refetch failure', async () => {
    mocks.presentation.data = { kind: 'web_management', webUrl: null };
    mocks.presentation.isError = true;
    const renderer = await renderScreen();
    expect(allText(renderer)).toContain('This Kilo Pass is managed on web');
    expect(allText(renderer)).not.toContain("Couldn't load Kilo Pass.");
    renderer.unmount();
  });

  it('non-retryable presentation: unavailable shows the unavailable screen with no purchase CTA', async () => {
    mocks.presentation.data = { kind: 'unavailable', webUrl: null };
    const renderer = await renderScreen();
    expect(allText(renderer)).toContain('Kilo Pass purchase is not available right now.');
    expect(renderer.root.findAll(node => String(node.type) === 'Button')).toHaveLength(0);
    renderer.unmount();
  });

  it('non-retryable presentation: web_management shows Manage and no purchase CTA', async () => {
    mockedPlatform.OS = 'android';
    mocks.presentation.data = {
      kind: 'web_management',
      webUrl: 'https://example.com/subscriptions/kilo-pass',
    };
    const renderer = await renderScreen();
    expect(allText(renderer)).toContain('This Kilo Pass is managed on web');
    expect(allText(renderer)).toContain('Manage');
    renderer.unmount();
  });
});
