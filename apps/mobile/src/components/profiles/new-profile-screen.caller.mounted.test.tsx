import { createElement } from 'react';
import { act, type ReactTestInstance } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { NewProfileScreen } from '@/components/profiles/new-profile-screen';
import { renderWithProviders, waitFor } from '@/test/render-with-providers';

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const createMutate = vi.hoisted(() => vi.fn());
const routerReplace = vi.hoisted(() => vi.fn());
const routerBack = vi.hoisted(() => vi.fn());
const routerCanGoBack = vi.hoisted(() => ({ value: true }));
const boundaryArgs = vi.hoisted((): { value: (string | undefined)[] } => ({ value: [] }));
const boundaryState = vi.hoisted(() => ({
  organizationId: 'org-1' as string | null,
  org: { organizationName: 'First test organization' },
  role: 'owner' as string | undefined,
  isResolving: false,
}));
const mutationState = vi.hoisted(() => ({
  create: { mutateAsync: createMutate, isPending: false },
}));
// The guard's own surface: the flag and handler it registers, the confirmation
// it would raise, and the flag each leave saw when it was dispatched.
const guard = vi.hoisted(() => ({
  enabled: false,
  handler: undefined as
    | ((options: { data: { action: { type: string } }; repeat: () => void }) => void)
    | undefined,
  confirm: vi.fn(),
  repeat: vi.fn(),
  repeatSawEnabled: [] as boolean[],
  backSawEnabled: [] as boolean[],
  replaceSawEnabled: [] as boolean[],
}));

