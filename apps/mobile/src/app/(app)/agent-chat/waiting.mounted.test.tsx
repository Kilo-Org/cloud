import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { type ActiveSession } from '@/lib/hooks/use-agent-sessions';
import { __resetSessionAttentionForTests, ackSessionAttention } from '@/lib/session-attention';
import WaitingAgentScreen from './waiting';

const replace = vi.hoisted(() => vi.fn());
const organization = vi.hoisted(() => ({
  organizationId: null as string | null,
  isLoaded: true,
}));
const live = vi.hoisted(() => ({
  activeSessions: [] as ActiveSession[],
  isError: false,
  hasAcceptedSuccess: true,
  isFetching: false,
  terminalError: null as { error: unknown; kind: 'retryable' | 'non-retryable' } | null,
  refetch: vi.fn(),
}));

// `useStackSafeReplace` owns the push + post-transition cleanup that keeps the
// Android native stack alive (KILO-APP-25); its own mechanics are covered in
// src/lib/navigation/stack-safe-replace.mounted.test.tsx. Here it stands in
// for the navigation call so these assertions stay about the destination href.
vi.mock('@/lib/navigation/stack-safe-replace', () => ({
  useStackSafeReplace: () => ({ replace }),
}));
vi.mock('@/lib/organization-context', () => ({ useOrganization: () => organization }));
vi.mock('@/lib/hooks/use-agent-sessions', () => ({ useLiveAgentSessions: () => live }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#000000', mutedForeground: '#666666' }),
}));
vi.mock('@/lib/a11y/announce', () => ({ announceForA11y: vi.fn() }));
vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  View: 'View',
  ActivityIndicator: 'ActivityIndicator',
}));
// The real CenteredState measures a native state surface; its frame contract
// belongs to centered-state-layout.test.ts. Here the element itself is the
// assertion target: every state must render inside it.
vi.mock('@/components/centered-state', () => ({ CenteredState: 'CenteredState' }));
vi.mock('@/components/ui/text', async () => {
  const { createContext } = await import('react');
  return { Text: 'Text', TextClassContext: createContext<string | undefined>(undefined) };
});
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/components/ui/icons', () => ({
  AlertCircle: 'AlertCircle',
  Bot: 'Bot',
  Lock: 'Lock',
  Plus: 'Plus',
  SearchX: 'SearchX',
  ServerCrash: 'ServerCrash',
  WifiOff: 'WifiOff',
}));

function session(over: Partial<ActiveSession> & Pick<ActiveSession, 'id'>): ActiveSession {
  return {
    status: 'question',
    title: 'test',
    connectionId: 'c1',
    ...over,
  };
}

function texts(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAllByType('Text' as never)
    .flatMap(node => node.children)
    .filter((child): child is string => typeof child === 'string');
}

function byType(
  renderer: TestRenderer.ReactTestRenderer,
  type: string
): TestRenderer.ReactTestInstance[] {
  return renderer.root.findAll(
    node => typeof node.type === 'string' && (node.type as string) === type
  );
}

function control(
  renderer: TestRenderer.ReactTestRenderer,
  accessibilityLabel: string
): TestRenderer.ReactTestInstance | undefined {
  return byType(renderer, 'Button').find(
    node => node.props.accessibilityLabel === accessibilityLabel
  );
}

function press(node: TestRenderer.ReactTestInstance | undefined) {
  if (!node) {
    throw new Error('control is missing');
  }
  act(() => {
    (node.props.onPress as (() => void) | undefined)?.();
  });
}

/** The outermost rendered host element — the frame every state must share. */
function rootType(renderer: TestRenderer.ReactTestRenderer): string | undefined {
  const json = renderer.toJSON();
  if (json === null) {
    return undefined;
  }
  const node = Array.isArray(json) ? json[0] : json;
  return node?.type;
}

async function mount(): Promise<TestRenderer.ReactTestRenderer> {
  const ref: { current: TestRenderer.ReactTestRenderer | null } = { current: null };
  await act(async () => {
    ref.current = TestRenderer.create(createElement(WaitingAgentScreen));
    await Promise.resolve();
  });
  const created = ref.current;
  if (created === null) {
    throw new Error('the waiting-agent route did not render');
  }
  return created;
}

