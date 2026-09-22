import { createElement } from 'react';
import { TestRenderer } from '@/test/renderer';
import { describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';

import { ChatToolbar } from './chat-toolbar';

vi.mock('react-native', () => ({
  Keyboard: { dismiss: vi.fn() },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  View: 'View',
}));
vi.mock('expo-haptics', () => ({ selectionAsync: vi.fn() }));
vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({}),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock('@/components/ui/icons', () => ({
  BookOpenCheck: 'BookOpenCheck',
  Bot: 'Bot',
  Brain: 'Brain',
  Bug: 'Bug',
  Check: 'Check',
  ChevronDown: 'ChevronDown',
  ClipboardPaste: 'ClipboardPaste',
  Code: 'Code',
  HelpCircle: 'HelpCircle',
  NotebookPen: 'NotebookPen',
  Star: 'Star',
  Workflow: 'Workflow',
}));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-available-models', () => ({
  thinkingEffortLabel: (variant: string) => variant,
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    foreground: '#111827',
    mutedForeground: '#6F6A61',
    primary: '#4F5A10',
    warn: '#9F6612',
  }),
}));
vi.mock('@/lib/picker-bridge', () => ({}));
vi.mock('@/lib/route-registry', () => ({
  modelPickerSlot: { set: vi.fn() },
}));
vi.mock('@/lib/utils', () => ({
  cn: (...parts: unknown[]) => parts.filter(Boolean).join(' '),
}));

// The model name from the explorer capture: 19 characters, wider than one
// nowrap toolbar row leaves after the shrink-0 mode chip and the effort badge.
// The row must truncate it via `numberOfLines={1}` instead of letting it wrap.
const LONG_MODEL_NAME = 'DeepSeek V4.1 Flash';

const MODEL_OPTIONS: SessionModelOption[] = [
  {
    id: 'deepseek/deepseek-v4.1-flash',
    name: LONG_MODEL_NAME,
    displayId: 'deepseek/deepseek-v4.1-flash',
    variants: ['low', 'medium'],
    isPreferred: false,
    showGatewayMetadata: true,
  },
];

function renderToolbar(): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  TestRenderer.act(() => {
    ref.current = TestRenderer.create(
      createElement(ChatToolbar, {
        mode: 'code',
        onModeChange: vi.fn<(mode: string) => void>(),
        model: 'deepseek/deepseek-v4.1-flash',
        variant: 'low',
        modelOptions: MODEL_OPTIONS,
        onModelSelect: vi.fn<(modelId: string, variant: string) => void>(),
        onPaste: vi.fn<() => void>(),
      })
    );
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

function findPressable(
  renderer: TestRenderer.ReactTestRenderer,
  matchesLabel: (label: string) => boolean
): TestRenderer.ReactTestInstance | undefined {
  return renderer.root.findAll(
    node =>
      typeof node.type === 'string' &&
      (node.type as string) === 'Pressable' &&
      typeof node.props.accessibilityLabel === 'string' &&
      matchesLabel(node.props.accessibilityLabel)
  )[0];
}

function ancestorsOf(
  node: TestRenderer.ReactTestInstance | undefined
): TestRenderer.ReactTestInstance[] {
  const chain: TestRenderer.ReactTestInstance[] = [];
  for (
    let current: TestRenderer.ReactTestInstance | null | undefined = node;
    current;
    current = current.parent
  ) {
    chain.push(current);
  }
  return chain;
}

/** The nearest row an ancestor of both nodes lays out in. */
function nearestSharedAncestor(
  a: TestRenderer.ReactTestInstance | undefined,
  b: TestRenderer.ReactTestInstance | undefined
): TestRenderer.ReactTestInstance | undefined {
  const ancestorSet = new Set(ancestorsOf(b));
  return ancestorsOf(a).find(candidate => ancestorSet.has(candidate));
}

describe('ChatToolbar long model name', () => {
  it('keeps the toolbar a single nowrap row', () => {
    const renderer = renderToolbar();
    const modeChip = findPressable(renderer, label => label.startsWith('Mode: '));
    const modelChip = findPressable(renderer, label => label.startsWith(LONG_MODEL_NAME));
    expect(modeChip).toBeDefined();
    expect(modelChip).toBeDefined();

    // The mode chip and the model chip share the toolbar row. A wrapping row
    // would drop the model chip onto a second line as soon as the long name
    // outgrows the first, so the shared row must be a plain nowrap row.
    const toolbarRow = nearestSharedAncestor(modeChip, modelChip);
    expect(toolbarRow).toBeDefined();
    expect(toolbarRow?.props.className).toContain('flex-row');
    expect(toolbarRow?.props.className).not.toContain('flex-wrap');
  });

  it('hands the full model name to the chip label, never a pre-shortened string', () => {
    const renderer = renderToolbar();
    const label = renderer.root.findAll(
      node =>
        typeof node.type === 'string' &&
        (node.type as string) === 'Text' &&
        node.props.children === LONG_MODEL_NAME
    );
    expect(label).toHaveLength(1);
    expect(label[0]?.props.numberOfLines).toBe(1);
  });

  it('packs the paste button into the model chip row so it stays on the chip line', () => {
    const renderer = renderToolbar();
    const modelChip = findPressable(renderer, label => label.startsWith(LONG_MODEL_NAME));
    const pasteButton = findPressable(renderer, label => label === 'Paste from clipboard');
    expect(modelChip).toBeDefined();
    expect(pasteButton).toBeDefined();

    // The nearest shared ancestor is the row the chip and the button lay out in.
    // It must be a plain row: a wrapping row would let the button leave the
    // chip's line on its own.
    const chipRow = nearestSharedAncestor(modelChip, pasteButton);
    expect(chipRow).toBeDefined();
    expect(chipRow?.props.className).toContain('flex-row');
    expect(chipRow?.props.className).not.toContain('flex-wrap');
    // The row must also shrink, or the long name overflows the row instead of
    // truncating (React Native defaults `flexShrink` to 0).
    expect(chipRow?.props.className).toContain('shrink');
    expect(chipRow?.props.className).toContain('min-w-0');

    // The button still ends the chip's line at its trailing edge.
    expect(pasteButton?.props.className).toContain('ml-auto');
  });
});
