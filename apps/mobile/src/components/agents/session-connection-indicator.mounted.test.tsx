/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as src/test/render-with-providers.tsx) */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionConnectionIndicator } from './session-connection-indicator';

const connection = vi.hoisted(() => ({
  connected: true,
  exhausted: false,
  retryConnection: vi.fn(),
}));

vi.mock('react-native', () => ({
  View: 'View',
  Pressable: 'Pressable',
}));
vi.mock('@/components/ui/icons', () => ({
  WifiOff: 'WifiOff',
}));
vi.mock('@/components/ui/text', () => ({
  Text: 'Text',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#666666' }),
}));
vi.mock('@/lib/hooks/use-user-web-connection-state', () => ({
  useUserWebConnectionHealth: () => ({
    isConnected: connection.connected,
    reconnectExhausted: connection.exhausted,
  }),
}));
vi.mock('@/components/agents/user-web-connection-provider', () => ({
  useUserWebConnection: () => ({ retryConnection: connection.retryConnection }),
}));

type IndicatorProps = Parameters<typeof SessionConnectionIndicator>[0];

async function mount(props: IndicatorProps): Promise<TestRenderer.ReactTestRenderer> {
  const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
    current: undefined,
  };
  await act(async () => {
    await Promise.resolve();
    rendererRef.current = TestRenderer.create(createElement(SessionConnectionIndicator, props));
  });
  const renderer = rendererRef.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

async function update(
  renderer: TestRenderer.ReactTestRenderer,
  props: IndicatorProps
): Promise<void> {
  await act(() => {
    renderer.update(createElement(SessionConnectionIndicator, props));
  });
}

function findHost(
  root: TestRenderer.ReactTestInstance,
  type: string
): TestRenderer.ReactTestInstance[] {
  return root.findAll(node => node.type === type);
}

