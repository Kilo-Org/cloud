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
}));
vi.mock('react-native', () => ({
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
vi.mock('@/components/screen-header', () => ({
  ScreenHeader: () => null,
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
  useOrganization: () => ({ organizationId: 'org-1', isLoaded: orgLoaded.value }),
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
