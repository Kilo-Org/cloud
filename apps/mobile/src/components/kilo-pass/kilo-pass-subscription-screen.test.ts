import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@/i18n';

import { KiloPassSubscriptionScreen } from './kilo-pass-subscription-screen';

const mockedPlatform = vi.hoisted(() => ({ OS: 'ios' as string }));
const mockRouter = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
const mocks = vi.hoisted(() => ({
  presentation: {
    isPending: false,
    isError: false,
    data: null as { kind: string; statusClass: string; webUrl: string | null } | null,
    refetch: vi.fn(),
  },
}));

vi.mock('expo-router', () => ({ useRouter: () => mockRouter }));
vi.mock('react-native', () => ({ Platform: mockedPlatform, View: 'View' }));
vi.mock('@tanstack/react-query', () => ({ useQuery: () => mocks.presentation }));
vi.mock('@/components/centered-state', () => ({ CenteredState: 'CenteredState' }));
vi.mock('@/components/detail-screen', () => ({ DetailScreenScrollView: 'DetailScreenScrollView' }));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/icons', () => ({ Crown: 'Crown' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/a11y/tap-target', () => ({ STATE_ACTION_CLASS: 'min-h-[48px]' }));
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

function nodesOfType(
  renderer: TestRenderer.ReactTestRenderer,
  type: string
): TestRenderer.ReactTestInstance[] {
  return renderer.root.findAll(node => String(node.type) === type);
}

describe('KiloPassSubscriptionScreen', () => {
  beforeEach(() => {
    mockedPlatform.OS = 'ios';
    mocks.presentation.isPending = false;
    mocks.presentation.isError = false;
    mocks.presentation.data = null;
    mocks.presentation.refetch.mockClear();
    mockRouter.replace.mockClear();
    mockRouter.push.mockClear();
  });

  it('unavailable: renders the shared empty state with a title and one way out', async () => {
    mocks.presentation.data = { kind: 'unavailable', statusClass: 'inactive', webUrl: null };
    const renderer = await renderScreen();
    const emptyState = nodesOfType(renderer, 'EmptyState');
    expect(emptyState).toHaveLength(1);
    expect(emptyState[0]?.props.title).toBe('Not available right now');
    // The plain kind has nothing the title does not say, so it carries no
    // description that would restate it.
    expect(emptyState[0]?.props.description).toBeUndefined();
    // The state is a finished surface, not the raw centered text it used to be.
    expect(nodesOfType(renderer, 'CenteredState')).toHaveLength(0);
    expect(nodesOfType(renderer, 'DetailScreenScrollView')).toHaveLength(0);
    const action = emptyState[0]?.props.action as {
      props: {
        accessibilityLabel: string;
        className: string;
        children: { type: unknown; props: { children: unknown } };
        onPress: () => void;
      };
    };
    expect(action.props.accessibilityLabel).toBe('Buy credits');
    // Pressable is a View, so the label must be a Text element; a bare string
    // child would paint nothing on either platform.
    expect(String(action.props.children.type)).toBe('Text');
    expect(action.props.children.props.children).toBe('Buy credits');
    expect(action.props.className.split(' ')).toContain('min-h-[48px]');
    act(() => {
      action.props.onPress();
    });
    expect(mockRouter.replace).toHaveBeenCalledWith('/(app)/credits');
    renderer.unmount();
  });

  it('unavailable: a lapsed pass states that the pass ended', async () => {
    mocks.presentation.data = { kind: 'unavailable', statusClass: 'terminal', webUrl: null };
    const renderer = await renderScreen();
    expect(nodesOfType(renderer, 'EmptyState')[0]?.props.description).toBe(
      'Your Kilo Pass has ended.'
    );
    renderer.unmount();
  });

  it('web_management: keeps the web copy and Manage, and renders no empty state', async () => {
    mockedPlatform.OS = 'android';
    mocks.presentation.data = {
      kind: 'web_management',
      statusClass: 'healthy',
      webUrl: 'https://example.com/subscriptions/kilo-pass',
    };
    const renderer = await renderScreen();
    expect(nodesOfType(renderer, 'EmptyState')).toHaveLength(0);
    expect(nodesOfType(renderer, 'CenteredState')).toHaveLength(1);
    expect(allText(renderer)).toContain('This Kilo Pass is managed on web');
    expect(allText(renderer)).toContain('Manage');
    const button = nodesOfType(renderer, 'Button').find(
      node => node.props.accessibilityLabel === 'Manage'
    );
    if (!button) {
      throw new Error('Manage action missing');
    }
    // The label must be a Text element, not a bare string: Pressable is a
    // View, and a View draws no text, so a bare string leaves a blank button.
    const label = button.find(node => String(node.type) === 'Text');
    expect(label.children).toEqual(['Manage']);
    // The lone centered CTA carries the 48dp Android target.
    expect((button.props.className as string).split(' ')).toContain('min-h-[48px]');
    renderer.unmount();
  });

  it('presentation error: Retry refetches the presentation once', async () => {
    const renderer = await renderScreen();
    expect(allText(renderer)).toContain("Couldn't load Kilo Pass.");
    expect(allText(renderer)).toContain('Kilo Pass could not be loaded. Try again.');
    const retry = renderer.root.findByProps({ accessibilityLabel: 'Retry loading Kilo Pass' });
    act(() => {
      (retry.props.onPress as () => void)();
    });
    expect(mocks.presentation.refetch).toHaveBeenCalledTimes(1);
    renderer.unmount();
  });

  it('keeps a cached presentation after a refetch failure', async () => {
    mocks.presentation.data = { kind: 'web_management', statusClass: 'healthy', webUrl: null };
    mocks.presentation.isError = true;
    const renderer = await renderScreen();
    expect(allText(renderer)).toContain('This Kilo Pass is managed on web');
    expect(allText(renderer)).not.toContain("Couldn't load Kilo Pass.");
    renderer.unmount();
  });
});
