/* eslint-disable typescript-eslint/no-deprecated, max-lines -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as src/components/ui/accessible-status.mounted.test.tsx) */
import { type ComponentProps, createElement, type ReactElement, useState } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PickerSheet } from './picker-sheet';
import { SheetHeader } from './sheet-header';
import '@/i18n';

const safeArea = vi.hoisted(() => ({ top: 0, bottom: 0, left: 0, right: 0 }));
const rn = vi.hoisted(() => ({ os: 'ios', statusHeight: 0 }));

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  View: 'View',
  I18nManager: { allowRTL: vi.fn(), isRTL: false, forceRTL: vi.fn() },
  Platform: {
    get OS() {
      return rn.os;
    },
  },
  StatusBar: {
    get currentHeight() {
      return rn.statusHeight;
    },
  },
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => safeArea,
}));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons', () => ({ Info: 'Info', Share: 'Share' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#111827' }),
}));

async function mount(
  props: ComponentProps<typeof SheetHeader>
): Promise<TestRenderer.ReactTestRenderer> {
  const renderer = await mountElement(createElement(SheetHeader, props));
  return renderer;
}

async function mountElement(element: ReactElement): Promise<TestRenderer.ReactTestRenderer> {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = {
    current: undefined,
  };
  await act(async () => {
    await Promise.resolve();
    ref.current = TestRenderer.create(element);
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

function pressablesByLabel(
  root: TestRenderer.ReactTestInstance,
  label: string
): TestRenderer.ReactTestInstance[] {
  return root.findAll(
    node =>
      typeof node.type === 'string' &&
      (node.type as string) === 'Pressable' &&
      node.props.accessibilityLabel === label
  );
}

function findHeaderContainer(root: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance {
  return root.find(
    node =>
      typeof node.type === 'string' &&
      (node.type as string) === 'View' &&
      node.props.collapsable === false
  );
}

/**
 * The header row sits in an inner wrapper that carries the top and landscape side
 * insets, so they add to the outer container's `px-4` gutter instead of
 * overriding it. Derive it from the row it wraps: a parent shell (PickerSheet)
 * also renders a className-less View, so scanning for one would return the shell
 * and the assertion on the wrapper's style would be vacuous.
 */
function findSafeAreaWrapper(root: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance {
  const row = root.find(
    node =>
      typeof node.type === 'string' &&
      (node.type as string) === 'View' &&
      typeof node.props.className === 'string' &&
      node.props.className.includes('flex-row')
  );
  const wrapper = row.parent;
  if (!wrapper || typeof wrapper.type !== 'string') {
    throw new Error('safe-area wrapper not found');
  }
  return wrapper;
}

/**
 * Mounts a bottom-form-sheet header with a resolved top inset under `os` and
 * returns the inset wrapper's style, so the test can compare platforms.
 */
async function bottomFormSheetTopInsetStyle(os: string): Promise<unknown> {
  rn.os = os;
  rn.statusHeight = 48;
  safeArea.top = 59;
  const renderer = await mount({
    title: 'Voice language',
    onDone: () => undefined,
    onCancel: () => undefined,
    topInset: 'bottom-form-sheet',
  });
  const style = findSafeAreaWrapper(renderer.root).props.style;
  renderer.unmount();
  return style;
}

function HeaderWithActionFeedback({
  initialTitle = 'report.pdf',
  doneLabel = 'Finish',
}: {
  initialTitle?: string;
  doneLabel?: string;
}) {
  const [title, setTitle] = useState(initialTitle);
  return createElement(SheetHeader, {
    title,
    onDone: () => {
      setTitle('Completed');
    },
    onCancel: () => {
      setTitle('Previous picker');
    },
    onShare: () => {
      setTitle('Shared');
    },
    doneLabel,
    cancelLabel: 'Back',
  });
}

describe('SheetHeader', () => {
  beforeEach(() => {
    Object.assign(safeArea, { top: 0, bottom: 0, left: 0, right: 0 });
    rn.os = 'ios';
    rn.statusHeight = 0;
  });

  it('renders a Share pressable in the leading slot when onShare is provided', async () => {
    const renderer = await mount({
      title: 'report.pdf',
      onDone: () => undefined,
      onShare: () => undefined,
    });

    const shares = pressablesByLabel(renderer.root, 'Share report.pdf');
    expect(shares).toHaveLength(1);
    expect(shares[0]?.props.accessibilityRole).toBe('button');
    expect(shares[0]?.props.disabled).toBe(false);
    expect(shares[0]?.props.accessibilityState).toEqual({ disabled: false, busy: false });

    renderer.unmount();
  });

  it('disables only the Share pressable while sharing', async () => {
    const renderer = await mount({
      title: 'report.pdf',
      onDone: () => undefined,
      onCancel: () => undefined,
      onShare: () => undefined,
      sharing: true,
    });

    const shares = pressablesByLabel(renderer.root, 'Share report.pdf');
    expect(shares).toHaveLength(1);
    expect(shares[0]?.props.disabled).toBe(true);
    expect(shares[0]?.props.accessibilityState).toEqual({ disabled: true, busy: true });
    expect(pressablesByLabel(renderer.root, 'Done')[0]?.props.disabled).toBe(false);
    expect(pressablesByLabel(renderer.root, 'Cancel')[0]?.props.disabled).toBe(false);

    renderer.unmount();
  });

  it('renders no Share pressable without onShare and keeps the Done button', async () => {
    const renderer = await mount({
      title: 'report.pdf',
      onDone: () => undefined,
    });

    expect(pressablesByLabel(renderer.root, 'Share report.pdf')).toHaveLength(0);
    expect(pressablesByLabel(renderer.root, 'Done')).toHaveLength(1);

    renderer.unmount();
  });

  it('keeps Cancel leading and Done trailing through native row direction', async () => {
    const renderer = await mount({
      title: 'report.pdf',
      onDone: () => undefined,
      onCancel: () => undefined,
    });

    const cancels = pressablesByLabel(renderer.root, 'Cancel');
    const dones = pressablesByLabel(renderer.root, 'Done');
    expect(cancels).toHaveLength(1);
    expect(dones).toHaveLength(1);
    const row = dones[0]?.parent;
    expect(cancels[0]?.parent).toBe(row);
    expect(row?.props.className).toContain('flex-row');
    expect(row?.props.className).not.toContain('flex-row-reverse');
    expect(row?.children[0]).toBe(cancels[0]);
    expect(row?.parent?.children).toHaveLength(1);
    expect(row?.parent?.children.at(-1)).toBe(row);
    expect(row?.children.at(-1)).toBe(dones[0]);
    expect(dones[0]?.props.className).toContain('ms-auto');

    renderer.unmount();
  });

  it('labels the leading control with cancelLabel so Back is not announced as Cancel', async () => {
    const renderer = await mount({
      title: 'report.pdf',
      onDone: () => undefined,
      onCancel: () => undefined,
      cancelLabel: 'Back',
    });

    expect(pressablesByLabel(renderer.root, 'Back')).toHaveLength(1);
    expect(pressablesByLabel(renderer.root, 'Cancel')).toHaveLength(0);

    renderer.unmount();
  });

  it('keeps Run on and action text with native font scaling and unlimited action lines', async () => {
    const title = 'Run on';
    const cancelLabel = 'Previous picker';
    const doneLabel = 'Confirm selection';
    const renderer = await mount({
      title,
      cancelLabel,
      doneLabel,
      onDone: () => undefined,
      onCancel: () => undefined,
    });
    const texts = renderer.root.findAll(
      node => typeof node.type === 'string' && (node.type as string) === 'Text'
    );

    expect(texts.map(node => node.props.children)).toEqual(
      expect.arrayContaining([title, cancelLabel, doneLabel])
    );
    for (const text of texts) {
      if (text.props.accessibilityRole !== 'header') {
        expect(text.props.numberOfLines).toBeUndefined();
      }
      expect(text.props.allowFontScaling).not.toBe(false);
      expect(text.props.maxFontSizeMultiplier).toBeUndefined();
      expect(text.props.adjustsFontSizeToFit).not.toBe(true);
    }

    renderer.unmount();
  });

  it.each([`${'long filename '.repeat(16)}report.txt`, `${'x'.repeat(240)}.txt`])(
    'bounds long filename %# while preserving its full accessible name and Done',
    async filename => {
      const renderer = await mountElement(
        createElement(HeaderWithActionFeedback, { initialTitle: filename, doneLabel: 'Done' })
      );
      const title = renderer.root.findByProps({ accessibilityRole: 'header' });

      // Native props bound the title; this renderer cannot prove visibility at large text sizes.
      expect(title.props.numberOfLines).toBe(2);
      expect(title.props.ellipsizeMode).toBe('tail');
      expect(title.props.accessibilityLabel).toBe(filename);
      expect(title.children).toEqual([filename]);
      expect(title.props.allowFontScaling).not.toBe(false);
      expect(title.props.maxFontSizeMultiplier).toBeUndefined();
      expect(title.props.adjustsFontSizeToFit).not.toBe(true);
      const done = pressablesByLabel(renderer.root, 'Done')[0];
      expect(done?.props.disabled).toBe(false);
      const onPress: () => void = done?.props.onPress;
      await act(async () => {
        await Promise.resolve();
        onPress();
      });
      expect(renderer.root.findByProps({ accessibilityRole: 'header' }).children).toEqual([
        'Completed',
      ]);

      renderer.unmount();
    }
  );

  it('gives every action a growing target of at least 44 points', async () => {
    const renderer = await mount({
      title: 'report.pdf',
      onDone: () => undefined,
      onCancel: () => undefined,
      onShare: () => undefined,
    });
    for (const label of ['Done', 'Cancel', 'Share report.pdf']) {
      const buttons = pressablesByLabel(renderer.root, label);
      expect(buttons).toHaveLength(1);
      expect(buttons[0]?.props.className).toContain('min-h-11');
      expect(buttons[0]?.props.className).toContain('min-w-11');
      expect(buttons[0]?.props.className).not.toMatch(/(?:^|\s)(?:absolute|h-|max-h-)/);
      expect(buttons[0]?.props.hitSlop).toBe(8);
    }

    renderer.unmount();
  });

  it('disables and restores all supplied controls without marking Share busy', async () => {
    const props = {
      title: 'report.pdf',
      onDone: () => undefined,
      onCancel: () => undefined,
      onShare: () => undefined,
    };
    const renderer = await mount({ ...props, disabled: true });
    for (const label of ['Done', 'Cancel', 'Share report.pdf']) {
      expect(pressablesByLabel(renderer.root, label)[0]?.props.disabled).toBe(true);
    }
    expect(
      pressablesByLabel(renderer.root, 'Share report.pdf')[0]?.props.accessibilityState
    ).toEqual({
      disabled: true,
      busy: false,
    });

    await act(async () => {
      await Promise.resolve();
      renderer.update(createElement(SheetHeader, { ...props, disabled: false }));
    });
    for (const label of ['Done', 'Cancel', 'Share report.pdf']) {
      expect(pressablesByLabel(renderer.root, label)[0]?.props.disabled).toBe(false);
    }

    renderer.unmount();
  });

  it.each([
    ['Finish', 'Completed'],
    ['Back', 'Previous picker'],
    ['Share report.pdf', 'Shared'],
  ])('lets %s update the caller through its own callback', async (label, outcome) => {
    const renderer = await mountElement(createElement(HeaderWithActionFeedback));
    const onPress: (() => void) | undefined = pressablesByLabel(renderer.root, label)[0]?.props
      .onPress;
    if (!onPress) {
      throw new Error(`missing ${label} callback`);
    }
    await act(async () => {
      await Promise.resolve();
      onPress();
    });
    expect(renderer.root.findByProps({ accessibilityRole: 'header' }).children).toEqual([outcome]);

    renderer.unmount();
  });

  it.each([false, true])(
    'keeps the non-collapsible header before the picker scroll view (expired=%s)',
    async expired => {
      const renderer = await mountElement(
        createElement(
          PickerSheet,
          { title: 'Run on', onDone: () => undefined, expired },
          createElement('Text', null, 'Picker content')
        )
      );
      const tree = renderer.toJSON();
      if (!Array.isArray(tree)) {
        throw new TypeError('the header and scroll view must remain direct siblings');
      }
      expect(tree).toHaveLength(2);
      expect(tree[0]?.type).toBe('View');
      expect(tree[0]?.props.collapsable).toBe(false);
      expect(tree[1]?.type).toBe(expired ? 'EmptyState' : 'ScrollView');
      expect(pressablesByLabel(renderer.root, 'Done')).toHaveLength(1);

      renderer.unmount();
    }
  );

  it('keeps the outer container classes and a styleless wrapper at zero side insets', async () => {
    const renderer = await mount({
      title: 'report.pdf',
      onDone: () => undefined,
      onCancel: () => undefined,
    });

    // Portrait no-op: the wrapper style collapses to undefined (an inline 0
    // would override the `px-4` className gutter) and the outer container keeps
    // the non-collapsible header contract and its gutter class untouched.
    const container = findHeaderContainer(renderer.root);
    expect(container.props.collapsable).toBe(false);
    expect(container.props.className).toContain('px-4');
    expect(container.props.style).toBeUndefined();
    expect(findSafeAreaWrapper(renderer.root).props.style).toBeUndefined();

    renderer.unmount();
  });

  it('pads the row by the landscape side insets inside the outer gutter', async () => {
    safeArea.left = 47;
    safeArea.right = 59;
    const renderer = await mount({
      title: 'report.pdf',
      onDone: () => undefined,
      onCancel: () => undefined,
    });

    // The side insets land on the inner wrapper so they ADD to the `px-4`
    // gutter (an inline padding on the container would override the class),
    // and the non-collapsible header contract stays on the outer View.
    const container = findHeaderContainer(renderer.root);
    expect(container.props.collapsable).toBe(false);
    expect(container.props.className).toContain('px-4');
    expect(container.props.style).toBeUndefined();
    const wrapper = findSafeAreaWrapper(renderer.root);
    expect(wrapper.props.style).toEqual({ paddingLeft: 47, paddingRight: 59 });
    const cancel = pressablesByLabel(renderer.root, 'Cancel')[0];
    const done = pressablesByLabel(renderer.root, 'Done')[0];
    expect(cancel?.parent?.parent).toBe(wrapper);
    expect(done?.parent?.parent).toBe(wrapper);

    renderer.unmount();
  });

  it('clears the status bar when the sheet reaches the top safe area', async () => {
    safeArea.top = 24;
    const renderer = await mount({
      title: 'Voice language',
      onDone: () => undefined,
      onCancel: () => undefined,
    });

    const container = findHeaderContainer(renderer.root);
    // The safe area adds clearance rather than replacing the outer gutter.
    // Cancel, the title, and Done remain together inside the protected row.
    expect(container.props.className).toContain('pt-4');
    const wrapper = findSafeAreaWrapper(renderer.root);
    expect(wrapper.props.style).toEqual({ paddingTop: 24 });
    expect(pressablesByLabel(renderer.root, 'Cancel')[0]?.parent?.parent).toBe(wrapper);
    expect(pressablesByLabel(renderer.root, 'Done')[0]?.parent?.parent).toBe(wrapper);

    renderer.unmount();
  });

  it.each(['ios', 'android'])(
    'falls back to the synchronous status-bar height while the top inset is unresolved (%s)',
    async os => {
      rn.os = os;
      rn.statusHeight = 48;
      const renderer = await mount({
        title: 'Voice language',
        onDone: () => undefined,
        onCancel: () => undefined,
      });

      // The frame a freshly presented sheet lays out can report top: 0; the
      // synchronous status-bar height keeps the Done pill below the icons.
      const wrapper = findSafeAreaWrapper(renderer.root);
      expect(wrapper.props.style).toEqual({ paddingTop: 48 });

      renderer.unmount();
    }
  );

  it.each(['ios', 'android'])(
    'prefers a resolved top inset over the status-bar fallback (%s)',
    async os => {
      rn.os = os;
      rn.statusHeight = 48;
      safeArea.top = 24;
      const renderer = await mount({
        title: 'Voice language',
        onDone: () => undefined,
        onCancel: () => undefined,
      });

      const wrapper = findSafeAreaWrapper(renderer.root);
      expect(wrapper.props.style).toEqual({ paddingTop: 24 });

      renderer.unmount();
    }
  );

  it.each(['ios', 'android'])('drops the top clearance for a bottom formSheet (%s)', async os => {
    // p7: a bottom-anchored sheet never draws under the status bar, so the
    // resolved window inset is only a dead band above the header — one rule
    // reserves nothing on either platform.
    rn.os = os;
    rn.statusHeight = 48;
    safeArea.top = 24;
    const renderer = await mount({
      title: 'Voice language',
      onDone: () => undefined,
      onCancel: () => undefined,
      topInset: 'bottom-form-sheet',
    });

    const wrapper = findSafeAreaWrapper(renderer.root);
    expect(wrapper.props.style).toBeUndefined();

    renderer.unmount();
  });

  it('reserves the same bottom-form-sheet top clearance regardless of Platform.OS', async () => {
    // Regression for the removed platform fork: with a resolved top inset the
    // old iOS branch kept 59 while Android dropped it. One implementation now
    // drops it under identical inputs on both OS values.
    const iosStyle = await bottomFormSheetTopInsetStyle('ios');
    const androidStyle = await bottomFormSheetTopInsetStyle('android');

    expect(iosStyle).toBeUndefined();
    expect(androidStyle).toBe(iosStyle);
  });

  it.each(['ios', 'android'])(
    'keeps landscape side insets for a bottom formSheet while dropping the top clearance (%s)',
    async os => {
      rn.os = os;
      rn.statusHeight = 48;
      safeArea.top = 24;
      safeArea.left = 47;
      safeArea.right = 59;
      const renderer = await mount({
        title: 'Voice language',
        onDone: () => undefined,
        onCancel: () => undefined,
        topInset: 'bottom-form-sheet',
      });

      const wrapper = findSafeAreaWrapper(renderer.root);
      expect(wrapper.props.style).toEqual({ paddingLeft: 47, paddingRight: 59 });

      renderer.unmount();
    }
  );

  it.each(['ios', 'android'])(
    'passes the bottom-form-sheet top-inset mode through PickerSheet (%s)',
    async os => {
      // The picker shells are bottom formSheets: they sit below the status
      // bar, so the shell must not reserve the window's top inset.
      rn.os = os;
      rn.statusHeight = 48;
      safeArea.top = 24;
      const renderer = await mountElement(
        createElement(
          PickerSheet,
          { title: 'Voice language', onDone: () => undefined },
          createElement('Text', null, 'Picker content')
        )
      );

      const wrapper = findSafeAreaWrapper(renderer.root);
      // The wrapper must be SheetHeader's own inset wrapper, not PickerSheet's
      // className-less shell, or this assertion is vacuous.
      expect(pressablesByLabel(renderer.root, 'Done')[0]?.parent?.parent).toBe(wrapper);
      expect(wrapper.props.style).toBeUndefined();

      renderer.unmount();
    }
  );
});
