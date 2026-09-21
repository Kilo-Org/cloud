/* eslint-disable typescript-eslint/no-deprecated -- DOM-free mounted React Native assertions. */
import { createElement } from 'react';
import type * as ReactI18next from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import { DestructiveConfirmDialog } from './destructive-confirm-dialog';

vi.mock('react-native', () => ({
  I18nManager: { isRTL: false },
  Modal: 'Modal',
  Pressable: 'Pressable',
  Text: 'Text',
  View: 'View',
}));
vi.mock('@rn-primitives/slot', () => ({ Text: 'Slot.Text' }));
vi.mock('@/components/ui/activity-indicator', () => ({
  ActivityIndicator: 'ActivityIndicator',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    destructiveForeground: '#FFFFFF',
    foreground: '#1A1A10',
    primary: '#00BAA9',
    primaryForeground: '#FFFFFF',
  }),
}));
vi.mock('react-i18next', async importOriginal => {
  const actual = await importOriginal<typeof ReactI18next>();
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => (key === 'common.cancel' ? 'Cancel' : key) }),
  };
});

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

const onConfirm = vi.fn<() => void>();
const onCancel = vi.fn<() => void>();

function mount() {
  act(() => {
    const element = createElement(DestructiveConfirmDialog, {
      title: 'Sign out?',
      message: 'You will need to sign in again to access your workspace.',
      confirmLabel: 'Sign out',
      onConfirm,
      onCancel,
    });
    if (renderer) {
      renderer.update(element);
    } else {
      renderer = TestRenderer.create(element);
    }
  });
  if (!renderer) {
    throw new Error('Missing DestructiveConfirmDialog renderer');
  }
  return renderer.root;
}

function classNameOf(node: TestRenderer.ReactTestInstance): string {
  return typeof node.props.className === 'string' ? node.props.className : '';
}

function isType(node: TestRenderer.ReactTestInstance, type: string): boolean {
  return typeof node.type === 'string' && node.type === type;
}

function pressableWith(root: TestRenderer.ReactTestInstance, token: string) {
  return root.find(node => isType(node, 'Pressable') && classNameOf(node).includes(token));
}

beforeEach(() => {
  onConfirm.mockReset();
  onCancel.mockReset();
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

describe('DestructiveConfirmDialog', () => {
  // The defect this dialog exists for: a destructive action whose confirmation
  // control carries no distinct affordance (Android's native alert paints every
  // button with the theme accent). The confirm control must carry the
  // destructive (red) fill while cancel stays a neutral outline, on both
  // platforms — this component is the one implementation for both.
  it('gives the confirm action the destructive fill and cancel a neutral one', () => {
    const root = mount();

    expect(pressableWith(root, 'bg-destructive')).toBeDefined();
    expect(pressableWith(root, 'border-border')).toBeDefined();
    expect(
      root.findAll(
        node => isType(node, 'Pressable') && classNameOf(node).includes('bg-destructive')
      )
    ).toHaveLength(1);
  });

  it('labels the confirm action with the sign-out copy', () => {
    const root = mount();

    const confirm = pressableWith(root, 'bg-destructive');
    expect(
      confirm.findAll(node => isType(node, 'Text') && node.children.includes('Sign out'))
    ).toHaveLength(1);
    expect(
      root.findAll(node => isType(node, 'Text') && node.children.includes('Sign out?'))
    ).toHaveLength(1);
    expect(
      root.findAll(
        node =>
          isType(node, 'Text') &&
          node.children.includes('You will need to sign in again to access your workspace.')
      )
    ).toHaveLength(1);
  });

  it('runs the destructive action only when the destructive control is pressed', () => {
    const root = mount();

    act(() => {
      (pressableWith(root, 'bg-destructive').props as { onPress?: () => void }).onPress?.();
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);

    act(() => {
      (pressableWith(root, 'border-border').props as { onPress?: () => void }).onPress?.();
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('dismisses without confirming on the back request', () => {
    const root = mount();

    act(() => {
      (
        root.find(node => isType(node, 'Modal')).props as { onRequestClose?: () => void }
      ).onRequestClose?.();
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
