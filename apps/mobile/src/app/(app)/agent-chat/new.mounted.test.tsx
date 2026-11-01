import { createElement, type ElementType, type ReactNode } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import NewSessionScreen, {
  ErrorBoundary as NewSessionErrorBoundary,
} from '@/app/(app)/agent-chat/new';

const state = vi.hoisted(() => ({
  organization: {
    organizationId: undefined as string | undefined,
    isResolved: true,
    usesActiveAccount: true,
  },
  context: { error: null as 'restore' | 'save' | null, retry: vi.fn() },
  router: {
    canGoBack: vi.fn(() => true),
    back: vi.fn(),
    replace: vi.fn(),
  },
}));
vi.mock('expo-router', () => ({ useRouter: () => state.router }));
vi.mock('@sentry/react-native', () => ({
  wrapExpoRouterErrorBoundary: (boundary: unknown) => boundary,
}));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
}));
vi.mock('@/components/agents/use-new-session-organization', () => ({
  useNewSessionOrganization: () => ({ isCloneEntry: false, ...state.organization }),
}));
vi.mock('@/lib/organization-context', () => ({
  useOrganization: () => state.context,
}));
vi.mock('@/components/agents/new-session-screen-body', () => ({
  NewSessionScreenBody: 'Body',
}));
vi.mock('@/components/agents/new-session-model-provider', () => ({
  NewSessionModelProvider: (props: { organizationId?: string; children?: ReactNode }) =>
    createElement('ModelProvider', { organizationId: props.organizationId }, props.children),
}));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('react-native', () => ({ Pressable: 'Pressable', View: 'View' }));

const ModelProvider = 'ModelProvider' as ElementType;
const Body = 'Body' as ElementType;
const Loading = 'ActivityIndicator' as ElementType;
const Retry = 'Pressable' as ElementType;

async function render() {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    ref.current = TestRenderer.create(createElement(NewSessionScreen));
    await Promise.resolve();
  });
  if (!ref.current) {
    throw new Error('renderer did not mount');
  }
  return ref.current;
}

function unmount(renderer: TestRenderer.ReactTestRenderer) {
  act(() => {
    renderer.unmount();
  });
}

beforeEach(() => {
  state.organization = { organizationId: undefined, isResolved: true, usesActiveAccount: true };
  state.context = { error: null, retry: vi.fn() };
  state.router.canGoBack.mockReset().mockReturnValue(true);
  state.router.back.mockReset();
  state.router.replace.mockReset();
});

describe('NewSessionScreen account gate', () => {
  it('mounts nothing account-scoped until the account resolves', async () => {
    state.organization = { organizationId: undefined, isResolved: false, usesActiveAccount: true };
    const renderer = await render();
    // A form mounted here would read as Personal until the account settles,
    // and its model selection would stay on that first list.
    expect(renderer.root.findAllByType(ModelProvider)).toHaveLength(0);
    expect(renderer.root.findAllByType(Loading)).toHaveLength(1);
    expect(renderer.root.findAllByType(Retry)).toHaveLength(0);
    unmount(renderer);
  });

  it('surfaces a failed account restore with a retry', async () => {
    state.organization = { organizationId: undefined, isResolved: false, usesActiveAccount: true };
    state.context = { error: 'restore', retry: vi.fn() };
    const renderer = await render();
    expect(renderer.root.findAllByType(ModelProvider)).toHaveLength(0);
    const retry = renderer.root.findByType(Retry);
    expect(retry.props.accessibilityLabel).toBe('Retry');
    const press = retry.props.onPress as () => void;
    act(() => {
      press();
    });
    expect(state.context.retry).toHaveBeenCalledTimes(1);
    unmount(renderer);
  });

  it('keeps the form gated when the account list fails and the active account decides', async () => {
    // The context falls back to Personal for the whole app; that fallback is
    // not a choice, so the create must not run on it.
    state.organization = {
      organizationId: undefined,
      isResolved: true,
      usesActiveAccount: true,
    };
    state.context = { error: 'restore', retry: vi.fn() };
    const renderer = await render();
    expect(renderer.root.findAllByType(ModelProvider)).toHaveLength(0);
    expect(renderer.root.findAllByType(Retry)).toHaveLength(1);
    unmount(renderer);
  });

  it('mounts a route-scoped form when only the account list failed', async () => {
    state.organization = {
      organizationId: 'org-a',
      isResolved: true,
      usesActiveAccount: false,
    };
    state.context = { error: 'restore', retry: vi.fn() };
    const renderer = await render();
    expect(renderer.root.findByType(ModelProvider).props.organizationId).toBe('org-a');
    unmount(renderer);
  });

  it('mounts the form with the resolved organization', async () => {
    state.organization = { organizationId: 'org-a', isResolved: true, usesActiveAccount: true };
    const renderer = await render();
    expect(renderer.root.findByType(ModelProvider).props.organizationId).toBe('org-a');
    expect(renderer.root.findAllByType(Body)).toHaveLength(1);
    unmount(renderer);
  });

  it('mounts a personal form with no organization', async () => {
    const renderer = await render();
    expect(renderer.root.findByType(ModelProvider).props.organizationId).toBeUndefined();
    unmount(renderer);
  });
});

const AGENTS_SESSIONS_HREF = '/(app)/(tabs)/(2_agents)/';

async function renderErrorBoundary(): Promise<TestRenderer.ReactTestRenderer> {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    ref.current = TestRenderer.create(
      createElement(NewSessionErrorBoundary, {
        error: new Error('composer render failed'),
        retry: vi.fn(),
      })
    );
    await Promise.resolve();
  });
  if (!ref.current) {
    throw new Error('renderer did not mount');
  }
  return ref.current;
}

/**
 * The Back control is the route failure screen's last Pressable: the QueryError
 * above it owns its own Retry.
 */
function pressBack(renderer: TestRenderer.ReactTestRenderer): void {
  const back = renderer.root.findAllByType(Retry).at(-1);
  if (!back) {
    throw new Error('back control did not render');
  }
  expect(back.props.accessibilityLabel).toBe('Back');
  const press = back.props.onPress as () => void;
  act(() => {
    press();
  });
}

describe('NewSessionScreen route error boundary', () => {
  it('keeps a Back out of the screen and re-runs the prefill on Retry', async () => {
    const retry = vi.fn();
    const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
    await act(async () => {
      ref.current = TestRenderer.create(
        createElement(NewSessionErrorBoundary, {
          error: new Error('composer render failed'),
          retry,
        })
      );
      await Promise.resolve();
    });
    const renderer = ref.current;
    if (!renderer) {
      throw new Error('renderer did not mount');
    }

    const error = renderer.root.findByType('QueryError' as never);
    const retryFromBoundary = error.props.onRetry as () => void;
    expect(typeof retryFromBoundary).toBe('function');
    act(() => {
      retryFromBoundary();
    });
    expect(retry).toHaveBeenCalledTimes(1);

    pressBack(renderer);
    expect(state.router.back).toHaveBeenCalledTimes(1);
    expect(state.router.replace).not.toHaveBeenCalled();
    unmount(renderer);
  });

  it('leaves for the sessions list when the route has no history', async () => {
    state.router.canGoBack.mockReturnValue(false);
    const renderer = await renderErrorBoundary();
    pressBack(renderer);
    expect(state.router.back).not.toHaveBeenCalled();
    expect(state.router.replace).toHaveBeenCalledExactlyOnceWith(AGENTS_SESSIONS_HREF);
    unmount(renderer);
  });
});
