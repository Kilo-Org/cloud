import { describe, expect, it, vi } from 'vitest';

import { TestRenderer } from '@/test/renderer';

import {
  BYOK_MODEL_LABEL,
  freeModelDataLabel,
  freeModelFreeLabel,
} from '@/lib/free-model-data-disclosure';
import { i18n } from '@/i18n';

import {
  checkAccessories,
  cliCatalogOption,
  countWithAccessibilityLabel,
  isInstance,
  renderRow,
  renderSelector,
  rowContainer,
  textStrings,
  trailingSlots,
} from './model-selector.mounted.test-helpers';

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

describe('Auto model labels', () => {
  // The backend names Kilo's own Auto models in English ("Auto Efficient"),
  // which no catalog translates; the chip and the picker row must show the
  // catalog's label instead so the Arabic composer is not half translated.
  const autoOption = cliCatalogOption({
    id: 'kilo-auto/efficient',
    displayId: 'kilo-auto/efficient',
    name: 'backend name',
  });

  it('renders the catalog label, not the backend name, on the chip', () => {
    const renderer = renderSelector({ value: autoOption.id, options: [autoOption] });
    const texts = textStrings(renderer.root);
    expect(texts).toContain(i18n.t('models.auto.efficient'));
    expect(texts).not.toContain('backend name');
  });

  it('renders the catalog label, not the backend name, in the picker row', () => {
    const renderer = renderRow(autoOption);
    const texts = textStrings(renderer.root);
    expect(texts).toContain(i18n.t('models.auto.efficient'));
    expect(texts).not.toContain('backend name');
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
    displayId: 'kilo-auto/efficient',
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
    const renderer = renderSelector({
      value: 'kilo-auto/efficient',
      options: [{ ...autoOption, id: 'kilo-auto/efficient', showGatewayMetadata: true }],
    });
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
    const renderer = renderSelector({ options: [cliCatalogOption()] });
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

describe('ModelSelector loading chip', () => {
  it('labels the chip while the catalog loads instead of rendering a blank skeleton', () => {
    const renderer = renderSelector({ isLoading: true });

    expect(textStrings(renderer.root)).toContain('Model');
    expect(renderer.root.findAllByType('Skeleton')).toHaveLength(0);
    expect(renderer.root.findAllByType('ChevronDown')).toHaveLength(1);
  });

  it('marks the loading chip as a busy disabled button', () => {
    const renderer = renderSelector({ isLoading: true });

    const chip = renderer.root.findAll(
      node =>
        typeof node.type === 'string' &&
        (node.type as string) === 'View' &&
        (node.props.accessibilityState as { busy?: boolean } | undefined)?.busy === true
    )[0];

    expect(chip).toBeDefined();
    expect(chip?.props.accessibilityRole).toBe('button');
    expect(chip?.props.accessibilityState).toEqual({ busy: true, disabled: true });
    expect(chip?.props.accessibilityLabel).toBe('Model');
    // A plain View is not an accessibility element by default (unlike the
    // pressable the loaded chip renders), so the label and busy state above
    // reach a screen reader only when the view is marked accessible.
    expect(chip?.props.accessible).toBe(true);
  });

  it('renders the resolved model name once the catalog lands', () => {
    const option = cliCatalogOption();
    const renderer = renderSelector({ value: option.id, options: [option] });

    expect(textStrings(renderer.root)).toContain(option.name);
  });
});
