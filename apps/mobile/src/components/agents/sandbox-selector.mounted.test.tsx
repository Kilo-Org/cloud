/* eslint-disable max-lines -- the mocked RN/expo surface and the two field states share one harness */
import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import type * as ReactI18next from 'react-i18next';

import {
  type SandboxAllocation,
  type SandboxSelectionCapabilities,
} from '@/lib/sandbox-allocation-label';
import { sandboxPickerSlot, UNFENCED_ROUTE_KEY } from '@/lib/route-registry';

import { SandboxSelector } from './sandbox-selector';

const push = vi.hoisted(() => vi.fn());
const dismiss = vi.hoisted(() => vi.fn());

vi.mock('react-i18next', async importOriginal => {
  const actual = await importOriginal<typeof ReactI18next>();
  return {
    ...actual,
    useTranslation: () => {
      const i18n = actual.getI18n();
      return { t: i18n.t.bind(i18n), i18n };
    },
  };
});

vi.mock('expo-router', () => ({
  useRouter: () => ({ push }),
}));

vi.mock('react-native', () => ({
  Keyboard: { dismiss },
  Pressable: 'Pressable',
}));

vi.mock('@/components/ui/icons', () => ({ ChevronDown: 'ChevronDown' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#666' }),
}));

const CLOUDFLARE_SINGLE: SandboxAllocation = {
  provider: { id: 'cloudflare', account: 'kilo' },
  instanceType: 'single',
};
const VERCEL_LARGE: SandboxAllocation = {
  provider: { id: 'vercel', account: 'kilo' },
  instanceType: 'large',
};
const CAPABILITIES: SandboxSelectionCapabilities = {
  enabled: true,
  defaultDestination: CLOUDFLARE_SINGLE,
  options: [{ allocation: CLOUDFLARE_SINGLE }, { allocation: VERCEL_LARGE }],
};

const onChange = vi.fn<(next: SandboxAllocation | undefined) => void>();

function findHost(
  renderer: TestRenderer.ReactTestRenderer,
  type: string
): TestRenderer.ReactTestInstance[] {
  return renderer.root.findAll(node => typeof node.type === 'string' && node.type === type);
}

function renderField(
  value: SandboxAllocation | undefined,
  disabled = false
): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(
      createElement(SandboxSelector, {
        value,
        capabilities: CAPABILITIES,
        organizationId: 'org-1',
        onChange,
        disabled,
      })
    );
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('sandbox selector did not render');
  }
  return renderer;
}

function field(renderer: TestRenderer.ReactTestRenderer) {
  const [pressable] = findHost(renderer, 'Pressable');
  if (!pressable) {
    throw new Error('sandbox field did not render a Pressable');
  }
  return pressable;
}

function labelText(renderer: TestRenderer.ReactTestRenderer): unknown {
  const [text] = findHost(renderer, 'Text');
  return text?.props.children;
}

beforeEach(() => {
  push.mockReset();
  dismiss.mockReset();
  onChange.mockReset();
  sandboxPickerSlot.clear(UNFENCED_ROUTE_KEY);
});

describe('SandboxSelector', () => {
  it('labels the closed field with the backend default while nothing is picked', () => {
    const renderer = renderField(undefined);
    expect(labelText(renderer)).toBe('Default · Cloudflare · Small');
    expect(field(renderer).props.accessibilityLabel).toBe('Sandbox: Default · Cloudflare · Small');
    expect(field(renderer).props.accessibilityState).toEqual({ disabled: false });
  });

  it('labels the closed field with the picked allocation', () => {
    const renderer = renderField(VERCEL_LARGE);
    expect(labelText(renderer)).toBe('Vercel · Large');
    expect(field(renderer).props.accessibilityLabel).toBe('Sandbox: Vercel · Large');
  });

  it('writes the backend snapshot to the bridge, dismisses the keyboard, and opens the picker', () => {
    const renderer = renderField(CLOUDFLARE_SINGLE);
    act(() => {
      (field(renderer).props.onPress as () => void)();
    });

    expect(sandboxPickerSlot.get(UNFENCED_ROUTE_KEY)).toEqual({
      organizationId: 'org-1',
      options: CAPABILITIES.options,
      defaultDestination: CAPABILITIES.defaultDestination,
      currentValue: CLOUDFLARE_SINGLE,
      onSelect: onChange,
    });
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith('/(app)/agent-chat/sandbox-picker');
  });

  it('does not open the picker while the field is disabled', () => {
    const renderer = renderField(undefined, true);
    expect(field(renderer).props.disabled).toBe(true);
    act(() => {
      (field(renderer).props.onPress as () => void)();
    });
    expect(sandboxPickerSlot.get(UNFENCED_ROUTE_KEY)).toBeUndefined();
    expect(push).not.toHaveBeenCalled();
    expect(dismiss).not.toHaveBeenCalled();
  });
});
