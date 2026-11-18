// The setup-recovery card is the fourth Bitbucket connect-sheet entry point.
// The hub row, the repositories card and the PR-review gate each assert a
// double press through their own suite; this one covers the repair card so a
// regression in its guarded push has a failing test before the fix.

import { createElement, type ReactNode } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';

import { BitbucketSetupRecovery } from './bitbucket-setup-recovery';

const calls = vi.hoisted(() => ({
  push: vi.fn<(href: unknown) => void>(),
  refresh: vi.fn<() => void>(),
}));

const ready = vi.hoisted(() => ({ connected: false, integrationId: null as string | null }));

vi.mock('expo-router', () => ({
  useRouter: () => ({ push: calls.push, back: vi.fn() }),
  useFocusEffect: () => undefined,
}));

vi.mock('@/lib/hooks/use-bitbucket', () => ({
  useRefreshBitbucketRepositories: () => ({
    mutateAsync: calls.refresh,
    isPending: false,
  }),
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  useColorScheme: () => 'light',
  View: 'View',
}));

vi.mock('react-native-reanimated', () => ({
  default: { View: 'Animated.View' },
  FadeIn: { duration: (ms: number) => ({ fadeIn: ms }) },
  FadeOut: { duration: vi.fn() },
  LinearTransition: {},
}));

const motion = vi.hoisted(() => ({ reducedMotion: false }));
vi.mock('@/lib/a11y/motion', () => ({
  useMotionPolicy: () => ({
    reducedMotion: motion.reducedMotion,
    scrollAnimated: !motion.reducedMotion,
  }),
  selectReducedMotionEntrance: <T,>(reducedMotion: boolean, entrance: T) =>
    reducedMotion ? undefined : entrance,
}));

vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({
  Text: (props: { children?: ReactNode }) => createElement('TextMock', null, props.children),
}));
vi.mock('@/components/ui/accessible-status', () => ({
  AccessibleStatus: (props: { message?: string }) =>
    createElement('AccessibleStatusMock', null, props.message),
}));

function render(props: Parameters<typeof BitbucketSetupRecovery>[0]) {
  const renderer: { current?: TestRenderer.ReactTestRenderer } = { current: undefined };
  act(() => {
    renderer.current = TestRenderer.create(createElement(BitbucketSetupRecovery, props));
  });
  if (!renderer.current) {
    throw new Error('renderer was not created');
  }
  return renderer.current;
}

function buttons(root: TestRenderer.ReactTestRenderer): TestRenderer.ReactTestInstance[] {
  return root.root.findAll(
    (node: TestRenderer.ReactTestInstance) =>
      // The mocked Button is a string host component; compare by name.
      typeof node.type === 'string' &&
      node.type.toLowerCase().includes('button') &&
      typeof node.props.onPress === 'function'
  );
}

function press(node: TestRenderer.ReactTestInstance) {
  const onPress = node.props.onPress as () => void;
  act(() => {
    onPress();
  });
}

describe('BitbucketSetupRecovery', () => {
  beforeEach(() => {
    calls.push.mockReset();
    calls.refresh.mockReset();
    ready.connected = false;
    ready.integrationId = null;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pushes the connect sheet once for a double press', () => {
    const renderer = render({
      scope: 'org_1',
      readiness: {
        connected: ready.connected,
        ready: false,
        integrationId: ready.integrationId,
        workspace: null,
        missingRequiredScopes: [],
        repositoryCache: { status: 'uninitialized', repositories: [], syncedAt: null },
        canManage: true,
        canTriggerManualReview: false,
      } as unknown as Parameters<typeof BitbucketSetupRecovery>[0]['readiness'],
      message: 'Bitbucket is not connected',
    });

    // `connected: false` with no integration leaves one repair: connect.
    const connect = buttons(renderer);
    expect(connect).toHaveLength(1);
    expect(connect[0]?.findByType('TextMock').props.children).toBe(
      'Connect Bitbucket'
    );

    const target = connect[0];
    if (!target) {
      throw new Error('connect button did not render');
    }
    press(target);
    press(target);

    expect(calls.push).toHaveBeenCalledTimes(1);
    expect(calls.push).toHaveBeenCalledWith({
      pathname: '/(app)/bitbucket-connect',
      params: { scope: 'org_1' },
    });
  });
});
