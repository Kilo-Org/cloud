/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as src/test/render-with-providers.tsx) */
import '@/i18n';
import { Eye } from '@/components/ui/icons';
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setConfig } from '@/lib/tool-summary-translation/tool-summary-translation-runtime';

import { FixedPartRow } from './fixed-part-row';
import { ToolSummaryTranslationScope } from './tool-summary-translation-scope';

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }));

vi.mock('@/lib/tool-summary-translation/tool-summary-translation-client', () => ({
  requestToolSummaryTranslation: requestMock,
}));

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

const MODEL = { id: 'kilo-auto/small', name: 'Auto Small' };

function rowLabel(renderer: TestRenderer.ReactTestRenderer): string | undefined {
  return findHost(renderer.root, 'Text').find(node => typeof node.props.children === 'string')
    ?.props.children as string | undefined;
}

function rowAccessibilityLabel(renderer: TestRenderer.ReactTestRenderer): unknown {
  return findHost(renderer.root, 'Pressable')[0]?.props.accessibilityLabel;
}

/**
 * Sync-commit mount so the pre-resolution render is observable: the dynamic
 * import cannot resolve inside a synchronous `act`, which is exactly the
 * original-label-first state under test.
 */
function renderScopedRowSync(props: RowProps): TestRenderer.ReactTestRenderer {
  const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
    current: undefined,
  };
  act(() => {
    rendererRef.current = TestRenderer.create(
      createElement(ToolSummaryTranslationScope, null, createElement(FixedPartRow, props))
    );
  });
  const renderer = rendererRef.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

async function settleTranslation(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- sequential macrotask flushes settle the dynamic import and request
      await new Promise<void>(resolve => {
        setImmediate(resolve);
      });
    }
  });
}

describe('FixedPartRow tool-summary translation', () => {
  beforeEach(() => {
    requestMock.mockReset();
    setConfig({ enabled: false, model: MODEL });
  });

  it('translates the visible label and the spoken summary inside the scope', async () => {
    requestMock.mockResolvedValue('Lire le fichier');
    setConfig({ enabled: true, model: MODEL });
    const renderer = renderScopedRowSync({
      icon: Eye,
      label: 'Read app.ts',
      status: 'completed',
      accessibilityLabel: 'Read app.ts tool, completed',
    });

    // Uncached: the original label renders first, then swaps in place.
    expect(rowLabel(renderer)).toBe('Read app.ts');
    await settleTranslation();

    expect(rowLabel(renderer)).toBe('Lire le fichier');
    expect(rowAccessibilityLabel(renderer)).toBe('Lire le fichier tool, completed');
    act(() => {
      renderer.unmount();
    });
  });

  it('keeps the raw label and makes no request outside the scope while enabled', async () => {
    requestMock.mockResolvedValue('Traduit');
    setConfig({ enabled: true, model: MODEL });
    const renderer = await renderRow({
      icon: Eye,
      label: 'Unscoped summary',
      status: 'completed',
      accessibilityLabel: 'Unscoped summary tool, completed',
    });

    await settleTranslation();

    expect(rowLabel(renderer)).toBe('Unscoped summary');
    expect(rowAccessibilityLabel(renderer)).toBe('Unscoped summary tool, completed');
    expect(requestMock).not.toHaveBeenCalled();
    act(() => {
      renderer.unmount();
    });
  });

  it('keeps the raw label when the translation request rejects', async () => {
    requestMock.mockRejectedValue(new Error('gateway down'));
    setConfig({ enabled: true, model: MODEL });
    const renderer = renderScopedRowSync({
      icon: Eye,
      label: 'Rejected summary',
      status: 'completed',
      accessibilityLabel: 'Rejected summary tool, completed',
    });

    await settleTranslation();

    expect(rowLabel(renderer)).toBe('Rejected summary');
    expect(rowAccessibilityLabel(renderer)).toBe('Rejected summary tool, completed');
    act(() => {
      renderer.unmount();
    });
  });

  it('keeps the raw label and makes no request inside the scope while disabled', async () => {
    requestMock.mockResolvedValue('Traduit');
    setConfig({ enabled: false, model: MODEL });
    const renderer = renderScopedRowSync({
      icon: Eye,
      label: 'Disabled summary',
      status: 'completed',
      accessibilityLabel: 'Disabled summary tool, completed',
    });

    await settleTranslation();

    expect(rowLabel(renderer)).toBe('Disabled summary');
    expect(rowAccessibilityLabel(renderer)).toBe('Disabled summary tool, completed');
    expect(requestMock).not.toHaveBeenCalled();
    act(() => {
      renderer.unmount();
    });
  });
});
