import { createElement } from 'react';
import { vi } from 'vitest';

import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';
import { TestRenderer } from '@/test/renderer';

import { ModelPickerOptionRow, ModelSelector } from './model-selector';

export function cliCatalogOption(overrides: Partial<SessionModelOption> = {}): SessionModelOption {
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

export function renderRow(
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
  return requireRenderer(ref.current);
}

export function renderSelector(
  overrides: Partial<{
    value: string;
    variant: string;
    options: SessionModelOption[];
    isLoading: boolean;
  }> = {}
): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  TestRenderer.act(() => {
    ref.current = TestRenderer.create(
      createElement(ModelSelector, {
        value: overrides.value ?? '',
        variant: overrides.variant ?? '',
        options: overrides.options ?? [],
        isLoading: overrides.isLoading ?? false,
        onSelect: vi.fn<(modelId: string, variant: string) => void>(),
      })
    );
  });
  return requireRenderer(ref.current);
}

function requireRenderer(
  renderer: TestRenderer.ReactTestRenderer | undefined
): TestRenderer.ReactTestRenderer {
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

export function textStrings(root: TestRenderer.ReactTestInstance): string[] {
  return root
    .findAll(
      node =>
        typeof node.type === 'string' &&
        (node.type as string) === 'Text' &&
        typeof node.props.children === 'string'
    )
    .map(node => node.props.children as string);
}

export function countWithAccessibilityLabel(
  root: TestRenderer.ReactTestInstance,
  label: string
): number {
  return root.findAll(node => (node.props.accessibilityLabel as string | undefined) === label)
    .length;
}

export function trailingSlots(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAll(
      node =>
        typeof node.type === 'string' &&
        ((node.type as string) === 'Star' || (node.type as string) === 'Check')
    )
    .map(node => `${String(node.type)}:${String(node.props.size)}`);
}

export function checkAccessories(
  renderer: TestRenderer.ReactTestRenderer
): { color: unknown; size: unknown }[] {
  return renderer.root
    .findAll(node => typeof node.type === 'string' && (node.type as string) === 'Check')
    .map(node => ({ color: node.props.color, size: node.props.size }));
}

export function isInstance(
  node: TestRenderer.ReactTestInstance | string
): node is TestRenderer.ReactTestInstance {
  return typeof node !== 'string';
}

export function rowContainer(
  renderer: TestRenderer.ReactTestRenderer
): TestRenderer.ReactTestInstance {
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
