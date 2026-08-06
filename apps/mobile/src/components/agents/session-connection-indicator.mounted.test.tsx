/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as src/test/render-with-providers.tsx) */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionConnectionIndicator } from './session-connection-indicator';

const connection = vi.hoisted(() => ({ connected: true }));

vi.mock('react-native', () => ({
  View: 'View',
}));
vi.mock('lucide-react-native', () => ({
  WifiOff: 'WifiOff',
}));
vi.mock('@/components/ui/text', () => ({
  Text: 'Text',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#666666' }),
}));
vi.mock('@/lib/hooks/use-user-web-connection-state', () => ({
  useUserWebConnectionState: () => connection.connected,
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
});