describe('SessionConnectionIndicator mounted', () => {
  beforeEach(() => {
    connection.connected = true;
    connection.exhausted = false;
    connection.retryConnection.mockClear();
  });

  it('renders a blank fixed row with no text for default (pending/error) props', async () => {
    const renderer = await mount({});

    const view = findHost(renderer.root, 'View')[0];
    expect(view).toBeDefined();
    if (!view) {
      throw new Error('view not found');
    }
    expect(view.props.className).toContain('h-6');
    expect(view.props.accessibilityElementsHidden).toBe(true);
    expect(view.props.importantForAccessibility).toBe('no-hide-descendants');
    expect(view.props.accessible).toBe(false);
    expect(findHost(renderer.root, 'Text')).toHaveLength(0);
    expect(findHost(renderer.root, 'WifiOff')).toHaveLength(0);
  });

  it('renders a blank fixed row while a remote session transport is up', async () => {
    const renderer = await mount({ activeSessionType: 'remote', agentStatusType: 'idle' });

    const view = findHost(renderer.root, 'View')[0];
    expect(view).toBeDefined();
    if (!view) {
      throw new Error('view not found');
    }
    expect(view.props.className).toContain('h-6');
    expect(view.props.accessibilityElementsHidden).toBe(true);
    expect(findHost(renderer.root, 'Text')).toHaveLength(0);
    expect(findHost(renderer.root, 'WifiOff')).toHaveLength(0);
  });

  it('reads Connecting for a remote session that starts down', async () => {
    connection.connected = false;
    const renderer = await mount({ activeSessionType: 'remote', agentStatusType: 'idle' });

    const view = findHost(renderer.root, 'View')[0];
    expect(view).toBeDefined();
    if (!view) {
      throw new Error('view not found');
    }
    expect(view.props.className).toContain('h-6');
    expect(view.props.accessibilityElementsHidden).toBe(false);
    expect(view.props.importantForAccessibility).toBe('auto');
    expect(view.props.accessible).toBe(true);
    expect(view.props.accessibilityLabel).toBe('Connecting…');
    expect(findHost(renderer.root, 'WifiOff')).toHaveLength(1);
    const texts = findHost(renderer.root, 'Text');
    expect(texts.some(node => node.props.children === 'Connecting…')).toBe(true);
  });

  it('reads Reconnecting after a drop from a committed up state', async () => {
    const renderer = await mount({ activeSessionType: 'remote', agentStatusType: 'idle' });
    expect(findHost(renderer.root, 'Text')).toHaveLength(0);

    connection.connected = false;
    await update(renderer, { activeSessionType: 'remote', agentStatusType: 'idle' });

    const view = findHost(renderer.root, 'View')[0];
    expect(view).toBeDefined();
    if (!view) {
      throw new Error('view not found');
    }
    expect(view.props.accessibilityElementsHidden).toBe(false);
    expect(view.props.accessibilityLabel).toBe('Reconnecting…');
    expect(findHost(renderer.root, 'WifiOff')).toHaveLength(1);
    const texts = findHost(renderer.root, 'Text');
    expect(texts.some(node => node.props.children === 'Reconnecting…')).toBe(true);
  });

  it('renders a blank fixed row for a read-only session even while disconnected', async () => {
    connection.connected = false;
    const renderer = await mount({
      activeSessionType: 'read-only',
      agentStatusType: 'disconnected',
    });

    const view = findHost(renderer.root, 'View')[0];
    expect(view).toBeDefined();
    if (!view) {
      throw new Error('view not found');
    }
    expect(view.props.className).toContain('h-6');
    expect(view.props.accessibilityElementsHidden).toBe(true);
    expect(findHost(renderer.root, 'Text')).toHaveLength(0);
    expect(findHost(renderer.root, 'WifiOff')).toHaveLength(0);
  });

  it('renders Connection lost with a Retry action when reconnects are exhausted', async () => {
    connection.connected = false;
    connection.exhausted = true;
    const renderer = await mount({ activeSessionType: 'remote', agentStatusType: 'idle' });

    const view = findHost(renderer.root, 'View')[0];
    expect(view).toBeDefined();
    if (!view) {
      throw new Error('view not found');
    }
    expect(view.props.accessibilityElementsHidden).toBe(false);
    expect(findHost(renderer.root, 'WifiOff')).toHaveLength(1);
    const texts = findHost(renderer.root, 'Text');
    expect(texts.some(node => node.props.children === 'Connection lost')).toBe(true);
    expect(texts.some(node => node.props.children === 'Retry')).toBe(true);
    expect(findHost(renderer.root, 'Pressable')).toHaveLength(1);
  });

  it('calls retryConnection when the Retry action is pressed', async () => {
    connection.connected = false;
    connection.exhausted = true;
    const renderer = await mount({ activeSessionType: 'remote', agentStatusType: 'idle' });

    const pressables = findHost(renderer.root, 'Pressable');
    expect(pressables).toHaveLength(1);
    const pressable = pressables[0];
    expect(pressable).toBeDefined();
    if (!pressable) {
      throw new Error('pressable not found');
    }

    await act(async () => {
      await Promise.resolve();
      (pressable.props.onPress as () => void)();
    });

    expect(connection.retryConnection).toHaveBeenCalledTimes(1);
  });

  it('clears the label when the exhaustion edge flips false and the transport recovers', async () => {
    connection.connected = false;
    connection.exhausted = true;
    const renderer = await mount({ activeSessionType: 'remote', agentStatusType: 'idle' });
    expect(
      findHost(renderer.root, 'Text').some(node => node.props.children === 'Connection lost')
    ).toBe(true);

    connection.exhausted = false;
    connection.connected = true;
    await update(renderer, { activeSessionType: 'remote', agentStatusType: 'idle' });

    expect(findHost(renderer.root, 'Text')).toHaveLength(0);
    expect(findHost(renderer.root, 'WifiOff')).toHaveLength(0);
    expect(findHost(renderer.root, 'Pressable')).toHaveLength(0);
  });
});
