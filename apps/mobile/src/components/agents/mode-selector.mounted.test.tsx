import { createElement } from 'react';
import { TestRenderer } from '@/test/renderer';
import { describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';

import { ModeSelector } from './mode-selector';

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  View: 'View',
}));
vi.mock('expo-haptics', () => ({ selectionAsync: vi.fn() }));
vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({}),
  useRouter: () => ({ push: vi.fn() }),
}));
// The mode picker opens through the guarded push; nothing here asserts it.
vi.mock('@/lib/hooks/use-single-push-route', () => ({
  useSinglePushRoute: () => vi.fn(),
}));
vi.mock('@/components/ui/icons', () => ({
  Bot: 'Bot',
  Bug: 'Bug',
  ChevronDown: 'ChevronDown',
  Code: 'Code',
  HelpCircle: 'HelpCircle',
  NotebookPen: 'NotebookPen',
  Workflow: 'Workflow',
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    foreground: '#111827',
    mutedForeground: '#6F6A61',
  }),
}));
vi.mock('@/lib/utils', () => ({
  cn: (...parts: unknown[]) => parts.filter(Boolean).join(' '),
}));
vi.mock('@/lib/route-registry', () => ({
  modePickerSlot: { set: vi.fn() },
  UNFENCED_ROUTE_KEY: 'unfenced',
}));

function renderChip(value: string): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  TestRenderer.act(() => {
    ref.current = TestRenderer.create(
      createElement(ModeSelector, { value, customOptions: [], onChange: () => undefined })
    );
  });
  if (!ref.current) {
    throw new Error('renderer was not created');
  }
  return ref.current;
}

function chipAccessibilityLabel(renderer: TestRenderer.ReactTestRenderer): string | undefined {
  const [chip] = renderer.root.findAll(node => node.props.accessibilityRole === 'button');
  return chip?.props.accessibilityLabel as string | undefined;
}

describe('ModeSelector chip label', () => {
  // A selected custom slug the loaded options do not carry printed the machine
  // slug on the chip and in its accessible name.
  it('names a custom mode the loaded options do not carry with the generic label', () => {
    const renderer = renderChip('reviewer');

    expect(
      renderer.root.findAll(
        node => String(node.type) === 'Text' && node.props.children === 'Custom mode'
      )
    ).toHaveLength(1);
    expect(chipAccessibilityLabel(renderer)).toBe(
      `Mode: ${i18n.t('agentChat.modeSelector.customMode')}`
    );
  });

  it('keeps the built-in label for a built-in mode', () => {
    const renderer = renderChip('code');

    expect(
      renderer.root.findAll(node => String(node.type) === 'Text' && node.props.children === 'Code')
    ).toHaveLength(1);
    expect(chipAccessibilityLabel(renderer)).toBe(`Mode: ${i18n.t('agentChat.modeOptions.code')}`);
  });
});
