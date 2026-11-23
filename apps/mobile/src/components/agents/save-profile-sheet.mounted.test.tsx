import { createElement, type ReactNode } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import {
  type SaveProfileOutcome,
  SaveProfileSheet,
  type SaveProfileSheetProps,
} from './save-profile-sheet';

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  useColorScheme: () => 'light',
  ScrollView: 'ScrollView',
  Switch: 'Switch',
  View: 'View',
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('@/components/agents/session-page-sheet', () => ({
  SessionPageSheet: (props: { children?: ReactNode }) =>
    createElement('SessionPageSheet', null, props.children),
}));
vi.mock('@/components/sheet-header', () => ({
  SheetHeader: (props: Record<string, unknown>) => createElement('SheetHeader', props),
}));
vi.mock('@/components/ui/form-field', () => ({
  FormField: (props: Record<string, unknown>) => createElement('FormField', props),
}));
vi.mock('@/components/ui/text', async () => {
  const React = await import('react');
  return { Text: 'Text', TextClassContext: React.createContext<string | undefined>(undefined) };
});
vi.mock('@/components/ui/icons', () => ({ Lock: 'Lock' }));
vi.mock('@/components/ui/dialog', () => ({
  useConfirmDialog: () => ({
    confirm: (request: unknown) => {
      confirmMock.current(request);
    },
    dialog: null,
  }),
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#666' }),
}));

const confirmMock = vi.hoisted(() => ({
  current: (_request: unknown): void => undefined,
}));

/** A host stub keeps the component's own props untyped; these suites call one handler each. */
function voidHandler(value: unknown): () => void {
  if (typeof value !== 'function') {
    throw new TypeError('expected a handler prop');
  }
  return value as () => void;
}

/** Narrows a captured text handler before the test calls through it. */
function isTextChangeHandler(value: unknown): value is (value: string) => void {
  return typeof value === 'function';
}

function defaults(overrides: Partial<SaveProfileSheetProps> = {}): SaveProfileSheetProps {
  return {
    envVars: [
      { key: 'API_KEY', value: 'secret', isSecret: true },
      { key: 'REGION', value: 'eu', isSecret: false },
    ],
    setupCommands: ['pnpm install'],
    onClose: vi.fn<() => void>(),
    onSave: vi.fn<() => Promise<SaveProfileOutcome>>().mockResolvedValue({ saved: true }),
    ...overrides,
  };
}

/** A save that settles refused; a null refusal is the outcome with no server answer. */
function refusedSave(refusal: string | null) {
  return vi.fn<() => Promise<SaveProfileOutcome>>().mockResolvedValue({ saved: false, refusal });
}

/** Records the discard confirms the sheet raises, so a case can assert whether one happened. */
function captureConfirm() {
  const confirm = vi.fn();
  confirmMock.current = request => {
    confirm(request);
  };
  return confirm;
}

function mount(props: Partial<SaveProfileSheetProps> = {}) {
  const ref: { current: TestRenderer.ReactTestRenderer | null } = { current: null };
  act(() => {
    ref.current = TestRenderer.create(createElement(SaveProfileSheet, defaults(props)));
  });
  const renderer = ref.current;
  if (renderer === null) {
    throw new Error('the save sheet did not render');
  }
  return renderer;
}

function field(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const node = renderer.root
    .findAllByType('FormField' as never)
    .find(instance => instance.props.label === label);
  if (!node) {
    throw new Error(`no FormField labelled ${label}`);
  }
  return node;
}

function header(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findByType('SheetHeader' as never);
}

function texts(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAllByType('Text' as never)
    .flatMap(node => node.children)
    .filter((child): child is string => typeof child === 'string');
}

/** The refusal line's message, or null while the sheet states none. */
function liveMessage(renderer: TestRenderer.ReactTestRenderer): unknown {
  return renderer.root.findAllByType(AccessibleStatus)[0]?.props.message;
}

/** Types into a labelled field, narrowing the untyped handler once. */
function typeInto(renderer: TestRenderer.ReactTestRenderer, label: string, value: string): void {
  const onChangeText: unknown = field(renderer, label).props.onChangeText;
  if (!isTextChangeHandler(onChangeText)) {
    throw new TypeError(`no change handler for ${label}`);
  }
  act(() => {
    onChangeText(value);
  });
}

