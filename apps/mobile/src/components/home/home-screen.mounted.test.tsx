/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as src/test/render-with-providers.tsx) */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { HomeScreen } from '@/components/home/home-screen';

const activeIsError = vi.hoisted(() => ({ value: false }));
const storedIsError = vi.hoisted(() => ({ value: false }));
const sessionsLoading = vi.hoisted(() => ({ value: false }));
const orgLoaded = vi.hoisted(() => ({ value: true }));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useQuery: () => ({ data: [{ organizationId: 'org-1', organizationName: 'Home organization' }] }),
}));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({ organizations: { list: { queryOptions: () => ({}) } } }),
}));
vi.mock('@/lib/auth/auth-context', () => ({ useAuth: () => ({ token: 'token' }) }));
vi.mock('@expo/react-native-action-sheet', () => ({
  useActionSheet: () => ({ showActionSheetWithOptions: vi.fn() }),
}));
vi.mock('expo-router', () => ({ useRouter: () => ({ canGoBack: () => false }) }));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons', () => ({ ChevronDown: 'ChevronDown' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({ useThemeColors: () => ({}) }));
vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  I18nManager: { isRTL: false },
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  RefreshControl: 'RefreshControl',
  ScrollView: 'ScrollView',
  View: 'View',
}));
vi.mock('react-native-reanimated', () => ({
  default: { View: 'Animated.View' },
  FadeIn: { duration: vi.fn() },
  FadeOut: { duration: vi.fn() },
  LinearTransition: {},
}));
vi.mock('@/components/home/agent-sessions-section', () => ({
  AgentSessionsSection: 'AgentSessionsSection',
  HOME_LIVE_SLOT_MIN_CLASS: 'min-h-[72px]',
}));
vi.mock('@/components/home/greeting', () => ({
  buildTimedGreeting: () => 'Good morning',
}));
vi.mock('@/components/home/new-task-button', () => ({
  NewTaskButton: 'NewTaskButton',
}));
vi.mock('@/components/home/product-choices', () => ({
  ProductChoices: 'ProductChoices',
}));
vi.mock('@/components/query-error', () => ({
  QueryError: 'QueryError',
}));
vi.mock('@/components/tab-screen', () => ({
  TabScreenScrollView: 'ScrollView',
}));
vi.mock('@/components/ui/skeleton', () => ({
  Skeleton: 'Skeleton',
}));
vi.mock('@/lib/hooks/use-agent-sessions', () => ({
  useAgentSessions: () => ({
    activeSessions: [],
    isLoading: sessionsLoading.value,
    storedSessions: [{}],
    storedIsError: storedIsError.value,
    storedIsSuccess: true,
    activeIsError: activeIsError.value,
    refetch: vi.fn(),
  }),
}));
vi.mock('@/lib/organization-context', () => ({
  useOrganization: () => ({
    organizationId: 'org-1',
    isLoaded: orgLoaded.value,
    error: null,
    retry: vi.fn(),
    setOrganizationId: vi.fn(),
  }),
}));

function nodeCount(root: TestRenderer.ReactTestInstance, type: string): number {
  return root.findAll(node => typeof node.type === 'string' && (node.type as string) === type)
    .length;
}

function findNode(
  root: TestRenderer.ReactTestInstance,
  type: string
): TestRenderer.ReactTestInstance | undefined {
  return root.findAll(node => typeof node.type === 'string' && (node.type as string) === type)[0];
}

async function mountHome(): Promise<TestRenderer.ReactTestRenderer> {
  const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
    current: undefined,
  };
  await act(async () => {
    await Promise.resolve();
    rendererRef.current = TestRenderer.create(createElement(HomeScreen));
  });
  const renderer = rendererRef.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

