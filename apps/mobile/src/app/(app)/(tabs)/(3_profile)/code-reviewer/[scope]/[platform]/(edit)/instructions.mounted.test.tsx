/* eslint-disable max-lines -- the mock harness for the native + dialog chain stays inline so the editor's guard wiring reads as one screen */

// Mounted regression for the Custom instructions editor. Before the change
// the editor kept its draft in a ref over an uncontrolled defaultValue with
// no back guard: any remount silently restored the stored text, and Android
// back discarded an in-progress rewrite without confirmation. The suite
// keeps the real useSettingsBackGuard / useConfirmDialog chain and stubs
// only the native surfaces they render through, so the screen-to-dialog
// wiring is exercised for real.

import { createElement, type ReactNode, useState } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';

import InstructionsRoute from './instructions';

const config = vi.hoisted(() => ({
  data: null as { customInstructions: string } | null,
  isLoading: false,
  isError: false,
  refetch: vi.fn(),
}));
const save = vi.hoisted(() => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }));
const router = vi.hoisted(() => ({ back: vi.fn(), push: vi.fn() }));
const navigation = vi.hoisted(() => ({ dispatch: vi.fn(), goBack: vi.fn() }));
const preventRemove = vi.hoisted(() => ({
  enabled: false,
  handler: undefined as ((options: { data: { action: unknown } }) => void) | undefined,
}));
// The TextInput records its props on render so the test drives a real edit
// through the screen's own onChangeText, not a fabricated dirty flag.
const textInputs = vi.hoisted(() => ({
  inputs: [] as {
    className?: string;
    value?: string;
    defaultValue?: string;
    placeholder?: string;
    onChangeText: (text: string) => void;
    multiline?: boolean;
  }[],
}));
const confirmDialog = vi.hoisted(() => ({
  current: null as {
    cancelLabel?: string;
    confirmLabel?: string;
    extraAction?: { label: string; onPress: () => void };
    onConfirm: () => void;
    onCancel: () => void;
  } | null,
}));

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ scope: 'personal', platform: 'github' }),
  useRouter: () => router,
  useNavigation: () => navigation,
}));
vi.mock('@/lib/hooks/use-code-reviewer', () => ({
  useReviewConfig: () => config,
  useSaveReviewConfig: () => save,
}));
vi.mock('@/lib/navigation/prevent-remove', () => ({
  usePreventRemove: (
    enabled: boolean,
    handler: (options: { data: { action: unknown } }) => void
  ) => {
    preventRemove.enabled = enabled;
    preventRemove.handler = handler;
  },
}));
vi.mock('react-native', () => ({
  View: 'View',
  TextInput: (props: {
    children?: ReactNode;
    className?: string;
    value?: string;
    defaultValue?: string;
    placeholder?: string;
    onChangeText: (text: string) => void;
    multiline?: boolean;
  }): ReactNode => {
    textInputs.inputs.push(props);
    return props.children ?? null;
  },
}));
vi.mock('react-native-reanimated', () => ({
  default: { View: 'AnimatedView' },
  FadeIn: { duration: () => ({}) },
  FadeOut: { duration: () => ({}) },
  LinearTransition: { duration: () => ({}) },
}));
vi.mock('sonner-native', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/sheet', () => ({ Sheet: 'Sheet' }));
vi.mock('@/components/destructive-confirm-dialog', () => ({
  DestructiveConfirmDialog: (props: {
    cancelLabel?: string;
    confirmLabel?: string;
    extraAction?: { label: string; onPress: () => void };
    onConfirm: () => void;
    onCancel: () => void;
  }): ReactNode => {
    confirmDialog.current = props;
    // The host element keeps the confirmation queryable by visibility, so
    // "no dialog drawn" stays distinguishable from "never requested".
    return createElement('DestructiveConfirmDialog');
  },
}));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/screen-header', () => ({
  ScreenHeader: (props: Record<string, unknown>): ReactNode => createElement('ScreenHeader', props),
}));
vi.mock('@/components/tab-screen', () => ({
  TabScreenScrollView: (props: { children?: ReactNode }): ReactNode => props.children ?? null,
}));

let invalidate: () => void = () => undefined;

// Re-renders the mounted route the way a fresh config from the query would:
// a real parent render, not a remount, so the screen's refs and the draft
// survive a refetch.
function Harness() {
  const [, setVersion] = useState(0);
  invalidate = () => {
    setVersion(version => version + 1);
  };
  return createElement(InstructionsRoute);
}