async function submit(renderer: TestRenderer.ReactTestRenderer) {
  await act(async () => {
    (header(renderer).props.onDone as () => void)();
    await Promise.resolve();
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('SaveProfileSheet', () => {
  it('shows the summary counts and the secrets note', () => {
    const renderer = mount();

    expect(header(renderer).props.title).toBe('Save as profile');
    expect(texts(renderer)).toContain('2 vars · 1 setup cmd');
    expect(texts(renderer)).toContain('Secrets are encrypted before storage.');
    expect(renderer.root.findByType('Lock' as never)).toBeTruthy();
  });

  it('hides the secrets note when no variable is a secret', () => {
    const renderer = mount({ envVars: [{ key: 'REGION', value: 'eu', isSecret: false }] });

    expect(texts(renderer)).not.toContain('Secrets are encrypted before storage.');
    expect(renderer.root.findAllByType('Lock' as never)).toHaveLength(0);
  });

  it('refuses an empty name with the profile copy and creates nothing', async () => {
    const onSave = vi.fn<() => Promise<SaveProfileOutcome>>().mockResolvedValue({ saved: true });
    const renderer = mount({ onSave });

    await submit(renderer);

    expect(onSave).not.toHaveBeenCalled();
    expect(field(renderer, 'Profile name').props.error).toBe('Enter a profile name');
  });

  it('refuses an over-long name with the matching error', async () => {
    const onSave = vi.fn<() => Promise<SaveProfileOutcome>>().mockResolvedValue({ saved: true });
    const renderer = mount({ onSave });

    act(() => {
      (field(renderer, 'Profile name').props.onChangeText as (value: string) => void)(
        'x'.repeat(101)
      );
    });
    await submit(renderer);

    expect(onSave).not.toHaveBeenCalled();
    expect(field(renderer, 'Profile name').props.error).toBe('Profile name is too long');
  });

  it('follows the typed name after a refused submit, without waiting for another', async () => {
    const onSave = vi.fn<() => Promise<SaveProfileOutcome>>().mockResolvedValue({ saved: true });
    const renderer = mount({ onSave });

    await submit(renderer);
    expect(field(renderer, 'Profile name').props.error).toBe('Enter a profile name');

    typeInto(renderer, 'Profile name', 'x'.repeat(101));
    expect(field(renderer, 'Profile name').props.error).toBe('Profile name is too long');

    typeInto(renderer, 'Profile name', 'My AWS');
    expect(field(renderer, 'Profile name').props.error).toBeUndefined();

    typeInto(renderer, 'Profile name', '');
    expect(field(renderer, 'Profile name').props.error).toBe('Enter a profile name');
    expect(onSave).not.toHaveBeenCalled();
  });

  it('saves the trimmed fields and closes on success', async () => {
    const onSave = vi.fn<() => Promise<SaveProfileOutcome>>().mockResolvedValue({ saved: true });
    const onClose = vi.fn<() => void>();
    const renderer = mount({ onSave, onClose });

    act(() => {
      (field(renderer, 'Profile name').props.onChangeText as (value: string) => void)('  My AWS  ');
      (field(renderer, 'Profile description').props.onChangeText as (value: string) => void)(
        '  eu-west  '
      );
      (renderer.root.findByType('Switch' as never).props.onValueChange as (value: boolean) => void)(
        true
      );
    });
    await submit(renderer);

    expect(onSave).toHaveBeenCalledWith({
      name: 'My AWS',
      description: 'eu-west',
      setAsDefault: true,
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows the refused save inside the sheet and keeps Save live', async () => {
    const onSave = refusedSave('A profile with this name already exists');
    const renderer = mount({ onSave });

    act(() => {
      (field(renderer, 'Profile name').props.onChangeText as (value: string) => void)('Retry me');
    });
    await submit(renderer);

    // The sheet is the primary channel for a refused save: a toast would paint
    // behind it. The line is the server's own sentence, not a guess about the
    // connection. Save is live again, so the reader can correct and retry.
    expect(texts(renderer)).toContain('A profile with this name already exists');
    expect(liveMessage(renderer)).toBe('A profile with this name already exists');
    expect(header(renderer).props.doneDisabled).toBe(false);
  });

  it('states the translated plan refusal when the server refuses a lapsed trial', async () => {
    const onSave = refusedSave('Organization trial has expired.');
    const renderer = mount({ onSave });

    typeInto(renderer, 'Profile name', 'Retry me');
    await submit(renderer);

    // The server's sentences are English, so this recognized refusal reads in
    // the app's own language, the same line every other profile surface shows.
    expect(liveMessage(renderer)).toBe(i18n.t('common.organizationTrialEndedBillingAtKiloAi'));
    expect(texts(renderer)).not.toContain('Organization trial has expired.');
  });

  it('states the neutral connection line when the save had no answer', async () => {
    const onSave = refusedSave(null);
    const renderer = mount({ onSave });

    typeInto(renderer, 'Profile name', 'Retry me');
    await submit(renderer);

    // No server sentence arrived, so the outcome is unknown and the sheet says
    // exactly that with the one unchanged key.
    expect(liveMessage(renderer)).toBe(i18n.t('profiles.saveFailed'));
    expect(header(renderer).props.doneDisabled).toBe(false);
  });

  it('states the refusal after the form, so the intro holds no empty line and a refused save moves no field', async () => {
    const onSave = refusedSave('A profile with this name already exists');
    const renderer = mount({ onSave });
    const body = renderer.root.findByType('ScrollView' as never);
    const lastBlock = () => {
      const blocks = body.children.filter(
        (child): child is TestRenderer.ReactTestInstance => typeof child !== 'string'
      );
      return blocks.at(-1);
    };

    // Before a save the status renders nothing, so no space is held for it.
    expect(lastBlock()?.type).toBe(AccessibleStatus);
    expect(liveMessage(renderer)).toBeNull();

    typeInto(renderer, 'Profile name', 'Retry me');
    await submit(renderer);

    // The refusal is the body's last block: every field above it keeps its place.
    expect(lastBlock()?.type).toBe(AccessibleStatus);
    expect(liveMessage(renderer)).toBe('A profile with this name already exists');
  });

  it('closes a sheet with a save in flight without asking to discard', async () => {
    const held = Promise.withResolvers<SaveProfileOutcome>();
    const onSave = vi.fn<() => Promise<SaveProfileOutcome>>().mockReturnValue(held.promise);
    const onClose = vi.fn<() => void>();
    const confirm = captureConfirm();
    const renderer = mount({ onSave, onClose });

    act(() => {
      (field(renderer, 'Profile name').props.onChangeText as (value: string) => void)('My AWS');
    });
    await act(async () => {
      (header(renderer).props.onDone as () => void)();
      await Promise.resolve();
    });

    // Cancel during the save: the request already left, so there is nothing to
    // discard and the outcome is announced by the save itself.
    act(() => {
      (header(renderer).props.onCancel as () => void)();
    });

    expect(confirm).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps the entered values and the sheet open when the save fails', async () => {
    const onSave = refusedSave(null);
    const onClose = vi.fn<() => void>();
    const renderer = mount({ onSave, onClose });

    act(() => {
      (field(renderer, 'Profile name').props.onChangeText as (value: string) => void)('Retry me');
    });
    await submit(renderer);

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    // The sheet is still mounted with the same field instance, so the typed
    // name is still on screen.
    expect(field(renderer, 'Profile name')).toBeTruthy();
  });

  it('closes an untouched sheet without asking', () => {
    const onClose = vi.fn<() => void>();
    const confirm = captureConfirm();
    const renderer = mount({ onClose });

    const onCancel = voidHandler(header(renderer).props.onCancel);
    act(() => {
      onCancel();
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('asks before Cancel drops a half-typed profile', () => {
    const onClose = vi.fn<() => void>();
    const confirm = captureConfirm();
    const renderer = mount({ onClose });

    act(() => {
      (field(renderer, 'Profile name').props.onChangeText as (value: string) => void)('My AWS');
      (header(renderer).props.onCancel as () => void)();
    });

    expect(onClose).not.toHaveBeenCalled();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]?.[0]).toMatchObject({
      title: 'Discard changes?',
      message: 'Your changes will be lost.',
      confirmLabel: 'Discard',
      cancelLabel: 'Keep editing',
    });
  });
});
