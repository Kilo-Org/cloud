/* eslint-disable max-lines -- the mock harness for the native + dialog chain stays inline so the editor's guard wiring reads as one screen */

// Mounted regression for the Custom instructions editor. Before the change
// the editor kept its draft in a ref over an uncontrolled defaultValue with
// no back guard: any remount silently restored the stored text, and Android
// back discarded an in-progress rewrite without confirmation. The suite
// keeps the real useSettingsBackGuard / useConfirmDialog chain and stubs
// only the native surfaces they render through, so the screen-to-dialog
// wiring is exercised for real.

import { createElement, Fragment, type ReactElement, type ReactNode, useState } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';

import { enteringAncestors } from '@/components/code-reviewer/entering-animation.test-helpers';
import { ReviewerRouteParamsProvider } from '@/lib/hooks/use-reviewer-route-params';
import InstructionsRoute from './instructions';

const config = vi.hoisted(() => ({
  data: null as { customInstructions: string } | null,
  isLoading: false,
  isError: false,
  isFetching: false,
  fetchStatus: 'idle' as string,
  refetch: vi.fn(),
}));
const connectivity = vi.hoisted(() => ({ known: true }));
const queryError = vi.hoisted(() => ({
  props: [] as { variant?: string; onRetry?: () => void; isRetrying?: boolean }[],
}));
const save = vi.hoisted(() => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }));
// The app's shared clipboard helper; the notice's action must go through it so
// the copy gets the same confirmation toast and failure path as every other
// copy in the app.
const clipboardCopy = vi.hoisted(() => ({ performCopy: vi.fn() }));
const router = vi.hoisted(() => ({ back: vi.fn(), push: vi.fn() }));
const navigation = vi.hoisted(() => ({ dispatch: vi.fn(), goBack: vi.fn() }));
const preventRemove = vi.hoisted(() => ({
  enabled: false,
  handler: undefined as ((options: { repeat: () => void }) => void) | undefined,
}));
// The TextInput records its props on render so the test drives a real edit
// through the screen's own onChangeText, not a fabricated dirty flag.
type RecordedInput = {
  children?: ReactNode;
  className?: string;
  value?: string;
  defaultValue?: string;
  placeholder?: string;
  accessibilityLabel?: string;
  onChangeText: (text: string) => void;
  inputAccessoryViewID?: string;
  multiline?: boolean;
  ref?: { current: { setSelection: (start: number, end: number) => void } | null };
  onLayout?: (event: { nativeEvent: { layout: { height: number } } }) => void;
  onContentSizeChange?: (event: {
    nativeEvent: { contentSize: { height: number; width: number } };
  }) => void;
};
const textInputs = vi.hoisted(() => ({
  inputs: [] as RecordedInput[],
}));
// The field's imperative handle, so the test can see the first-line alignment
// the screen applies to a stored value taller than the capped field.
const fieldHandle = vi.hoisted(() => ({ setSelection: vi.fn() }));
const confirmDialog = vi.hoisted(() => ({
  current: null as {
    title?: string;
    message?: string;
    cancelLabel?: string;
    confirmLabel?: string;
    extraAction?: { label: string; onPress: () => void };
    onConfirm: () => void;
    onCancel: () => void;
  } | null,
}));

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({}),
  useRouter: () => router,
  useNavigation: () => navigation,
  usePreventRemove: (enabled: boolean, handler: (options: { repeat: () => void }) => void) => {
    preventRemove.enabled = enabled;
    preventRemove.handler = handler;
  },
}));
vi.mock('@/lib/hooks/use-code-reviewer', () => ({
  useReviewConfig: () => config,
  useSaveReviewConfig: () => save,
}));
vi.mock('react-native', () => ({
  View: 'View',
  Pressable: 'Pressable',
  InputAccessoryView: 'InputAccessoryView',
  Keyboard: { dismiss: vi.fn() },
  TextInput: (props: RecordedInput): ReactNode => {
    textInputs.inputs.push(props);
    // React 19 hands `ref` to a function component as a prop; the screen reads
    // its imperative handle, so the stub publishes it.
    if (props.ref) {
      props.ref.current = fieldHandle;
    }
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
vi.mock('@/lib/hooks/use-offline-banner-state', () => ({
  useCommittedConnectivityStatus: () => (connectivity.known ? 'online' : 'unknown'),
}));
// Host stub: every rendered error state stays queryable, and its retry
// callback is the one the screen handed it.
vi.mock('@/components/query-error', () => ({
  QueryError: (props: {
    variant?: string;
    onRetry?: () => void;
    isRetrying?: boolean;
  }): ReactNode => {
    queryError.props.push(props);
    return createElement('QueryError');
  },
}));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/sheet', () => ({ Sheet: 'Sheet' }));
vi.mock('@/components/destructive-confirm-dialog', () => ({
  DestructiveConfirmDialog: (props: {
    title?: string;
    message?: string;
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
vi.mock('@/components/ui/icons', () => ({ AlertTriangle: 'AlertTriangle', Copy: 'Copy' }));
vi.mock('@/components/agents/use-message-copy', () => ({
  performCopy: clipboardCopy.performCopy,
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#f5f5f5', warn: '#f2b05f' }),
}));
vi.mock('@/components/invalid-route-state', () => ({ InvalidRouteState: 'InvalidRouteState' }));
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
  // The `[platform]` layout validates the pair and publishes it to the screen.
  return (
    <ReviewerRouteParamsProvider params={{ kind: 'personal', platform: 'github' }}>
      <InstructionsRoute />
    </ReviewerRouteParamsProvider>
  );
}

function mount(element: ReactElement = createElement(Harness)): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(element);
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

// The guard holds the removal back and replays it through the `repeat`
// callback expo-router hands it, so the stub feeds the same contract the hook
// provides: an intercepted exit that re-runs the captured action.
function triggerPreventRemove() {
  const action = { type: 'GO_BACK' };
  preventRemove.handler?.({
    repeat: () => {
      navigation.dispatch(action);
    },
  });
}

const STORED = 'first line\nsecond line\nthird line\nfourth line\nfifth line\nsixth line';

// The shape the notice's copy action exists for: more lines than the field's
// ten-line cap can show at once, with accents, curly quotes and an emoji, so a
// copy that dropped, re-encoded or truncated anything would show.
const LONG_STORED = [
  'Regras gerais:',
  '1. Prefira commits pequenos, com mensagem no imperativo.',
  '2. “Nunca” reescreva histórico publicado: acrescente um commit.',
  '3. Não use `any`; prefira `unknown` e estreite o tipo na origem.',
  '4. Comentários explicam o porquê, não o quê.',
  '5. Testes cobrem comportamento, não a implementação.',
  '6. Sempre rode o lint e o typecheck antes de abrir o MR.',
  '7. Não adicione dependências sem justificar no MR.',
  '8. Migrações são aditivas; a remoção vem em um MR próprio.',
  '9. Erros de rede têm retry limitado e mensagem clara.',
  '10. Strings novas entram em todas as línguas.',
  '11. Componentes novos reutilizam os compartilhados.',
  '12. Emoji nos testes: 🧪 — mantenha o texto exato.',
  'Fim.',
].join('\n');

// The TextInput mock records on every render; the last entry is the current
// one. Six tests need the same lockstep lookup, so it lives here.
function latestInput() {
  const input = textInputs.inputs.at(-1);
  if (!input) {
    throw new Error('instructions input not found');
  }
  return input;
}

// The editor's Save is the screen's: the button only asks for the save, so the
// test presses the same last `Button` the editor renders.
function pressSaveButton(renderer: TestRenderer.ReactTestRenderer) {
  const saveButton = renderer.root.findAll(node => String(node.type) === 'Button').at(-1);
  if (!saveButton) {
    throw new Error('save button not found');
  }
  const onPress = (saveButton.props as Record<string, unknown>).onPress;
  if (typeof onPress !== 'function') {
    throw new TypeError('save button onPress is not a function');
  }
  // typeof narrowing proves callable, not zero-arg; the screen's own Button
  // calls it the same way.
  (onPress as () => void)();
}

// The notice's copy action. The editor renders two buttons and Save is the
// last, so the label it renders is what tells them apart.
function findCopyButton(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root
    .findAll(node => String(node.type) === 'Button')
    .find(button =>
      button
        .findAll(node => String(node.type) === 'Text')
        .some(text => text.props.children === i18n.t('common.copy'))
    );
}

function pressCopyButton(renderer: TestRenderer.ReactTestRenderer) {
  const button = findCopyButton(renderer);
  if (!button) {
    throw new Error('copy action not found');
  }
  const onPress = (button.props as Record<string, unknown>).onPress;
  if (typeof onPress !== 'function') {
    throw new TypeError('copy action onPress is not a function');
  }
  act(() => {
    (onPress as () => void)();
  });
}

// Runs `trigger` inside act and lets the screen's async save (mutation, then
// navigation, or a pending confirmation) settle before the assertions.
async function flush(trigger: () => void) {
  await act(async () => {
    trigger();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  config.data = null;
  config.isLoading = false;
  config.isError = false;
  config.isFetching = false;
  // A fetch in flight never arms the idle-restart timer, so a test that leaves
  // the read pending cannot fire one into a later test's refetch count. The
  // idle tests opt in explicitly with fake timers.
  config.fetchStatus = 'fetching';
  config.refetch.mockReset();
  connectivity.known = true;
  queryError.props = [];
  save.isPending = false;
  save.mutate.mockReset();
  save.mutateAsync.mockReset();
  save.mutateAsync.mockResolvedValue({});
  clipboardCopy.performCopy.mockReset();
  router.back.mockReset();
  router.push.mockReset();
  navigation.dispatch.mockReset();
  navigation.goBack.mockReset();
  preventRemove.enabled = false;
  preventRemove.handler = undefined;
  textInputs.inputs = [];
  fieldHandle.setSelection.mockReset();
  confirmDialog.current = null;
  invalidate = () => undefined;
});

afterEach(async () => {
  act(() => {
    TestRenderer.act(() => undefined);
  });
  await act(async () => {
    await i18n.changeLanguage('en');
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
    // The field grows with a short stored value but stops at ten lines and
    // scrolls its own text: without the cap one long draft makes the page a
    // single oversized text view and pushes the note and Save out of view.
    expect(classes).toContain('max-h-[196px]');
  });

  // A stored value taller than the capped field would otherwise open scrolled
  // to the platform caret at its end, with the first line out of sight.
  function measureField(input: RecordedInput, contentHeight: number) {
    act(() => {
      input.onLayout?.({ nativeEvent: { layout: { height: 196.19 } } });
      input.onContentSizeChange?.({
        nativeEvent: { contentSize: { height: contentHeight, width: 369.5 } },
      });
    });
  }

  it('opens an overflowing stored value at its first line', () => {
    config.data = { customInstructions: STORED.repeat(40) };
    mount();

    measureField(latestInput(), 1264.76);

    expect(fieldHandle.setSelection).toHaveBeenCalledWith(0, 0);
  });

  it('keeps the platform caret for a stored value that fits the field', () => {
    config.data = { customInstructions: STORED };
    mount();

    measureField(latestInput(), 105);

    expect(fieldHandle.setSelection).not.toHaveBeenCalled();
  });

  // The alignment belongs to the stored value's opening state. A mount whose
  // empty field reported no content size must not let the reader's own first
  // edit trigger it and move their caret back to the start.
  it('does not move the caret once the draft has been edited', () => {
    config.data = { customInstructions: '' };
    mount();

    const input = latestInput();
    act(() => {
      input.onLayout?.({ nativeEvent: { layout: { height: 196.19 } } });
      input.onChangeText('pasted draft');
    });
    measureField(input, 1264.76);

    expect(fieldHandle.setSelection).not.toHaveBeenCalled();
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
      triggerPreventRemove();
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
      triggerPreventRemove();
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
      triggerPreventRemove();
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
      triggerPreventRemove();
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

  it('persists the trimmed draft from the save button and bypasses the guard on its own back', async () => {
    config.data = { customInstructions: STORED };
    const renderer = mount();

    act(() => {
      latestInput().onChangeText('  rewritten draft\n');
    });

    await flush(() => {
      pressSaveButton(renderer);
    });
    expect(save.mutateAsync).toHaveBeenCalledWith({ customInstructions: 'rewritten draft' });
    expect(router.back).toHaveBeenCalledTimes(1);
    // The next navigation is the screen's own back: the guard must let it
    // through without a confirm, then re-arm for later edits.
    act(() => {
      triggerPreventRemove();
    });
    expect(navigation.dispatch).toHaveBeenCalledTimes(1);
    expect(visibleConfirmationCount(renderer)).toBe(0);
  });

  it('asks before an empty field removes the stored instructions, and keeps the editor on cancel', async () => {
    config.data = { customInstructions: STORED };
    const renderer = mount();

    act(() => {
      latestInput().onChangeText('');
    });

    await flush(() => {
      pressSaveButton(renderer);
    });
    expect(visibleConfirmationCount(renderer)).toBe(1);
    const removal = confirmDialog.current;
    expect(removal?.title).toBe(i18n.t('codeReviewer.instructions.clearTitle'));
    expect(removal?.message).toBe(i18n.t('codeReviewer.instructions.clearMessage'));
    expect(removal?.confirmLabel).toBe(i18n.t('common.remove'));
    expect(removal?.cancelLabel).toBe(i18n.t('common.keepEditing'));
    // The question is a yes/no about the removal, with no third choice.
    expect(removal?.extraAction).toBeUndefined();
    expect(save.mutateAsync).not.toHaveBeenCalled();
    expect(router.back).not.toHaveBeenCalled();

    await flush(() => {
      removal?.onCancel();
    });
    expect(visibleConfirmationCount(renderer)).toBe(0);
    expect(save.mutateAsync).not.toHaveBeenCalled();
    expect(router.back).not.toHaveBeenCalled();
    // The edited draft is still unsaved, so the guard still holds the exit.
    expect(preventRemove.enabled).toBe(true);
  });

  it('removes the stored instructions once the reader confirms it', async () => {
    config.data = { customInstructions: STORED };
    const renderer = mount();

    act(() => {
      latestInput().onChangeText('   ');
    });

    await flush(() => {
      pressSaveButton(renderer);
    });
    expect(save.mutateAsync).not.toHaveBeenCalled();

    await flush(() => {
      confirmDialog.current?.onConfirm();
    });
    expect(save.mutateAsync).toHaveBeenCalledWith({ customInstructions: '' });
    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it('saves an empty field with no confirmation when nothing is stored', async () => {
    config.data = { customInstructions: '' };
    const renderer = mount();

    await flush(() => {
      pressSaveButton(renderer);
    });
    expect(visibleConfirmationCount(renderer)).toBe(0);
    expect(save.mutateAsync).toHaveBeenCalledWith({ customInstructions: '' });
    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it('asks the same question from the back guard save and stays when it is declined', async () => {
    config.data = { customInstructions: STORED };
    const renderer = mount();

    act(() => {
      latestInput().onChangeText('');
    });
    act(() => {
      triggerPreventRemove();
    });
    const saveChanges = confirmDialog.current?.extraAction;
    expect(saveChanges?.label).toBe(i18n.t('securityAgent.settingsSave.saveChanges'));

    await flush(() => {
      saveChanges?.onPress();
    });
    // The guard's own sheet stays mounted while the removal question is
    // presented over it (the emulator shows one native sheet, the removal
    // one), so the save does not run straight through.
    expect(visibleConfirmationCount(renderer)).toBe(2);
    expect(confirmDialog.current?.title).toBe(i18n.t('codeReviewer.instructions.clearTitle'));
    expect(confirmDialog.current?.message).toBe(i18n.t('codeReviewer.instructions.clearMessage'));
    expect(save.mutateAsync).not.toHaveBeenCalled();

    await flush(() => {
      confirmDialog.current?.onCancel();
    });
    // Declining puts the unsaved-changes sheet back in front: the leave is
    // dropped and the draft is still there to discard or save.
    expect(confirmDialog.current?.title).toBe(i18n.t('securityAgent.settingsSave.unsavedTitle'));
    expect(save.mutateAsync).not.toHaveBeenCalled();
    expect(navigation.dispatch).not.toHaveBeenCalled();
    expect(preventRemove.enabled).toBe(true);
  });

  it('removes the stored instructions from the back guard save once it is confirmed', async () => {
    config.data = { customInstructions: STORED };
    mount();

    act(() => {
      latestInput().onChangeText('');
    });
    act(() => {
      triggerPreventRemove();
    });
    await flush(() => {
      confirmDialog.current?.extraAction?.onPress();
    });
    await flush(() => {
      confirmDialog.current?.onConfirm();
    });

    expect(save.mutateAsync).toHaveBeenCalledWith({ customInstructions: '' });
    expect(navigation.dispatch).toHaveBeenCalledTimes(1);
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
      triggerPreventRemove();
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

  it('names the editor with the localized instructions title', () => {
    config.data = { customInstructions: STORED };
    mount();

    expect(latestInput().accessibilityLabel).toBe(i18n.t('codeReviewer.instructions.title'));
  });

  // As body-coloured copy the deprecation note read as a description of the
  // field under it. It is now a notice of its own: a tinted block with its
  // warning mark, in the warning ink rather than the muted one.
  it('renders the deprecation note as a warning notice of its own', () => {
    config.data = { customInstructions: STORED };
    const renderer = mount();

    const noticeCopy = findByHostType(renderer, 'Text').filter(node => {
      const props = node.props as { className?: string };
      return props.className?.includes('text-warn') === true;
    });
    expect(noticeCopy).toHaveLength(1);
    const copy = noticeCopy[0]?.props as { children?: string } | undefined;
    expect(copy?.children).toBe(i18n.t('codeReviewer.instructions.deprecation'));
    expect(findByHostType(renderer, 'AlertTriangle')).toHaveLength(1);
  });

  it('reads the editor name from the active catalog', async () => {
    await act(async () => {
      await i18n.changeLanguage('ar');
    });
    config.data = { customInstructions: STORED };
    mount();

    const input = latestInput();
    expect(input.accessibilityLabel).toBe(i18n.t('codeReviewer.instructions.title'));
    expect(input.accessibilityLabel).not.toBe('Custom instructions');
  });
});

// The notice tells the reader to move the instructions into REVIEW.md, and the
// field below it shows ten lines of a value that can be far longer. The action
// beside the notice is the way out: it hands over the whole stored value in one
// press through the app's shared clipboard helper, which owns the confirmation
// toast and the failure path.
describe('InstructionsRoute retirement notice copy action', () => {
  it('copies the whole stored value, not the window the field shows', () => {
    config.data = { customInstructions: LONG_STORED };
    const renderer = mount();

    pressCopyButton(renderer);

    expect(clipboardCopy.performCopy).toHaveBeenCalledTimes(1);
    expect(clipboardCopy.performCopy).toHaveBeenCalledWith(LONG_STORED);
  });

  it('copies the stored value while an unsaved edit sits in the field', () => {
    config.data = { customInstructions: STORED };
    const renderer = mount();
    act(() => {
      latestInput().onChangeText('an unsaved rewrite');
    });

    pressCopyButton(renderer);

    // The notice retires the stored instructions; the edit is not saved yet, so
    // it is not what the reader is being told to carry over.
    expect(clipboardCopy.performCopy).toHaveBeenCalledWith(STORED);
  });

  it('offers no copy action when nothing is stored', () => {
    config.data = { customInstructions: '' };
    const renderer = mount();

    expect(findCopyButton(renderer)).toBeUndefined();
  });
});

// The iOS accessory bar is the only keyboard-adjacent way out of this
// multiline field, and iOS binds it to the first text input in the window whose
// `inputAccessoryViewID` matches the bar's `nativeID`, once, when the bar enters
// the window. A field and a bar that carry one id for the whole module let a
// second mounted editor take the first editor's bar and leave its own keyboard
// with no labeled control above it, so the id belongs to the mount.
describe('InstructionsRoute keyboard Done bar', () => {
  it('pairs the field with the bar that carries the Done control', () => {
    config.data = { customInstructions: STORED };
    const renderer = mount();

    const bars = findByHostType(renderer, 'InputAccessoryView');
    expect(bars).toHaveLength(1);
    const nativeId = bars[0]?.props.nativeID;
    expect(typeof nativeId).toBe('string');
    expect(latestInput().inputAccessoryViewID).toBe(nativeId);

    // The bar's one control is the labeled Done button the accessibility tree
    // reports above the IME.
    const controls = findByHostType(renderer, 'Pressable');
    expect(controls).toHaveLength(1);
    expect(controls[0]?.props.accessibilityLabel).toBe(i18n.t('common.done'));
  });

  it('gives every mounted editor its own bar', () => {
    config.data = { customInstructions: STORED };
    // Two live copies of the editor, the state a visit leaves behind while its
    // screens are still on the stack.
    const renderer = mount(
      createElement(Fragment, null, [
        createElement(Harness, { key: 'first' }),
        createElement(Harness, { key: 'second' }),
      ])
    );

    const nativeIds = findByHostType(renderer, 'InputAccessoryView').map(
      node => node.props.nativeID
    );
    expect(nativeIds).toHaveLength(2);
    expect(nativeIds[0]).not.toBe(nativeIds[1]);
    expect(new Set(textInputs.inputs.map(input => input.inputAccessoryViewID))).toEqual(
      new Set(nativeIds)
    );
  });
});

// The config read drives the whole body, so every state it can reach must
// paint something the user can act on: a skeleton while the first load is in
// flight, the editor once it lands, and a retryable error when it failed or
// stopped with nothing in flight.
describe('InstructionsRoute config read states', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('offers Retry instead of an endless skeleton when the load fails', () => {
    config.isError = true;
    const renderer = mount();

    expect(findByHostType(renderer, 'Skeleton')).toHaveLength(0);
    expect(textInputs.inputs).toHaveLength(0);
    expect(queryError.props.at(-1)?.variant).toBe('server');
    expect(config.refetch).not.toHaveBeenCalled();
  });

  it('retries the read when the error state Retry is pressed', () => {
    config.isError = true;
    mount();

    act(() => {
      queryError.props.at(-1)?.onRetry?.();
    });

    expect(config.refetch).toHaveBeenCalledTimes(1);
  });

  it('names the confirmed-offline pause as the reason the load stopped', () => {
    config.fetchStatus = 'paused';
    const renderer = mount();

    expect(queryError.props.at(-1)?.variant).toBe('offline');
    expect(findByHostType(renderer, 'Skeleton')).toHaveLength(0);
  });

  it('keeps waiting while the pause has no settled connectivity yet', () => {
    connectivity.known = false;
    config.fetchStatus = 'paused';
    const renderer = mount();

    expect(queryError.props).toHaveLength(0);
    expect(findByHostType(renderer, 'Skeleton')).toHaveLength(2);
  });

  it('keeps the editor when a background refetch fails with cached config', () => {
    config.data = { customInstructions: STORED };
    config.isError = true;
    mount();

    expect(queryError.props).toHaveLength(0);
    expect(latestInput().defaultValue).toBe(STORED);
  });

  it('paints the landed body with no entering animation above it', () => {
    config.data = { customInstructions: STORED };
    const renderer = mount();

    const note = renderer.root.findAll(
      node =>
        String(node.type) === 'Text' &&
        node.props.children === i18n.t('codeReviewer.instructions.deprecation')
    )[0];
    if (!note) {
      throw new Error('the deprecation note was not rendered');
    }
    // A Reanimated entering animation carries `initialValues: { opacity: 0 }`.
    // Above the loaded body it leaves the note, the field and Save mounted at
    // opacity 0 under the painted header — an empty body with no skeleton, no
    // error and no retry — whenever that entrance is cancelled or overwritten
    // (Android report, 2026-10-31). The body must paint in the frame the read
    // lands, with no ancestor holding an entering animation.
    expect(enteringAncestors(note)).toEqual([]);
    expect(latestInput().defaultValue).toBe(STORED);
  });

  it('restarts an idle read on its own and paints the editor once it lands', async () => {
    vi.useFakeTimers();
    config.fetchStatus = 'idle';
    config.refetch.mockImplementation(() => {
      config.data = { customInstructions: STORED };
      return Promise.resolve();
    });

    const renderer = mount();
    expect(findByHostType(renderer, 'Skeleton')).toHaveLength(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });

    expect(config.refetch).toHaveBeenCalledTimes(1);
    expect(queryError.props).toHaveLength(0);
    expect(latestInput().defaultValue).toBe(STORED);
  });

  it('offers Retry when the restart cannot revive the read, and Retry re-requests it', async () => {
    vi.useFakeTimers();
    config.fetchStatus = 'idle';
    const renderer = mount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });

    // The single automatic attempt did not get a fetch running, so the body
    // stops waiting behind a skeleton and offers the action that can.
    expect(config.refetch).toHaveBeenCalledTimes(1);
    expect(queryError.props.at(-1)?.variant).toBe('server');
    expect(findByHostType(renderer, 'Skeleton')).toHaveLength(0);

    act(() => {
      queryError.props.at(-1)?.onRetry?.();
    });

    expect(config.refetch).toHaveBeenCalledTimes(2);
    expect(findByHostType(renderer, 'Skeleton')).toHaveLength(2);
  });
});