function mount(): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(createElement(Harness));
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('route did not render');
  }
  return renderer;
}

function findByHostType(renderer: TestRenderer.ReactTestRenderer, hostType: string) {
  return renderer.root.findAll(
    (node: TestRenderer.ReactTestInstance) =>
      typeof node.type === 'string' && node.type === hostType
  );
}

function visibleConfirmationCount(renderer: TestRenderer.ReactTestRenderer) {
  return findByHostType(renderer, 'DestructiveConfirmDialog').length;
}

const STORED = 'first line\nsecond line\nthird line\nfourth line\nfifth line\nsixth line';

// The TextInput mock records on every render; the last entry is the current
// one. Six tests need the same lockstep lookup, so it lives here.
function latestInput() {
  const input = textInputs.inputs.at(-1);
  if (!input) {
    throw new Error('instructions input not found');
  }
  return input;
}

beforeEach(() => {
  config.data = null;
  config.isLoading = false;
  config.isError = false;
  save.isPending = false;
  save.mutate.mockReset();
  save.mutateAsync.mockReset();
  save.mutateAsync.mockResolvedValue({});
  router.back.mockReset();
  router.push.mockReset();
  navigation.dispatch.mockReset();
  navigation.goBack.mockReset();
  preventRemove.enabled = false;
  preventRemove.handler = undefined;
  textInputs.inputs = [];
  confirmDialog.current = null;
  invalidate = () => undefined;
});

afterEach(() => {
  act(() => {
    TestRenderer.act(() => undefined);
  });
});

