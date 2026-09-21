import { createElement } from 'react';
import { TestRenderer } from '@/test/renderer';
import { describe, expect, it, vi } from 'vitest';

import {
  BYOK_MODEL_LABEL,
  freeModelDataLabel,
  freeModelFreeLabel,
} from '@/lib/free-model-data-disclosure';
import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';

import { ModelPickerOptionRow } from './model-selector';

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  View: 'View',
}));
vi.mock('expo-haptics', () => ({
  selectionAsync: vi.fn(),
}));
vi.mock('expo-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock('@/components/ui/icons', () => ({
  BookOpenCheck: 'BookOpenCheck',
  Brain: 'Brain',
  Check: 'Check',
  ChevronDown: 'ChevronDown',
  Star: 'Star',
}));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    warn: '#9F6612',
    mutedForeground: '#6F6A61',
    primary: '#4F5A10',
  }),
}));
vi.mock('@/lib/hooks/use-available-models', () => ({
  thinkingEffortLabel: (variant: string) => variant,
}));
vi.mock('@/lib/picker-bridge', () => ({
  setModelPickerBridge: vi.fn(),
}));
vi.mock('@/lib/utils', () => ({
  cn: (...parts: unknown[]) => parts.filter(Boolean).join(' '),
}));

function cliCatalogOption(overrides: Partial<SessionModelOption> = {}): SessionModelOption {
  return {
    id: 'remote-model-0',
    name: 'Minimax M2.5',
    displayId: 'minimax/minimax-m2.5',
    variants: [],
    isPreferred: false,
    showGatewayMetadata: false,
    ...overrides,
  };
}

function renderRow(
  option: SessionModelOption,
  overrides: Partial<{ selected: boolean; isFavorite: boolean }> = {}
): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  TestRenderer.act(() => {
    ref.current = TestRenderer.create(
      createElement(ModelPickerOptionRow, {
        option,
        selected: overrides.selected ?? false,
        selectedVariant: '',
        isFavorite: overrides.isFavorite ?? false,
        onSelectModel: vi.fn<(option: SessionModelOption) => void>(),
        onSelectVariant: vi.fn<(variant: string) => void>(),
        onToggleFavorite: vi.fn<(option: SessionModelOption) => void>(),
      })
    );
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

function textStrings(root: TestRenderer.ReactTestInstance): string[] {
  return root
    .findAll(
      node =>
        typeof node.type === 'string' &&
        (node.type as string) === 'Text' &&
        typeof node.props.children === 'string'
    )
    .map(node => node.props.children as string);
}

function countWithAccessibilityLabel(root: TestRenderer.ReactTestInstance, label: string): number {
  return root.findAll(node => (node.props.accessibilityLabel as string | undefined) === label)
    .length;
}

function isInstance(
  node: TestRenderer.ReactTestInstance | string
): node is TestRenderer.ReactTestInstance {
  return typeof node !== 'string';
}

function rowContainer(renderer: TestRenderer.ReactTestRenderer): TestRenderer.ReactTestInstance {
  const container = renderer.root.findAll(
    node =>
      typeof node.type === 'string' &&
      (node.type as string) === 'View' &&
      typeof node.props.className === 'string' &&
      node.props.className.includes('gap-3 pr-4')
  )[0];
  if (!container) {
    throw new Error('row container not found');
  }
  return container;
}

describe('ModelPickerOptionRow BYOK badge', () => {
  it('renders the BYOK badge for a CLI-catalog option with user BYOK available', () => {
    const renderer = renderRow(cliCatalogOption({ hasUserByokAvailable: true }));
    expect(textStrings(renderer.root)).toContain(BYOK_MODEL_LABEL);
  });

  it('renders no BYOK badge for a CLI-catalog option without the flag', () => {
    const renderer = renderRow(cliCatalogOption());
    expect(textStrings(renderer.root)).not.toContain(BYOK_MODEL_LABEL);
  });

  it('renders no Free or data-collection indicators for a CLI-catalog option', () => {
    const renderer = renderRow(cliCatalogOption({ isFree: true, mayTrainOnYourPrompts: true }));
    expect(textStrings(renderer.root)).not.toContain(freeModelFreeLabel());
    expect(countWithAccessibilityLabel(renderer.root, freeModelDataLabel())).toBe(0);
  });
});

describe('ModelPickerOptionRow trailing check column', () => {
  it('reserves the same trailing column whether or not the row is selected', () => {
    const selectedRow = rowContainer(renderRow(cliCatalogOption(), { selected: true }));
    const unselectedRow = rowContainer(renderRow(cliCatalogOption(), { selected: false }));

    const selectedChildren = selectedRow.children.filter(isInstance);
    const unselectedChildren = unselectedRow.children.filter(isInstance);

    // content, star, trailing slot — in both rows.
    expect(selectedChildren).toHaveLength(3);
    expect(unselectedChildren).toHaveLength(3);

    const selectedSlot = selectedChildren[2];
    const unselectedSlot = unselectedChildren[2];

    // The trailing slot is the same element with the same fixed width in both
    // rows, so the favorite star holds one column down the list.
    expect(selectedSlot?.type).toBe('View');
    expect(unselectedSlot?.type).toBe('View');
    expect(selectedSlot?.props.className).toBe(unselectedSlot?.props.className);
    expect(String(selectedSlot?.props.className)).toContain('w-[18px]');

    // Only the contents differ: the check marks the selected row.
    expect(selectedSlot?.findAllByType('Check')).toHaveLength(1);
    expect(unselectedSlot?.findAllByType('Check')).toHaveLength(0);
  });
});
