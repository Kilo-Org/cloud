/* eslint-disable typescript-eslint/no-deprecated -- DOM-free mounted React Native assertions. */
import { createElement } from 'react';
import type * as ReactI18next from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import { DestructiveConfirmDialog } from './destructive-confirm-dialog';

vi.mock('react-native', () => ({
  I18nManager: { isRTL: false },
  Pressable: 'Pressable',
  Text: 'Text',
  View: 'View',
}));
vi.mock('@rn-primitives/slot', () => ({ Text: 'Slot.Text' }));
// The dialog reads the bottom inset for its padding; the native module cannot
// load under this project's partial `react-native` mock.
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ bottom: 24, left: 0, right: 0, top: 0 }),
}));
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

function mount(props: Partial<Parameters<typeof DestructiveConfirmDialog>[0]> = {}) {
  act(() => {
    const element = createElement(DestructiveConfirmDialog, {
      title: 'Sign out?',
      message: 'You will need to sign in again to access your workspace.',
      confirmLabel: 'Sign out',
      onConfirm,
      onCancel,
      ...props,
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
  // The finding's defect is that the destructive sign-out action had the same
  // affordance as the neutral cancel on Android. The confirm control must carry
  // the destructive (red) fill while cancel stays a neutral outline.
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

  // The confirm is a native sheet, not a portal dialog, so it stacks above the
  // formSheet routes it is reached from. The sheet hands a dismissal — Android
  // Back, a backdrop tap and a swipe all route through it — to `onCancel`.
  it('presents the content-sized sheet without a drag handle', () => {
    const root = mount();

    const sheet = root.find(node => isType(node, 'BottomSheet'));
    expect(sheet.props.index).toBe(0);
    expect(sheet.props.handleComponent).toBeNull();
    expect(sheet.props.snapPoints).toBeUndefined();
  });

  it('dismisses without confirming when the native sheet closes', () => {
    const root = mount();

    // The sheet wires its own `onClose` to the caller's cancel.
    const onClose = root.find(node => isType(node, 'BottomSheet')).props.onClose as () => void;
    act(() => {
      onClose();
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  // The new-session discard confirm names its safe choice 'Keep editing'
  // instead of the generic Cancel, while the sign-out caller keeps the default.
  it('renders a supplied cancel label instead of the default Cancel', () => {
    const root = mount({ cancelLabel: 'Keep editing' });

    const cancel = pressableWith(root, 'border-border');
    expect(
      cancel.findAll(node => isType(node, 'Text') && node.children.includes('Keep editing'))
    ).toHaveLength(1);
    expect(
      root.findAll(node => isType(node, 'Text') && node.children.includes('Cancel'))
    ).toHaveLength(0);
  });

  it('keeps the default Cancel label when no cancel label is supplied', () => {
    const root = mount();

    expect(
      root.findAll(node => isType(node, 'Text') && node.children.includes('Cancel'))
    ).toHaveLength(1);
  });
});
