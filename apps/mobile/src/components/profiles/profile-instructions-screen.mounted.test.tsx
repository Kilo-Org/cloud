import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { ProfileInstructionsScreen } from '@/components/profiles/profile-instructions-screen';
import { isolateLtrBidiText } from '@/lib/bidi';
import { act, type ReactTestInstance } from '@/test/renderer';
import { renderWithProviders, waitFor } from '@/test/render-with-providers';

const h = vi.hoisted(() => ({
  confirm: vi.fn(),
  error: vi.fn(),
  query: {
    data: undefined as unknown,
    isError: false,
    isPending: true,
    isRefetching: false,
    refetch: vi.fn(),
  },
  mutations: {
    createInstruction: { mutateAsync: vi.fn(), isPending: false },
    updateInstruction: { mutateAsync: vi.fn(), isPending: false },
    deleteInstruction: { mutateAsync: vi.fn(), isPending: false },
    setInstructionEnabled: { mutate: vi.fn(), isPending: false },
  },
}));

vi.mock('@/lib/hooks/use-can-manage-profiles', () => ({
  useCanManageOrganizationProfiles: () => true,
}));
vi.mock('@/lib/hooks/use-agent-profiles', () => ({
  useAgentProfileInstructions: () => h.query,
  useAgentProfileOverview: () => ({ data: { name: 'Team profile' }, isPending: false }),
}));
vi.mock('@/lib/hooks/use-agent-profile-instruction-mutations', () => ({
  useAgentProfileInstructionMutations: () => h.mutations,
}));
vi.mock('sonner-native', () => ({ toast: { error: h.error } }));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  View: 'View',
  Pressable: 'Pressable',
  Switch: 'Switch',
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
const THEME = vi.hoisted(() => ({
  foreground: '#0E0E10',
  mutedForeground: '#6B6B6B',
  destructive: '#FF0000',
  mutedSoft: '#A9A39A',
  primary: '#4F5A10',
  primaryForeground: '#FFFFFF',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => THEME,
}));
vi.mock('@/components/ui/dialog', () => ({
  useConfirmDialog: () => ({ confirm: h.confirm, dialog: null }),
}));
vi.mock('@/components/ui/icons', () => ({
  FileText: 'FileText',
  Pencil: 'Pencil',
  Trash2: 'Trash2',
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/switch', () => ({ Switch: 'Switch' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/accessible-status', () => ({ AccessibleStatus: 'AccessibleStatus' }));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'TabScrollView' }));
vi.mock('@/components/profiles/profile-section-header', () => ({
  ProfileSectionHeader: 'ProfileSectionHeader',
}));
vi.mock('@/components/profiles/instruction-form-sheet', () => ({
  InstructionFormSheet: 'InstructionFormSheet',
}));

/** The name the fixture row holds; the dialog must isolate exactly this run. */
const INSTRUCTION_NAME = 'zalgo-2026';

type TestInstruction = { id: string; name: string; content: string; enabled: boolean };

function testInstruction(overrides: Partial<TestInstruction> = {}): TestInstruction {
  return {
    id: 'inst-1',
    name: INSTRUCTION_NAME,
    content: '# Rules',
    enabled: true,
    ...overrides,
  };
}

/** The confirm sheet's request, as the screen hands it to `useConfirmDialog`. */
type ConfirmRequest = {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
};

/**
 * A refusal the server sent with no reason the reader can act on. The screen's
 * `hasUsableMessage` reads a blank message as unusable, which is the case where
 * the screen owns the toast instead of the mutation hook.
 */
function messageLessRefusal(): Error {
  const error = new Error('Server refused the delete');
  error.message = '';
  return error;
}

function findAll(root: ReactTestInstance, type: string): ReactTestInstance[] {
  return root.findAll(node => typeof node.type === 'string' && node.type === type);
}

/** The row control whose accessibility label starts with `prefix`, untyped through the host. */
function findRowControl(root: ReactTestInstance, prefix: string): ReactTestInstance {
  const control = findAll(root, 'Pressable').find(node =>
    String(node.props.accessibilityLabel).startsWith(prefix)
  );
  if (!control) {
    throw new TypeError(`row control ${prefix} was not rendered`);
  }
  return control;
}

function pressRowControl(root: ReactTestInstance, prefix: string): void {
  const press = findRowControl(root, prefix).props.onPress;
  if (typeof press !== 'function') {
    throw new TypeError(`row control ${prefix} has no press handler`);
  }
  act(() => {
    (press as () => void)();
  });
}

/** Press the row's Delete control and return the request it raised. */
function pressDelete(root: ReactTestInstance): ConfirmRequest {
  pressRowControl(root, i18n.t('profiles.instructionDelete', { name: INSTRUCTION_NAME }));
  return confirmRequest();
}

function confirmRequest(): ConfirmRequest {
  const request = h.confirm.mock.calls[0]?.[0] as ConfirmRequest | undefined;
  if (!request) {
    throw new Error('the screen asked for no confirmation');
  }
  return request;
}

