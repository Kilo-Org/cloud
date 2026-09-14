import '@/i18n';
import { Eye } from '@/components/ui/icons';
import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { describe, expect, it, vi } from 'vitest';

import { FixedPartRow } from './fixed-part-row';
import { MessageLongPressContext } from './message-long-press-context';

vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  I18nManager: { isRTL: false },
  Pressable: 'Pressable',
  View: 'View',
}));
vi.mock('@/components/ui/icons', () => ({
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

async function renderRowInContext(
  props: RowProps,
  messageLongPress?: () => void
): Promise<TestRenderer.ReactTestRenderer> {
  const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
    current: undefined,
  };
  const element = messageLongPress
    ? createElement(
        MessageLongPressContext.Provider,
        { value: messageLongPress },
        createElement(FixedPartRow, props)
      )
    : createElement(FixedPartRow, props);
  await act(async () => {
    await Promise.resolve();
    rendererRef.current = TestRenderer.create(element);
  });
  const renderer = rendererRef.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

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

/** The inner row that carries the label and, when present, the badge. */
function findContentRow(root: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance {
  const row = findHost(root, 'View').find(
    node =>
      typeof node.props.className === 'string' &&
      node.props.className.includes('flex-1') &&
      node.props.className.includes('flex-row')
  );
  if (!row) {
    throw new Error('label/badge content row not found');
  }
  return row;
}

function textWithContent(
  root: TestRenderer.ReactTestInstance,
  content: string
): TestRenderer.ReactTestInstance[] {
  return findHost(root, 'Text').filter(node => node.props.children === content);
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

  it('forwards a long press to the message-details handler through the context', async () => {
    const onPress = vi.fn(() => undefined);
    const messageLongPress = vi.fn(() => undefined);
    const renderer = await renderRowInContext(
      {
        label: 'Thinking',
        labelKind: 'eyebrow',
        variant: 'dashed',
        onPress,
        accessibilityLabel: 'Thinking',
      },
      messageLongPress
    );

    const pressable = findHost(renderer.root, 'Pressable')[0];
    expect(pressable).toBeDefined();
    if (!pressable) {
      throw new Error('pressable not found');
    }
    expect(pressable.props.onLongPress).toBe(messageLongPress);

    // The row stays enabled for taps: long-press opens the message details,
    // a plain tap still opens the part detail.
    expect(pressable.props.disabled).toBe(false);
    expect(pressable.props.onPress).toBe(onPress);
  });

  it('keeps tap-only behavior when no message long-press is mounted', async () => {
    const onPress = vi.fn(() => undefined);
    const renderer = await renderRowInContext({
      label: 'Thinking',
      labelKind: 'eyebrow',
      variant: 'dashed',
      onPress,
      accessibilityLabel: 'Thinking',
    });

    const pressable = findHost(renderer.root, 'Pressable')[0];
    expect(pressable).toBeDefined();
    if (!pressable) {
      throw new Error('pressable not found');
    }
    expect(pressable.props.onLongPress).toBeUndefined();
    expect(pressable.props.onPress).toBe(onPress);
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

  it('matches the dashed outer box to the solid outer box', async () => {
    const renderer = await renderRow({
      label: 'Thought',
      labelKind: 'eyebrow',
      variant: 'dashed',
      accessibilityLabel: 'Thought',
    });

    const outerView = findHost(renderer.root, 'View').find(
      node =>
        typeof node.props.className === 'string' && node.props.className.includes('border-dashed')
    );
    expect(outerView).toBeDefined();
    if (!outerView) {
      throw new Error('dashed outer view not found');
    }
    const className = outerView.props.className as string;
    expect(className).toContain('overflow-hidden');
    expect(className).toContain('rounded-lg');
    expect(className).toContain('border-dashed');
    expect(className).not.toContain('rounded-xl');
    expect(className).not.toContain('border-[1.5px]');
  });
});

describe('FixedPartRow label and detail alignment', () => {
  it('shares one baseline between the tool name and its detail', async () => {
    const renderer = await renderRow({
      icon: Eye,
      label: 'fleet.py',
      badge: 'L2600 i redova: 75',
      status: 'completed',
      accessibilityLabel: 'fleet.py tool, completed',
    });

    const content = findContentRow(renderer.root);
    expect(content.props.className).toContain('items-baseline');
    expect(content.props.className).not.toContain('items-center');

    const label = textWithContent(renderer.root, 'fleet.py');
    const badge = textWithContent(renderer.root, 'L2600 i redova: 75');
    expect(label).toHaveLength(1);
    expect(badge).toHaveLength(1);
    // The two pieces keep their existing styles and truncation.
    expect(label[0]?.props.className).toContain('text-sm');
    expect(label[0]?.props.className).toContain('text-muted-foreground');
    expect(badge[0]?.props.className).toContain('text-xs');
    expect(label[0]?.props.numberOfLines).toBe(1);
    expect(badge[0]?.props.numberOfLines).toBe(1);
  });

  it('keeps the alignment for a long name and a long detail', async () => {
    const renderer = await renderRow({
      icon: Eye,
      label: 'a-very-long-tool-name-that-should-truncate-at-the-tail.tsx',
      badge: 'L1234567890 i redova: 999999',
      status: 'completed',
      accessibilityLabel: 'long tool, completed',
    });

    const content = findContentRow(renderer.root);
    expect(content.props.className).toContain('items-baseline');
  });

  it('keeps the alignment for a row with no detail', async () => {
    const renderer = await renderRow({
      icon: Eye,
      label: 'fleet.py',
      status: 'completed',
      accessibilityLabel: 'fleet.py tool, completed',
    });

    const content = findContentRow(renderer.root);
    expect(content.props.className).toContain('items-baseline');
    expect(textWithContent(renderer.root, 'fleet.py')).toHaveLength(1);
  });

  it('keeps the alignment for an eyebrow label', async () => {
    const renderer = await renderRow({
      label: 'Thought',
      labelKind: 'eyebrow',
      badge: '3',
      accessibilityLabel: 'Thought',
    });

    const content = findContentRow(renderer.root);
    expect(content.props.className).toContain('items-baseline');
  });
});
