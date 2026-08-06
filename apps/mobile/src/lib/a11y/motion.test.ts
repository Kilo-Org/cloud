/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as src/components/ui/accessible-status.mounted.test.tsx) */
import { type ActionSheetOptions } from '@expo/react-native-action-sheet';
import { createElement, type ReactElement, useEffect } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type ActionSheetListModel } from '@/components/ui/reduced-motion-sheet';

import {
  actionSheetToListModel,
  type MotionPolicy,
  type ShowActionSheetWithOptions,
  useAppActionSheet,
  useMotionPolicy,
} from './motion';

// Centralized reduced-motion policy (P3-C-05, D6 revised, D15, D21).
//
// Feature states covered:
// - Android + reduce motion: the library action sheet is never shown; the
//   shared non-animated Modal option list receives the mapped model, and every
//   item activation or dismissal wires the caller's callback.
// - Android without reduce motion and iOS: the library sheet is delegated to
//   unchanged, so native presentation and callbacks stay identical.
// - The pure mapper preserves option order, arbitrary option counts, and the
//   destructive/cancel indices; dismissal reports the cancel index.

const platformMock = vi.hoisted(() => ({ OS: 'android' as 'android' | 'ios' }));
const reduceMotionMock = vi.hoisted(() => ({ current: true }));
const libraryShowMock = vi.hoisted(() => vi.fn());
const showReducedMotionSheetMock = vi.hoisted(() => vi.fn());

vi.mock('react-native', () => ({
  Platform: platformMock,
}));

vi.mock('react-native-reanimated', () => ({
  useReducedMotion: () => reduceMotionMock.current,
}));

vi.mock('@expo/react-native-action-sheet', () => ({
  useActionSheet: () => ({ showActionSheetWithOptions: libraryShowMock }),
}));

vi.mock('@/components/ui/reduced-motion-sheet', () => ({
  showReducedMotionSheet: showReducedMotionSheetMock,
}));

type Renderer = TestRenderer.ReactTestRenderer;

function ShowHarness({
  onReady,
}: {
  readonly onReady: (show: ShowActionSheetWithOptions) => void;
}) {
  const { showActionSheetWithOptions } = useAppActionSheet();
  useEffect(() => {
    onReady(showActionSheetWithOptions);
  }, [onReady, showActionSheetWithOptions]);
  return null;
}

function PolicyHarness({ onReady }: { readonly onReady: (policy: MotionPolicy) => void }) {
  const policy = useMotionPolicy();
  useEffect(() => {
    onReady(policy);
  }, [onReady, policy]);
  return null;
}

