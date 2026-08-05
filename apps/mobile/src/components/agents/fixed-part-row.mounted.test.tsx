/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as src/test/render-with-providers.tsx) */
import { Eye } from 'lucide-react-native';
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { FixedPartRow } from './fixed-part-row';

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Pressable: 'Pressable',
  View: 'View',
}));
vi.mock('lucide-react-native', () => ({
  ChevronRight: 'ChevronRight',
  XCircle: 'XCircle',
  Eye: 'Eye',
}));
vi.mock('@/components/ui/eyebrow', () => ({
  Eyebrow: 'Eyebrow',
}));
vi.mock('@/components/ui/text', () => ({
  Text: 'Text',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#999999', destructive: '#BE4E3F' }),
}));

type RowProps = Parameters<typeof FixedPartRow>[0];

async function renderRow(props: RowProps): Promise<TestRenderer.ReactTestRenderer> {
  const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
    current: undefined,
  };
  await act(async () => {
    await Promise.resolve();
    rendererRef.current = TestRenderer.create(createElement(FixedPartRow, props));
  });
  const renderer = rendererRef.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

function findHost(
  root: TestRenderer.ReactTestInstance,
  type: string
): TestRenderer.ReactTestInstance[] {
  return root.findAll(node => node.type === type);
}

describe('FixedPartRow mounted', () => {
  it('renders a pressable row with a details hint and chevron when onPress is set', async () => {
    const onPress = vi.fn(() => undefined);
    const renderer = await renderRow({
      icon: Eye,
      label: 'app.ts',
      status: 'completed',
      onPress,
      accessibilityLabel: 'app.ts tool, completed',
    });

    const pressable = findHost(renderer.root, 'Pressable')[0];
    expect(pressable).toBeDefined();
    if (!pressable) {
      throw new Error('pressable not found');
    }
    expect(pressable.props.accessibilityLabel).toBe('app.ts tool, completed');
    expect(pressable.props.accessibilityHint).toBe('Show details');
    expect(pressable.props.accessibilityState).toEqual({ disabled: false });
    expect(pressable.props.disabled).toBe(false);
    expect(pressable.props.onPress).toBe(onPress);
    expect(findHost(renderer.root, 'ChevronRight')).toHaveLength(1);
  });

  it('renders a disabled row with no hint and no chevron without onPress', async () => {
    const renderer = await renderRow({
      icon: Eye,
      label: 'app.ts',
      status: 'completed',
      accessibilityLabel: 'app.ts tool, completed',
    });

    const pressable = findHost(renderer.root, 'Pressable')[0];
    expect(pressable).toBeDefined();
    if (!pressable) {
      throw new Error('pressable not found');
    }
    expect(pressable.props.accessibilityHint).toBeUndefined();
    expect(pressable.props.accessibilityState).toEqual({ disabled: true });
    expect(pressable.props.disabled).toBe(true);
    expect(pressable.props.onPress).toBeUndefined();
    expect(findHost(renderer.root, 'ChevronRight')).toHaveLength(0);
  });

  it('renders the destructive icon for the error status', async () => {
    const renderer = await renderRow({
      icon: Eye,
      label: 'bash',
      status: 'error',
      accessibilityLabel: 'bash tool, error',
    });

    expect(findHost(renderer.root, 'XCircle')).toHaveLength(1);
    expect(findHost(renderer.root, 'ActivityIndicator')).toHaveLength(0);
    expect(findHost(renderer.root, 'Eye')).toHaveLength(0);
  });

  it('renders an activity indicator for the running status', async () => {
    const renderer = await renderRow({
      icon: Eye,
      label: 'bash',
      status: 'running',
      accessibilityLabel: 'bash tool, running',
    });

    expect(findHost(renderer.root, 'ActivityIndicator')).toHaveLength(1);
    expect(findHost(renderer.root, 'XCircle')).toHaveLength(0);
    expect(findHost(renderer.root, 'Eye')).toHaveLength(0);
  });

  it('renders an activity indicator for the pending status', async () => {
    const renderer = await renderRow({
      icon: Eye,
      label: 'bash',
      status: 'pending',
      accessibilityLabel: 'bash tool, pending',
    });

    expect(findHost(renderer.root, 'ActivityIndicator')).toHaveLength(1);
  });

  it('renders the completed icon when status is completed and an icon is provided', async () => {
    const renderer = await renderRow({
      icon: Eye,
      label: 'app.ts',
      status: 'completed',
      accessibilityLabel: 'app.ts tool, completed',
    });

    expect(findHost(renderer.root, 'Eye')).toHaveLength(1);
    expect(findHost(renderer.root, 'ActivityIndicator')).toHaveLength(0);
    expect(findHost(renderer.root, 'XCircle')).toHaveLength(0);
  });

  it('renders no leading element when completed without an icon', async () => {
    const renderer = await renderRow({
      label: 'app.ts',
      status: 'completed',
      accessibilityLabel: 'app.ts tool, completed',
    });

    expect(findHost(renderer.root, 'Eye')).toHaveLength(0);
    expect(findHost(renderer.root, 'XCircle')).toHaveLength(0);
    expect(findHost(renderer.root, 'ActivityIndicator')).toHaveLength(0);
    const labels = findHost(renderer.root, 'Text');
    expect(labels.some(node => node.props.children === 'app.ts')).toBe(true);
  });

  it('renders no leading slot at all when status is absent (reasoning rows)', async () => {
    const renderer = await renderRow({
      label: 'Thought',
      accessibilityLabel: 'Thought',
    });

    expect(findHost(renderer.root, 'ActivityIndicator')).toHaveLength(0);
    expect(findHost(renderer.root, 'XCircle')).toHaveLength(0);
    expect(findHost(renderer.root, 'Eye')).toHaveLength(0);
  });

  it('keeps the eyebrow label on a single line', async () => {
    const renderer = await renderRow({
      label: 'Thought',
      labelKind: 'eyebrow',
      accessibilityLabel: 'Thought',
    });

    const eyebrows = findHost(renderer.root, 'Eyebrow');
    expect(eyebrows).toHaveLength(1);
    const eyebrow = eyebrows[0];
    if (!eyebrow) {
      throw new Error('eyebrow not found');
    }
    expect(eyebrow.props.numberOfLines).toBe(1);
    expect(eyebrow.props.className).toContain('shrink');
  });
});