async function update(renderer: TestRenderer.ReactTestRenderer) {
  await act(async () => {
    renderer.update(createElement(WaitingAgentScreen));
    await Promise.resolve();
  });
}

let mounted: TestRenderer.ReactTestRenderer | null = null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  __resetSessionAttentionForTests();
  replace.mockClear();
  organization.organizationId = null;
  organization.isLoaded = true;
  live.activeSessions = [];
  live.isError = false;
  live.hasAcceptedSuccess = true;
  live.isFetching = false;
  live.terminalError = null;
  live.refetch.mockClear();
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe('WaitingAgentScreen', () => {
  it('renders the reserved frame while the sessions are unconfirmed, without empty or error copy', async () => {
    live.hasAcceptedSuccess = false;
    const renderer = await mount();
    mounted = renderer;

    expect(byType(renderer, 'CenteredState')).toHaveLength(1);
    expect(byType(renderer, 'ActivityIndicator')).toHaveLength(1);
    expect(texts(renderer)).not.toContain(i18n.t('home.noLiveSessions'));
    expect(texts(renderer)).not.toContain(i18n.t('home.couldNotLoadActiveSessions'));
    expect(replace).not.toHaveBeenCalled();
  });

  it('waits for the organization before resolving the waiting agent', async () => {
    organization.isLoaded = false;
    live.activeSessions = [session({ id: 'waiting-1' })];
    const renderer = await mount();
    mounted = renderer;

    expect(byType(renderer, 'CenteredState')).toHaveLength(1);
    expect(replace).not.toHaveBeenCalled();
  });

  it('re-reads the ack store when the ack hydrates before the organization resolves', async () => {
    // The persisted ack store hydrates asynchronously at module init, so the
    // first render can resolve a raise the user already answered. The selection
    // must be recomputed on the ack-store revision, or the redirect happens
    // once the organization resolves and reopens the answered raise.
    organization.isLoaded = false;
    live.activeSessions = [session({ id: 'acked-1' })];
    const renderer = await mount();
    mounted = renderer;
    expect(replace).not.toHaveBeenCalled();

    act(() => {
      ackSessionAttention('acked-1');
    });
    organization.isLoaded = true;
    await update(renderer);

    expect(replace).not.toHaveBeenCalled();
    expect(texts(renderer)).toContain(i18n.t('home.noLiveSessions'));
  });

  it('re-reads the ack store when an ack lands while the route is mounted on an error', async () => {
    // Same window with the error gate: the effect is held back while the query
    // is failing, an ack lands, then the retry settles and the stale selection
    // must not reopen the answered raise.
    live.hasAcceptedSuccess = false;
    live.isError = true;
    live.terminalError = { kind: 'retryable', error: new Error('boom') };
    live.activeSessions = [session({ id: 'acked-2' })];
    const renderer = await mount();
    mounted = renderer;
    expect(replace).not.toHaveBeenCalled();

    act(() => {
      ackSessionAttention('acked-2');
    });
    live.isError = false;
    live.hasAcceptedSuccess = true;
    live.terminalError = null;
    await update(renderer);

    expect(replace).not.toHaveBeenCalled();
    expect(texts(renderer)).toContain(i18n.t('home.noLiveSessions'));
  });

  it('replaces the route with the waiting agent session on the happy path', async () => {
    live.activeSessions = [session({ id: 'waiting-1' })];
    const renderer = await mount();
    mounted = renderer;

    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith('/(app)/agent-chat/waiting-1');
  });

  it('preserves the organization context in the session href', async () => {
    organization.organizationId = 'org-a';
    live.activeSessions = [session({ id: 'waiting-1' })];
    const renderer = await mount();
    mounted = renderer;

    expect(replace).toHaveBeenCalledWith('/(app)/agent-chat/waiting-1?organizationId=org-a');
  });

  it('shows the empty state with a composer call to action when no agent is waiting', async () => {
    live.activeSessions = [session({ id: 'busy', status: 'busy' })];
    const renderer = await mount();
    mounted = renderer;

    expect(texts(renderer)).toContain(i18n.t('home.noLiveSessions'));
    expect(replace).not.toHaveBeenCalled();

    press(control(renderer, i18n.t('home.newCodingTask')));
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith('/(app)/agent-chat/new');
  });

  it('shows the retryable error copy and retries the query', async () => {
    live.hasAcceptedSuccess = false;
    live.isError = true;
    live.isFetching = true;
    live.terminalError = { kind: 'retryable', error: new Error('boom') };
    const renderer = await mount();
    mounted = renderer;

    expect(texts(renderer)).toContain(i18n.t('home.couldNotLoadActiveSessions'));
    expect(texts(renderer)).toContain(i18n.t('common.retry'));
    expect(replace).not.toHaveBeenCalled();

    const retry = control(renderer, i18n.t('common.retry'));
    expect(retry?.props.loading).toBe(true);
    press(retry);
    expect(live.refetch).toHaveBeenCalledTimes(1);
  });

  it('denies a terminal failure with no Retry and a profile escape', async () => {
    live.hasAcceptedSuccess = false;
    live.isError = true;
    live.terminalError = { kind: 'non-retryable', error: { data: { code: 'FORBIDDEN' } } };
    const renderer = await mount();
    mounted = renderer;

    expect(texts(renderer)).toContain(i18n.t('common.accessDenied'));
    // The retryable copy and its Retry are gone: the only offered action is the
    // way out, not an action that can never succeed.
    expect(texts(renderer)).not.toContain(i18n.t('home.couldNotLoadActiveSessions'));
    expect(control(renderer, i18n.t('common.retry'))).toBeUndefined();
    expect(replace).not.toHaveBeenCalled();

    press(control(renderer, i18n.t('organization.boundary.backToProfile')));
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith('/(app)/(tabs)/(3_profile)');
  });

  it('maps a terminal NOT_FOUND to the not-found variant', async () => {
    live.hasAcceptedSuccess = false;
    live.isError = true;
    live.terminalError = { kind: 'non-retryable', error: { data: { code: 'NOT_FOUND' } } };
    const renderer = await mount();
    mounted = renderer;

    expect(texts(renderer)).toContain(i18n.t('common.notFound'));
    expect(control(renderer, i18n.t('common.retry'))).toBeUndefined();
    expect(control(renderer, i18n.t('organization.boundary.backToProfile'))).toBeDefined();
  });

  it('keeps the terminal state inside the same frame as loading', async () => {
    live.hasAcceptedSuccess = false;
    live.isError = true;
    live.terminalError = { kind: 'non-retryable', error: { data: { code: 'BAD_REQUEST' } } };
    const renderer = await mount();
    mounted = renderer;

    expect(rootType(renderer)).toBe('CenteredState');
    expect(byType(renderer, 'CenteredState')).toHaveLength(1);
    expect(texts(renderer)).toContain(i18n.t('home.couldNotLoadSessions'));
  });

  it('performs the happy replace once the retried query succeeds', async () => {
    live.hasAcceptedSuccess = false;
    live.isError = true;
    live.terminalError = { kind: 'retryable', error: new Error('boom') };
    const renderer = await mount();
    mounted = renderer;

    press(control(renderer, i18n.t('common.retry')));
    expect(live.refetch).toHaveBeenCalledTimes(1);

    live.isError = false;
    live.hasAcceptedSuccess = true;
    live.terminalError = null;
    live.activeSessions = [session({ id: 'waiting-1' })];
    await update(renderer);

    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith('/(app)/agent-chat/waiting-1');
  });

  it('redirects once per waiting agent, even when the route re-renders', async () => {
    live.activeSessions = [session({ id: 'waiting-1' })];
    const renderer = await mount();
    mounted = renderer;

    expect(replace).toHaveBeenCalledTimes(1);

    // Re-renders before the native transition removes this route (the mocked
    // hook returns a fresh object each render) must not push the session again.
    await update(renderer);
    await update(renderer);
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it('keeps loading and error inside the same frame, so nothing jumps when it settles', async () => {
    live.hasAcceptedSuccess = false;
    const renderer = await mount();
    mounted = renderer;

    const loadingFrame = rootType(renderer);
    expect(loadingFrame).toBe('CenteredState');
    expect(byType(renderer, 'CenteredState')).toHaveLength(1);

    live.isError = true;
    await update(renderer);

    expect(rootType(renderer)).toBe(loadingFrame);
    expect(byType(renderer, 'CenteredState')).toHaveLength(1);
  });
});
