/* eslint-disable max-lines -- one mounted screen with the sheet's native boundaries mocked; splitting would duplicate the render setup. */
import { createElement } from 'react';
import type * as ReactI18next from 'react-i18next';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';

import { SessionDetailLoadingScreen } from './session-detail-loading-screen';

// The loading screen mounts the real context sheet. Only its native boundaries
// are mocked: clipboard, haptics, the sheet surface, and the svg ring.
const holder = vi.hoisted(() => ({
  copiedLinks: [] as { sessionId: string; anchorMessageId: string | null }[],
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: { instances: [] }, isPending: false }),
}));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    activeSessions: { listInstances: { queryOptions: () => ({}) } },
  }),
}));
vi.mock('@/components/agents/session-row-actions', () => ({
  copySessionId: async () => {
    await Promise.resolve();
    return true;
  },
  copySessionLink: async (sessionId: string, anchorMessageId: string | null) => {
    await Promise.resolve();
    holder.copiedLinks.push({ sessionId, anchorMessageId });
    return true;
  },
}));
vi.mock('react-i18next', async importOriginal => {
  const actual = await importOriginal<typeof ReactI18next>();
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => i18n.t(key) }),
  };
});
vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  Switch: 'Switch',
  View: 'View',
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));
vi.mock('react-native-svg', () => ({ Circle: 'Circle', default: 'Svg' }));
vi.mock('react-native-reanimated', () => ({}));
vi.mock('expo-haptics', () => ({ selectionAsync: vi.fn() }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    foreground: '#000000',
    hairSoft: '#eeeeee',
    mutedForeground: '#666666',
  }),
}));
vi.mock('@/components/sheet-header', () => ({ SheetHeader: 'SheetHeader' }));
vi.mock('@/components/ui/text', async () => {
  const React = await import('react');
  return { Text: 'Text', TextClassContext: React.createContext<string | undefined>(undefined) };
});
vi.mock('@/components/ui/icons', () => ({ ChevronDown: 'ChevronDown' }));
vi.mock('@/components/ui/directional-icons', () => ({ DirectionalChevronRight: 'ChevronRight' }));
vi.mock('@/components/agents/session-page-sheet', () => ({ SessionPageSheet: 'SessionPageSheet' }));
vi.mock('@/components/agents/session-detail-skeleton', () => ({
  SessionSkeletonMessages: 'SessionSkeletonMessages',
  SessionComposerSkeleton: 'SessionComposerSkeleton',
}));
// The header's own chrome is irrelevant here; render its right cluster as a
// plain View so the pill stays findable inside it.
vi.mock('@/components/screen-header', async () => {
  const React = await import('react');
  return {
    ScreenHeader: ({ headerRight }: { headerRight?: unknown }) =>
      React.createElement('View', null, headerRight as never),
  };
});

function pressByTestID(root: TestRenderer.ReactTestInstance, testID: string): void {
  const target = root.findAll(node => node.props.testID === testID)[0];
  if (!target) {
    throw new Error(`missing testID ${testID}`);
  }
  (target.props.onPress as () => void)();
}

function textValues(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAll(node => node.type === Text)
    .map(node => node.props.children)
    .filter((value): value is string => typeof value === 'string');
}

function mountLoadingScreen(anchorMessageId: string | null): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(
      createElement(SessionDetailLoadingScreen, { sessionId: 'sess-1', anchorMessageId })
    );
  });
  if (!ref.current) {
    throw new Error('loading screen did not render');
  }
  const renderer = ref.current;
  onTestFinished(() => {
    act(() => {
      renderer.unmount();
    });
  });
  return renderer;
}

beforeEach(() => {
  holder.copiedLinks = [];
});

describe('SessionDetailLoadingScreen context sheet', () => {
  it('copies the anchored session link while the session metadata is pending', async () => {
    const renderer = mountLoadingScreen('msg_42');

    // The loading header's pill is pressable, not the inert placeholder.
    const pills = renderer.root.findAll(node => node.props.testID === 'session-context-metrics');
    expect(pills).toHaveLength(1);
    act(() => {
      pressByTestID(renderer.root, 'session-context-metrics');
    });

    // The context sheet opens and its Copy link row copies the route's anchor.
    await act(async () => {
      pressByTestID(renderer.root, 'session-context-sheet-copy-link');
      await Promise.resolve();
    });
    expect(holder.copiedLinks).toEqual([{ sessionId: 'sess-1', anchorMessageId: 'msg_42' }]);
    expect(textValues(renderer)).toContain(i18n.t('agentChat.chatLink.linkCopied'));
  });

  it('copies the session link without a position when the route holds no anchor', async () => {
    const renderer = mountLoadingScreen(null);

    act(() => {
      pressByTestID(renderer.root, 'session-context-metrics');
    });
    await act(async () => {
      pressByTestID(renderer.root, 'session-context-sheet-copy-link');
      await Promise.resolve();
    });
    expect(holder.copiedLinks).toEqual([{ sessionId: 'sess-1', anchorMessageId: null }]);
  });
});