async function mount(element: ReactElement): Promise<Renderer> {
  const holder: { current?: Renderer } = {};
  await act(async () => {
    await Promise.resolve();
    holder.current = TestRenderer.create(element);
  });
  const renderer = holder.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

async function mountShow(): Promise<{
  show: ShowActionSheetWithOptions;
  unmount: () => void;
}> {
  const holder: { current?: ShowActionSheetWithOptions } = {};
  const renderer = await mount(
    createElement(ShowHarness, {
      onReady: next => {
        holder.current = next;
      },
    })
  );
  const show = holder.current;
  if (!show) {
    throw new Error('show was not captured');
  }
  return {
    show,
    unmount: () => {
      renderer.unmount();
    },
  };
}

async function mountPolicy(): Promise<{
  policy: MotionPolicy;
  unmount: () => void;
}> {
  const holder: { current?: MotionPolicy } = {};
  const renderer = await mount(
    createElement(PolicyHarness, {
      onReady: next => {
        holder.current = next;
      },
    })
  );
  const policy = holder.current;
  if (!policy) {
    throw new Error('policy was not captured');
  }
  return {
    policy,
    unmount: () => {
      renderer.unmount();
    },
  };
}

describe('actionSheetToListModel', () => {
  it('maps title, message, and options to list items with their indices', () => {
    const callback = vi.fn();
    const options: ActionSheetOptions = {
      title: 'Session options',
      message: 'Choose an action',
      options: ['Rename', 'Delete', 'Cancel'],
      cancelButtonIndex: 2,
      destructiveButtonIndex: 1,
    };

    const model = actionSheetToListModel(options, callback);

    expect(model.title).toBe('Session options');
    expect(model.message).toBe('Choose an action');
    expect(model.items).toEqual([
      { label: 'Rename', index: 0, destructive: false, cancel: false },
      { label: 'Delete', index: 1, destructive: true, cancel: false },
      { label: 'Cancel', index: 2, destructive: false, cancel: true },
    ]);
  });

  it('preserves option order, keeping the cancel entry where the caller put it', () => {
    const callback = vi.fn();
    const model = actionSheetToListModel(
      { options: ['Cancel', 'Save'], cancelButtonIndex: 0 },
      callback
    );

    expect(model.items.map(item => item.label)).toEqual(['Cancel', 'Save']);
    expect(model.items[0]?.cancel).toBe(true);
    expect(model.items[1]?.cancel).toBe(false);
  });

  it('omits title and message when the caller passes none', () => {
    const callback = vi.fn();
    const model = actionSheetToListModel({ options: ['Only'] }, callback);

    expect(model.title).toBeUndefined();
    expect(model.message).toBeUndefined();
  });

  it('maps an arbitrary option count one-to-one', () => {
    const labels = ['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven'];
    const callback = vi.fn();
    const model = actionSheetToListModel({ options: labels }, callback);

    expect(model.items).toHaveLength(labels.length);
    expect(model.items.map(item => item.label)).toEqual(labels);
    expect(model.items.map(item => item.index)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('maps a single-option sheet to one item', () => {
    const callback = vi.fn();
    const model = actionSheetToListModel({ options: ['Only'] }, callback);

    expect(model.items).toEqual([{ label: 'Only', index: 0, destructive: false, cancel: false }]);
  });

  it('invokes the callback with the selected index on item activation', () => {
    const callback = vi.fn();
    const model = actionSheetToListModel({ options: ['A', 'B', 'C'] }, callback);

    model.onSelect(1);

    expect(callback).toHaveBeenCalledWith(1);
  });

  it('invokes the callback with the cancel index on dismissal', () => {
    const callback = vi.fn();
    const model = actionSheetToListModel(
      { options: ['A', 'Cancel'], cancelButtonIndex: 1 },
      callback
    );

    model.onDismiss();

    expect(callback).toHaveBeenCalledWith(1);
  });

  it('invokes the callback with undefined on dismissal when there is no cancel button', () => {
    const callback = vi.fn();
    const model = actionSheetToListModel({ options: ['A'] }, callback);

    model.onDismiss();

    expect(callback).toHaveBeenCalledWith(undefined);
  });
});

describe('useMotionPolicy', () => {
  it('maps reduce motion on to immediate scrolls', async () => {
    reduceMotionMock.current = true;
    const { policy, unmount } = await mountPolicy();

    expect(policy).toEqual({ reduceMotion: true, scrollAnimated: false });
    unmount();
  });

  it('keeps animated scrolls when reduce motion is off', async () => {
    reduceMotionMock.current = false;
    const { policy, unmount } = await mountPolicy();

    expect(policy).toEqual({ reduceMotion: false, scrollAnimated: true });
    unmount();
  });
});

describe('useAppActionSheet platform delegation', () => {
  beforeEach(() => {
    libraryShowMock.mockClear();
    showReducedMotionSheetMock.mockClear();
  });

  it('Android with reduce motion: shows the non-animated sheet, never the library', async () => {
    platformMock.OS = 'android';
    reduceMotionMock.current = true;
    const callback = vi.fn();
    const options: ActionSheetOptions = {
      options: ['Rename', 'Delete', 'Cancel'],
      cancelButtonIndex: 2,
      destructiveButtonIndex: 1,
    };
    const { show, unmount } = await mountShow();

    await act(() => {
      show(options, callback);
    });

    expect(libraryShowMock).not.toHaveBeenCalled();
    expect(showReducedMotionSheetMock).toHaveBeenCalledTimes(1);
    const model = showReducedMotionSheetMock.mock.calls[0]?.[0] as ActionSheetListModel;
    expect(model.items.map(item => item.label)).toEqual(['Rename', 'Delete', 'Cancel']);
    expect(model.items[1]?.destructive).toBe(true);
    expect(model.items[2]?.cancel).toBe(true);
    model.onSelect(0);
    expect(callback).toHaveBeenCalledWith(0);
    callback.mockClear();
    model.onDismiss();
    expect(callback).toHaveBeenCalledWith(2);
    unmount();
  });

  it('Android without reduce motion: delegates to the library sheet', async () => {
    platformMock.OS = 'android';
    reduceMotionMock.current = false;
    const callback = vi.fn();
    const options: ActionSheetOptions = { options: ['A', 'B'] };
    const { show, unmount } = await mountShow();

    await act(() => {
      show(options, callback);
    });

    expect(showReducedMotionSheetMock).not.toHaveBeenCalled();
    expect(libraryShowMock).toHaveBeenCalledWith(options, callback);
    unmount();
  });

  it('iOS with reduce motion: delegates to the native library sheet', async () => {
    platformMock.OS = 'ios';
    reduceMotionMock.current = true;
    const callback = vi.fn();
    const options: ActionSheetOptions = { options: ['A', 'B'], cancelButtonIndex: 1 };
    const { show, unmount } = await mountShow();

    await act(() => {
      show(options, callback);
    });

    expect(showReducedMotionSheetMock).not.toHaveBeenCalled();
    expect(libraryShowMock).toHaveBeenCalledWith(options, callback);
    unmount();
  });
});