describe('InstructionsRoute editor', () => {
  it('renders a growing field seeded with the stored text', () => {
    config.data = { customInstructions: STORED };
    mount();

    const input = latestInput();
    expect(input.multiline).toBe(true);
    expect(input.defaultValue).toBe(STORED);
    expect(input.value).toBeUndefined();
    const classes = (input.className ?? '').split(' ');
    expect(classes).toContain('min-h-32');
    expect(classes).not.toContain('h-32');
  });

  it('lets a clean screen back out with no confirmation', () => {
    config.data = { customInstructions: STORED };
    const renderer = mount();

    expect(preventRemove.enabled).toBe(false);
    const header = findByHostType(renderer, 'ScreenHeader');
    expect(header).toHaveLength(1);
    const onBack = (header[0]?.props as { onBack?: () => void } | undefined)?.onBack;
    expect(onBack).toBeDefined();

    act(() => {
      onBack?.();
    });
    expect(navigation.goBack).toHaveBeenCalledTimes(1);
    expect(visibleConfirmationCount(renderer)).toBe(0);
  });

  it('keeps the edited draft when back is intercepted, and discards on confirm', () => {
    config.data = { customInstructions: STORED };
    const renderer = mount();

    act(() => {
      latestInput().onChangeText('rewritten draft');
    });
    expect(preventRemove.enabled).toBe(true);

    // Android hardware back / header back while dirty: the guard intercepts.
    act(() => {
      preventRemove.handler?.({ data: { action: { type: 'GO_BACK' } } });
    });
    expect(visibleConfirmationCount(renderer)).toBe(1);
    const dialog = confirmDialog.current;
    if (!dialog) {
      throw new Error('the leave confirmation was not rendered while dirty');
    }
    expect(dialog.cancelLabel).toBe(i18n.t('common.keepEditing'));
    expect(dialog.confirmLabel).toBe(i18n.t('common.discard'));
    expect(dialog.extraAction?.label).toBe(i18n.t('securityAgent.settingsSave.saveChanges'));

    // Keep editing: dismisses the confirmation and keeps the draft. The field
    // is uncontrolled, so the draft lives in the recorded TextInput's own
    // value, not in route state.
    act(() => {
      dialog.onCancel();
    });
    expect(visibleConfirmationCount(renderer)).toBe(0);
    expect(navigation.dispatch).not.toHaveBeenCalled();
    // The keep-editing exit left the screen mounted with its dirty draft;
    // the screen still blocks the next clean exit until the edit is undone.
    expect(preventRemove.enabled).toBe(true);
    // The draft the screen holds (draftRef) is what save persists: another
    // intercepted leave offers Save, and its payload is the edited text.
    act(() => {
      preventRemove.handler?.({ data: { action: { type: 'GO_BACK' } } });
    });
    const reopened = confirmDialog.current;
    if (!reopened?.extraAction) {
      throw new Error('save action missing after keep editing');
    }
    act(() => {
      reopened.onCancel();
    });
    expect(router.back).not.toHaveBeenCalled();

    // Discard: replays the captured navigation and leaves.
    act(() => {
      preventRemove.handler?.({ data: { action: { type: 'GO_BACK' } } });
    });
    expect(visibleConfirmationCount(renderer)).toBe(1);
    act(() => {
      confirmDialog.current?.onConfirm();
    });
    expect(navigation.dispatch).toHaveBeenCalledTimes(1);
  });

  it('saves the trimmed draft through the dialog and leaves', async () => {
    config.data = { customInstructions: STORED };
    mount();

    const input = latestInput();
    act(() => {
      input.onChangeText('  rewritten draft\n');
    });
    act(() => {
      preventRemove.handler?.({ data: { action: { type: 'GO_BACK' } } });
    });
    const dialog = confirmDialog.current;
    const extraAction = dialog?.extraAction;
    if (!extraAction) {
      throw new Error('the save action was not offered while dirty');
    }
    await act(async () => {
      extraAction.onPress();
      // The guard dispatches the captured action after the awaited save; one
      // more turn flushes it.
      await Promise.resolve();
    });
    expect(save.mutateAsync).toHaveBeenCalledWith({ customInstructions: 'rewritten draft' });
    expect(navigation.dispatch).toHaveBeenCalledTimes(1);
  });

  it('persists the trimmed draft from the save button and bypasses the guard on its own back', () => {
    config.data = { customInstructions: STORED };
    const renderer = mount();

    const input = latestInput();
    act(() => {
      input.onChangeText('  rewritten draft\n');
    });

    const buttons = renderer.root.findAll(node => String(node.type) === 'Button');
    const saveButton = buttons.at(-1);
    if (!saveButton) {
      throw new Error('save button not found');
    }
    const saveProps = saveButton.props as Record<string, unknown>;
    const saveOnPress = saveProps.onPress;
    if (typeof saveOnPress !== 'function') {
      throw new TypeError('save button onPress is not a function');
    }
    // typeof narrowing proves callable, not zero-arg; the screen's own
    // Button calls it the same way.
    const pressSave = saveOnPress as () => void;
    act(() => {
      pressSave();
    });
    expect(save.mutate).toHaveBeenCalledWith(
      { customInstructions: 'rewritten draft' },
      expect.objectContaining({ onSuccess: expect.any(Function) })
    );

    const options = save.mutate.mock.calls.at(-1)?.[1] as { onSuccess?: () => void } | undefined;
    const onSuccess = options?.onSuccess;
    if (!onSuccess) {
      throw new Error('save onSuccess not captured');
    }
    act(() => {
      onSuccess();
    });
    expect(router.back).toHaveBeenCalledTimes(1);
    // The next navigation is the screen's own back: the guard must let it
    // through without a confirm, then re-arm for later edits.
    act(() => {
      preventRemove.handler?.({ data: { action: { type: 'GO_BACK' } } });
    });
    expect(navigation.dispatch).toHaveBeenCalledTimes(1);
    expect(visibleConfirmationCount(renderer)).toBe(0);
  });

  it('does not clobber an in-progress edit when the query refetches', async () => {
    config.data = { customInstructions: STORED };
    mount();

    act(() => {
      latestInput().onChangeText('rewritten draft');
    });
    config.data = { customInstructions: STORED };
    act(() => {
      invalidate();
    });
    // The uncontrolled draft survives the refetch: the screen stays dirty,
    // so the guard stays armed for the next exit.
    expect(preventRemove.enabled).toBe(true);
    // The screen's own save (reading the draft ref) still persists the edit.
    act(() => {
      preventRemove.handler?.({ data: { action: { type: 'GO_BACK' } } });
    });
    const reopened = confirmDialog.current;
    const reopenedSave = reopened?.extraAction;
    if (!reopenedSave) {
      throw new Error('save action missing after refetch');
    }
    await act(async () => {
      reopenedSave.onPress();
      await Promise.resolve();
    });
    expect(save.mutateAsync).toHaveBeenCalledWith({ customInstructions: 'rewritten draft' });
  });

  it('renders the skeleton while loading with no editor mounted', () => {
    const renderer = mount();

    expect(textInputs.inputs).toHaveLength(0);
    expect(findByHostType(renderer, 'Skeleton')).toHaveLength(2);
  });
});