describe('HomeScreen composition', () => {
  it.each([false, true])('keeps an accessible context control with readiness=%s', async loaded => {
    orgLoaded.value = loaded;
    sessionsLoading.value = false;
    storedIsError.value = false;
    activeIsError.value = false;
    const renderer = await mountHome();
    const control = renderer.root.find(
      node =>
        (node.type as string) === 'Pressable' && node.props.accessibilityHint === 'Select account'
    );
    expect(control.props.accessibilityRole).toBe('button');
    expect(control.props.accessibilityState).toEqual({ busy: !loaded, disabled: !loaded });
    expect(control.props.accessibilityLabel).toBe(loaded ? 'Home organization' : 'Select account');
    expect(
      renderer.root.findAll(node => (node.type as string) === 'Text').flatMap(node => node.children)
    ).not.toContain('Personal');
    act(() => {
      renderer.unmount();
    });
  });

  it('renders the sessions section and new-task button on an empty load', async () => {
    storedIsError.value = false;
    activeIsError.value = false;
    sessionsLoading.value = false;
    orgLoaded.value = true;
    const renderer = await mountHome();
    expect(nodeCount(renderer.root, 'AgentSessionsSection')).toBe(1);
    expect(nodeCount(renderer.root, 'NewTaskButton')).toBe(1);
    expect(nodeCount(renderer.root, 'ProductChoices')).toBe(1);
    expect(nodeCount(renderer.root, 'AgentsPromoCard')).toBe(0);
    expect(nodeCount(renderer.root, 'Skeleton')).toBe(0);

    await act(async () => {
      await Promise.resolve();
      renderer.unmount();
    });
  });

  it('renders the sessions section and new-task button when sessions are present', async () => {
    storedIsError.value = false;
    activeIsError.value = false;
    sessionsLoading.value = false;
    orgLoaded.value = true;
    const renderer = await mountHome();
    expect(nodeCount(renderer.root, 'AgentSessionsSection')).toBe(1);
    expect(nodeCount(renderer.root, 'NewTaskButton')).toBe(1);
    expect(nodeCount(renderer.root, 'ProductChoices')).toBe(1);
    expect(nodeCount(renderer.root, 'Skeleton')).toBe(0);

    await act(async () => {
      await Promise.resolve();
      renderer.unmount();
    });
  });

  it('shows the active-sessions error, not the section, on active error', async () => {
    storedIsError.value = false;
    activeIsError.value = true;
    sessionsLoading.value = false;
    orgLoaded.value = true;
    const renderer = await mountHome();
    expect(
      renderer.root.findAll(node => (node.type as string) === 'Text').flatMap(node => node.children)
    ).toContain('Home organization');
    const queryError = findNode(renderer.root, 'QueryError');
    expect(queryError).toBeDefined();
    expect(queryError?.props.title).toBe("Couldn't load active sessions");
    expect(typeof queryError?.props.onRetry).toBe('function');
    expect(nodeCount(renderer.root, 'AgentSessionsSection')).toBe(0);
    expect(nodeCount(renderer.root, 'NewTaskButton')).toBe(1);
    expect(nodeCount(renderer.root, 'ProductChoices')).toBe(1);

    await act(async () => {
      await Promise.resolve();
      renderer.unmount();
    });
  });

  it('shows the stored-sessions error, not the section, on stored error', async () => {
    storedIsError.value = true;
    activeIsError.value = false;
    sessionsLoading.value = false;
    orgLoaded.value = true;
    const renderer = await mountHome();
    expect(
      renderer.root.findAll(node => (node.type as string) === 'Text').flatMap(node => node.children)
    ).toContain('Home organization');
    const queryError = findNode(renderer.root, 'QueryError');
    expect(queryError).toBeDefined();
    expect(queryError?.props.title).toBe("Couldn't load sessions");
    expect(typeof queryError?.props.onRetry).toBe('function');
    expect(nodeCount(renderer.root, 'AgentSessionsSection')).toBe(0);
    expect(nodeCount(renderer.root, 'NewTaskButton')).toBe(1);
    expect(nodeCount(renderer.root, 'ProductChoices')).toBe(1);

    await act(async () => {
      await Promise.resolve();
      renderer.unmount();
    });
  });

  it('does not render product choices while loading', async () => {
    sessionsLoading.value = true;
    orgLoaded.value = true;
    const renderer = await mountHome();
    expect(nodeCount(renderer.root, 'ProductChoices')).toBe(0);
    expect(nodeCount(renderer.root, 'Skeleton')).toBeGreaterThan(0);
    sessionsLoading.value = false;

    await act(async () => {
      await Promise.resolve();
      renderer.unmount();
    });
  });
});