vi.mock('@/lib/hooks/use-agent-profiles', () => ({
  useAgentProfileMutations: () => mutationState,
}));
vi.mock('sonner-native', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('expo-router', () => ({
  usePreventRemove: (
    enabled: boolean,
    handler: (options: { data: { action: { type: string } }; repeat: () => void }) => void
  ) => {
    guard.enabled = enabled;
    guard.handler = handler;
  },
  useRouter: () => ({
    replace: routerReplace,
    back: routerBack,
    canGoBack: () => routerCanGoBack.value,
  }),
}));
// The Android-safe replace is the screen's post-save exit
// (`lib/navigation/stack-safe-replace.ts`). Its own mechanics have a suite; here
// it stands in for the navigation call, so the asserted href is the
// destination's.
vi.mock('@/lib/navigation/stack-safe-replace', () => ({
  useStackSafeReplace: () => ({ replace: routerReplace }),
}));
vi.mock('@/components/ui/dialog', () => ({
  useConfirmDialog: () => ({ confirm: guard.confirm, dialog: null }),
}));
vi.mock('@/lib/hooks/use-organization-queries', () => ({
  useOrgBoundary: (organizationId?: string) => {
    boundaryArgs.value.push(organizationId);
    return boundaryState;
  },
}));
vi.mock('react-native', () => ({ View: 'View', ScrollView: 'ScrollView' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: () => null }));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'ScrollView' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/form-field', () => ({ FormField: 'FormField' }));
vi.mock('@/components/ui/accessible-status', () => ({
  AccessibleStatus: 'AccessibleStatus',
}));
vi.mock('@/components/ui/segmented-control', () => ({ SegmentedControl: 'SegmentedControl' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

// ── Helpers ────────────────────────────────────────────────────────────────

function findAll(root: ReactTestInstance, type: string): ReactTestInstance[] {
  return root.findAll(node => typeof node.type === 'string' && node.type === type);
}

function typeName(root: ReactTestInstance, name: string): void {
  const field = findAll(root, 'FormField').find(node => node.props.label === 'Profile name');
  if (!field) {
    throw new Error('profile name field was not rendered');
  }
  act(() => {
    (field.props as { onChangeText: (value: string) => void }).onChangeText(name);
  });
}

function mount(props: {
  initialOwner?: 'personal' | 'organization';
  returnToCaller?: boolean;
  organizationId?: string;
}) {
  return renderWithProviders(createElement(NewProfileScreen, { stack: 'app', ...props }));
}

async function pressCreate(root: ReactTestInstance): Promise<void> {
  const [button] = findAll(root, 'Button');
  if (!button) {
    throw new Error('create button was not rendered');
  }
  await act(async () => {
    (button.props as { onPress: () => void }).onPress();
    await Promise.resolve();
  });
}

/** Hand the guard the removal the navigator produces for a Back press. */
function pressBack(): void {
  const handler = guard.handler;
  if (!handler) {
    throw new Error('the leave guard did not register a removal handler');
  }
  act(() => {
    handler({
      data: { action: { type: 'GO_BACK' } },
      repeat: () => {
        guard.repeatSawEnabled.push(guard.enabled);
        guard.repeat();
      },
    });
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('NewProfileScreen caller request', () => {
  beforeEach(() => {
    createMutate.mockReset();
    routerReplace.mockReset();
    routerBack.mockReset();
    guard.confirm.mockReset();
    guard.repeat.mockReset();
    guard.repeatSawEnabled = [];
    guard.backSawEnabled = [];
    guard.replaceSawEnabled = [];
    guard.enabled = false;
    guard.handler = undefined;
    routerBack.mockImplementation(() => {
      guard.backSawEnabled.push(guard.enabled);
    });
    routerReplace.mockImplementation(() => {
      guard.replaceSawEnabled.push(guard.enabled);
    });
    routerCanGoBack.value = true;
    createMutate.mockResolvedValue({ id: 'profile-1' });
    mutationState.create.isPending = false;
    boundaryState.organizationId = 'org-1';
    boundaryState.role = 'owner';
    boundaryState.org = { organizationName: 'First test organization' };
    boundaryState.isResolving = false;
  });

  it('starts on the owner its caller asked for and hands the form back on save', async () => {
    const { renderer, unmount } = await mount({
      initialOwner: 'organization',
      returnToCaller: true,
    });

    expect(findAll(renderer.root, 'SegmentedControl')[0]?.props.value).toBe('organization');

    typeName(renderer.root, 'Org profile');
    await pressCreate(renderer.root);

    await waitFor(() => createMutate.mock.calls.length > 0);
    expect(createMutate.mock.calls[0]?.[0]).toEqual({
      name: 'Org profile',
      organizationId: 'org-1',
    });
    // The leave waits one task behind the guard's disarm render, so the pop is
    // dispatched in a macrotask of its own.
    await waitFor(() => routerBack.mock.calls.length > 0);
    expect(routerBack).toHaveBeenCalledOnce();
    expect(routerReplace).not.toHaveBeenCalled();

    unmount();
  });

  it('opens the new profile when the caller has no screen to return to', async () => {
    routerCanGoBack.value = false;
    const { renderer, unmount } = await mount({
      initialOwner: 'organization',
      returnToCaller: true,
    });

    typeName(renderer.root, 'Org profile');
    await pressCreate(renderer.root);

    await waitFor(() => createMutate.mock.calls.length > 0);
    await waitFor(() => routerReplace.mock.calls.length > 0);
    expect(routerBack).not.toHaveBeenCalled();
    expect(routerReplace).toHaveBeenCalledWith(
      '/(app)/profile-management/profile-1?organizationId=org-1'
    );

    unmount();
  });

  it('keeps the overview when no caller asked for the form back', async () => {
    const { renderer, unmount } = await mount({ initialOwner: 'organization' });

    typeName(renderer.root, 'Org profile');
    await pressCreate(renderer.root);

    await waitFor(() => createMutate.mock.calls.length > 0);
    await waitFor(() => routerReplace.mock.calls.length > 0);
    expect(routerBack).not.toHaveBeenCalled();
    expect(routerReplace).toHaveBeenCalledWith(
      '/(app)/profile-management/profile-1?organizationId=org-1'
    );

    unmount();
  });

  it('resolves its organization from the caller, not the active account', async () => {
    boundaryArgs.value = [];
    const { unmount } = await mount({
      initialOwner: 'organization',
      returnToCaller: true,
      organizationId: 'org-2',
    });

    expect(boundaryArgs.value).toContain('org-2');

    unmount();
  });

  it('a member asked for organization ownership still only creates a personal profile', async () => {
    boundaryState.role = 'member';
    const { renderer, unmount } = await mount({
      initialOwner: 'organization',
      returnToCaller: true,
    });

    expect(findAll(renderer.root, 'SegmentedControl')).toHaveLength(0);

    typeName(renderer.root, 'Backend debugging');
    await pressCreate(renderer.root);

    await waitFor(() => createMutate.mock.calls.length > 0);
    expect(createMutate.mock.calls[0]?.[0]).toEqual({ name: 'Backend debugging' });

    unmount();
  });

  it('drops Back while the create is in flight and raises no prompt', async () => {
    mutationState.create.isPending = true;
    const { renderer, unmount } = await mount({ returnToCaller: true });

    expect(guard.enabled).toBe(true);

    pressBack();

    expect(guard.repeat).not.toHaveBeenCalled();
    expect(guard.confirm).not.toHaveBeenCalled();
    expect(guard.enabled).toBe(true);
    // The reader is still on the form the write belongs to.
    expect(findAll(renderer.root, 'FormField')).not.toHaveLength(0);

    unmount();
  });

  it('leaves on Back when no create is in flight', async () => {
    const { unmount } = await mount({ returnToCaller: true });

    expect(guard.enabled).toBe(false);

    pressBack();

    expect(guard.confirm).not.toHaveBeenCalled();
    expect(guard.repeat).toHaveBeenCalledTimes(1);
    expect(guard.repeatSawEnabled).toEqual([false]);

    unmount();
  });

  // The hand-back is a leave the guard speaks for: the caller's form is popped
  // only after the disarm render, so the navigator sees a plain pop.
  it('hands the form back through the guard, disarmed before the pop', async () => {
    mutationState.create.isPending = true;
    const { renderer, unmount } = await mount({ returnToCaller: true });
    expect(guard.enabled).toBe(true);

    typeName(renderer.root, 'Backend debugging');
    await pressCreate(renderer.root);
    await waitFor(() => routerBack.mock.calls.length === 1);

    expect(guard.backSawEnabled).toEqual([false]);
    expect(guard.confirm).not.toHaveBeenCalled();
    await waitFor(() => !guard.enabled);

    unmount();
  });
});
