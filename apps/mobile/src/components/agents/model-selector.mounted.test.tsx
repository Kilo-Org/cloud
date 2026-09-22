import { createElement } from 'react';
import { TestRenderer } from '@/test/renderer';
import { describe, expect, it, vi } from 'vitest';

import {
  BYOK_MODEL_LABEL,
  freeModelDataLabel,
  freeModelFreeLabel,
} from '@/lib/free-model-data-disclosure';
import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';

import { ModelPickerOptionRow, ModelSelector } from './model-selector';

const keyboardDismiss = vi.hoisted(() => vi.fn());
const routerPush = vi.hoisted(() => vi.fn());

vi.mock('react-native', () => ({
  Keyboard: { dismiss: keyboardDismiss },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  View: 'View',
}));
vi.mock('expo-haptics', () => ({
  selectionAsync: vi.fn(),
}));
vi.mock('expo-router', () => ({
  useRouter: () => ({ push: routerPush }),
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

function trailingSlots(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAll(
      node =>
        typeof node.type === 'string' &&
        ((node.type as string) === 'Star' || (node.type as string) === 'Check')
    )
    .map(node => `${String(node.type)}:${String(node.props.size)}`);
}

function checkAccessories(
  renderer: TestRenderer.ReactTestRenderer
): { color: unknown; size: unknown }[] {
  return renderer.root
    .findAll(node => typeof node.type === 'string' && (node.type as string) === 'Check')
    .map(node => ({ color: node.props.color, size: node.props.size }));
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

describe('ModelPickerOptionRow trailing accessory slot', () => {
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
  });

  it('keeps the star then the reserved check in one order on every row', () => {
    const option = cliCatalogOption();
    expect(trailingSlots(renderRow(option, { selected: false }))).toEqual(['Star:20', 'Check:18']);
    expect(trailingSlots(renderRow(option, { selected: true }))).toEqual(['Star:20', 'Check:18']);
  });

  it('hides the reserved check on unselected rows and shows it on selected rows', () => {
    const option = cliCatalogOption();
    expect(checkAccessories(renderRow(option, { selected: false }))).toEqual([
      { color: 'transparent', size: 18 },
    ]);
    expect(checkAccessories(renderRow(option, { selected: true }))).toEqual([
      { color: '#4F5A10', size: 18 },
    ]);
  });
});

// Kilo's auto models arrive from the gateway with an English product name
// ("Auto Efficient"), which was the one English word left on the Arabic
// new-session screen. The name must come from the catalogs instead, in both
// places the composer renders it: the picker row and the chip that opens it.
describe('Kilo auto model names', () => {
  const autoOption = cliCatalogOption({
    name: 'gateway-spelled auto name',
    modelRef: { providerID: 'kilo', modelID: 'kilo-auto/efficient' },
  });

  it('names a Kilo auto model from the catalog in the picker row', () => {
    const texts = textStrings(renderRow(autoOption).root);
    expect(texts).toContain('Auto Efficient');
    expect(texts).not.toContain('gateway-spelled auto name');
  });

  it('keeps the gateway name for a vendor model', () => {
    const texts = textStrings(renderRow(cliCatalogOption({ name: 'DeepSeek V4.1 Flash' })).root);
    expect(texts).toContain('DeepSeek V4.1 Flash');
  });

  it('names a Kilo auto model from the catalog in the chip', () => {
    const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
    TestRenderer.act(() => {
      ref.current = TestRenderer.create(
        createElement(ModelSelector, {
          value: 'kilo-auto/efficient',
          variant: '',
          options: [{ ...autoOption, id: 'kilo-auto/efficient', showGatewayMetadata: true }],
          onSelect: vi.fn<(modelId: string, variant: string) => void>(),
        })
      );
    });
    const renderer = ref.current;
    if (!renderer) {
      throw new Error('renderer was not created');
    }
    const texts = textStrings(renderer.root);
    expect(texts).toContain('Auto Efficient');
    expect(texts).not.toContain('gateway-spelled auto name');
  });
});

// The model sheet anchors over the keyboard only at its first layout and never
// re-anchors when the keyboard hides, so opening it while the composer holds
// the IME up keeps the keyboard-height bottom inset and exposes a strip of the
// screen behind the sheet. The picker must drop the keyboard before it pushes
// the route (the model-picker bleed along the bottom edge).
describe('openModelPicker sheet anchoring', () => {
  it('dismisses the keyboard before opening the sheet', () => {
    keyboardDismiss.mockClear();
    routerPush.mockClear();
    const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
    TestRenderer.act(() => {
      ref.current = TestRenderer.create(
        createElement(ModelSelector, {
          value: '',
          variant: '',
          options: [cliCatalogOption()],
          onSelect: vi.fn<(modelId: string, variant: string) => void>(),
        })
      );
    });
    const renderer = ref.current;
    if (!renderer) {
      throw new Error('renderer was not created');
    }
    const [chip] = renderer.root.findAllByType('Pressable');
    if (!chip) {
      throw new Error('model chip not found');
    }
    const chipProps = chip.props as { onPress?: () => void };

    TestRenderer.act(() => {
      chipProps.onPress?.();
    });

    // Dismissed before the route push: the sheet reads the window's bottom
    // inset at first layout, so the keyboard must already be down.
    expect(keyboardDismiss).toHaveBeenCalledTimes(1);
    expect(routerPush).toHaveBeenCalledTimes(1);
    expect(keyboardDismiss.mock.invocationCallOrder[0]).toBeLessThan(
      routerPush.mock.invocationCallOrder[0] ?? 0
    );
  });
});