// eslint-disable-next-line typescript-eslint/promise-function-async -- returning the harness promise unchanged
function mountScreen() {
  return renderWithProviders(createElement(ProfileInstructionsScreen, { profileId: 'profile-1' }));
}

/**
 * Accept the confirm sheet's request and let the delete it starts settle. The
 * screen's `runDelete` awaits the mutation, so its catch runs a microtask after
 * the press; no timer is involved.
 */
async function confirmRequestAndSettle(request: ConfirmRequest): Promise<void> {
  await act(async () => {
    request.onConfirm();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function rowControls(root: ReactTestInstance): string[] {
  return findAll(root, 'Pressable').map(node => String(node.props.accessibilityLabel));
}

describe('ProfileInstructionsScreen delete confirmation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.query.data = [testInstruction()];
    h.query.isError = false;
    h.query.isPending = false;
    h.query.isRefetching = false;
    h.mutations.deleteInstruction.mutateAsync.mockReset();
    h.mutations.deleteInstruction.mutateAsync.mockResolvedValue({ success: true });
    h.mutations.setInstructionEnabled.mutate.mockReset();
  });

  // The dialog used to ask "Delete <name>" twice: a title and a label both read
  // `common.delete`, with the file name as the whole message, so the reader was
  // never told what deleting the file would do.
  it('asks for consent with the file name in the title and states the consequence', async () => {
    const { renderer, unmount } = await mountScreen();

    const request = pressDelete(renderer.root);

    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(request).toMatchObject({
      title: i18n.t('profiles.instructionDeleteTitle', {
        name: isolateLtrBidiText(INSTRUCTION_NAME),
      }),
      message: i18n.t('profiles.instructionDeleteMessage'),
      confirmLabel: i18n.t('profiles.instructionDeleteConfirm'),
    });
    expect(request.confirmLabel).not.toBe(i18n.t('common.delete'));
    expect(request.title).not.toBe(request.message);
    expect(request.title).not.toBe(INSTRUCTION_NAME);
    expect(request.message).not.toBe(INSTRUCTION_NAME);

    unmount();
  });

  // A rules file name is compared character by character, so a right-to-left
  // sentence must not reorder it: one explicit left-to-right run, no more.
  it('keeps the file name in exactly one left-to-right isolate pair', async () => {
    const { renderer, unmount } = await mountScreen();

    const { title } = pressDelete(renderer.root);

    expect(title).toContain(`\u2066${INSTRUCTION_NAME}\u2069`);
    expect(title.split('\u2066')).toHaveLength(2);
    expect(title.split('\u2069')).toHaveLength(2);

    unmount();
  });

  it('deletes nothing until the reader confirms, then deletes that row', async () => {
    const { renderer, unmount } = await mountScreen();

    const request = pressDelete(renderer.root);

    expect(h.mutations.deleteInstruction.mutateAsync).not.toHaveBeenCalled();

    await confirmRequestAndSettle(request);

    expect(h.mutations.deleteInstruction.mutateAsync).toHaveBeenCalledTimes(1);
    expect(h.mutations.deleteInstruction.mutateAsync).toHaveBeenCalledWith({
      profileId: 'profile-1',
      instructionId: 'inst-1',
    });

    unmount();
  });

  it('leaves the row in place and stays quiet when the server sends a readable refusal', async () => {
    h.mutations.deleteInstruction.mutateAsync.mockRejectedValue(
      new Error('This instruction is still used by an active session')
    );
    const { renderer, unmount } = await mountScreen();

    const request = pressDelete(renderer.root);
    await confirmRequestAndSettle(request);

    expect(h.mutations.deleteInstruction.mutateAsync).toHaveBeenCalledTimes(1);
    // The mutation hook owns the toast for a message the reader can act on.
    expect(h.error).not.toHaveBeenCalled();
    expect(rowControls(renderer.root)).toContain(
      i18n.t('profiles.instructionDelete', { name: INSTRUCTION_NAME })
    );
    expect(findAll(renderer.root, 'Switch')).toHaveLength(1);

    unmount();
  });

  // The hook toasts the server's message; when it sent nothing readable the
  // screen is the only place that can tell the reader the delete failed.
  it('toasts the fallback message when the server refuses without a readable reason', async () => {
    h.mutations.deleteInstruction.mutateAsync.mockRejectedValue(messageLessRefusal());
    const { renderer, unmount } = await mountScreen();

    const request = pressDelete(renderer.root);
    await confirmRequestAndSettle(request);

    await waitFor(() => h.error.mock.calls.length === 1);
    expect(h.error).toHaveBeenCalledWith(i18n.t('profiles.instructionDeleteFailed'));
    expect(rowControls(renderer.root)).toContain(
      i18n.t('profiles.instructionDelete', { name: INSTRUCTION_NAME })
    );

    unmount();
  });
});
