import { QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { act, type ReactTestInstance } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { NewProfileScreen } from '@/components/profiles/new-profile-screen';
import { renderWithProviders, waitFor } from '@/test/render-with-providers';

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const createMutate = vi.hoisted(() => vi.fn());
const toastSuccess = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
const routerReplace = vi.hoisted(() => vi.fn());
const boundaryState = vi.hoisted(() => ({
  organizationId: 'org-1' as string | null,
  org: { organizationName: 'First test organization' },
  role: 'owner' as string | undefined,
  isResolving: false,
}));
const mutationState = vi.hoisted(() => ({
  create: { mutateAsync: createMutate, isPending: false },
}));

vi.mock('@/lib/hooks/use-agent-profiles', () => ({
  useAgentProfileMutations: () => mutationState,
}));

vi.mock('sonner-native', () => ({
  toast: { success: toastSuccess, error: toastError },
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ replace: routerReplace }),
}));

vi.mock('@/lib/hooks/use-organization-queries', () => ({
  useOrgBoundary: () => boundaryState,
}));

vi.mock('@/lib/profile-agent-navigation', () => ({
  getProfileOverviewPath: (profileId: string, organizationId?: string) =>
    organizationId ? `/profiles/${profileId}?org=${organizationId}` : `/profiles/${profileId}`,
}));

vi.mock('react-native', () => ({
  View: 'View',
  ScrollView: 'ScrollView',
}));

vi.mock('@/components/screen-header', () => ({ ScreenHeader: () => null }));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'ScrollView' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/form-field', () => ({ FormField: 'FormField' }));
vi.mock('@/components/ui/segmented-control', () => ({ SegmentedControl: 'SegmentedControl' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

// ── Helpers ────────────────────────────────────────────────────────────────

function findAll(root: ReactTestInstance, type: string): ReactTestInstance[] {
  return root.findAll(node => typeof node.type === 'string' && node.type === type);
}

function findField(root: ReactTestInstance, label: string): ReactTestInstance {
  const field = findAll(root, 'FormField').find(node => node.props.label === label);
  if (!field) {
    throw new Error(`field ${label} was not rendered`);
  }
  return field;
}

function findOwnerControl(root: ReactTestInstance): ReactTestInstance {
  const control = findAll(root, 'SegmentedControl')[0];
  if (!control) {
    throw new Error('owner control was not rendered');
  }
  return control;
}

function typeName(root: ReactTestInstance, name: string): void {
  act(() => {
    (findField(root, 'Profile name').props as { onChangeText: (v: string) => void }).onChangeText(
      name
    );
  });
}

async function mount() {
  const result = await renderWithProviders(createElement(NewProfileScreen));
  const rerender = () => {
    act(() => {
      result.renderer.update(
        createElement(
          QueryClientProvider,
          { client: result.queryClient },
          createElement(NewProfileScreen)
        )
      );
    });
  };
  return { ...result, rerender };
}

async function pressCreate(root: ReactTestInstance): Promise<void> {
  const button = findAll(root, 'Button')[0];
  if (!button) {
    throw new Error('create button was not rendered');
  }
  await act(async () => {
    (button.props as { onPress: () => void }).onPress();
    await Promise.resolve();
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('NewProfileScreen', () => {
  beforeEach(() => {
    createMutate.mockReset();
    toastSuccess.mockReset();
    toastError.mockReset();
    routerReplace.mockReset();
    createMutate.mockResolvedValue({ id: 'profile-1' });
    boundaryState.organizationId = 'org-1';
    boundaryState.role = 'owner';
    boundaryState.org = { organizationName: 'First test organization' };
    boundaryState.isResolving = false;
    mutationState.create.isPending = false;
  });

  it('validates each name edit after the first submit and blocks invalid submissions', async () => {
    const { renderer, unmount } = await mount();
    const nameError = () => findField(renderer.root, 'Profile name').props.error;

    expect(nameError()).toBeUndefined();
    await pressCreate(renderer.root);
    expect(nameError()).toBe('Enter a profile name');
    expect(createMutate).not.toHaveBeenCalled();

    typeName(renderer.root, 'x'.repeat(191));
    expect(nameError()).toBe('Profile name is too long');
    await pressCreate(renderer.root);
    expect(createMutate).not.toHaveBeenCalled();

    typeName(renderer.root, `  ${'x'.repeat(100)}  `);
    expect(nameError()).toBeUndefined();

    typeName(renderer.root, 'x'.repeat(101));
    expect(nameError()).toBe('Profile name is too long');
    await pressCreate(renderer.root);
    expect(createMutate).not.toHaveBeenCalled();

    typeName(renderer.root, '   ');
    expect(nameError()).toBe('Enter a profile name');
    await pressCreate(renderer.root);
    expect(createMutate).not.toHaveBeenCalled();

    unmount();
  });

  it('happy: a personal create toasts and replaces to the overview', async () => {
    const { renderer, unmount } = await mount();

    typeName(renderer.root, 'Backend debugging');
    await pressCreate(renderer.root);

    await waitFor(() => createMutate.mock.calls.length > 0);
    expect(createMutate.mock.calls[0]?.[0]).toEqual({ name: 'Backend debugging' });
    await waitFor(() => toastSuccess.mock.calls.length > 0);
    expect(toastSuccess).toHaveBeenCalledWith('Profile "Backend debugging" created');
    expect(routerReplace).toHaveBeenCalledWith('/profiles/profile-1');

    unmount();
  });

  it.each(['owner', 'admin'])(
    'happy: %s choosing Organization carries the organization id into the create',
    async role => {
      boundaryState.role = role;
      const { renderer, unmount } = await mount();

      act(() => {
        (findOwnerControl(renderer.root).props as { onChange: (v: string) => void }).onChange(
          'organization'
        );
      });
      typeName(renderer.root, 'Org profile');
      await pressCreate(renderer.root);

      await waitFor(() => createMutate.mock.calls.length > 0);
      expect(createMutate.mock.calls[0]?.[0]).toEqual({
        name: 'Org profile',
        organizationId: 'org-1',
      });
      expect(routerReplace).toHaveBeenCalledWith('/profiles/profile-1?org=org-1');

      unmount();
    }
  );

  it('shows only the selected organization context and resets it when the boundary changes', async () => {
    const { renderer, rerender, unmount } = await mount();
    const visibleText = () =>
      findAll(renderer.root, 'Text').map(node => String(node.props.children));
    const selectOwner = (owner: string) => {
      act(() => {
        const props = findOwnerControl(renderer.root).props as {
          onChange: (value: string) => void;
        };
        props.onChange(owner);
      });
    };

    expect(visibleText()).not.toContain('First test organization');
    selectOwner('organization');
    expect(visibleText()).toContain('First test organization');

    selectOwner('personal');
    expect(visibleText()).not.toContain('First test organization');

    selectOwner('organization');
    boundaryState.organizationId = 'org-2';
    boundaryState.org = { organizationName: 'Second test organization' };
    rerender();

    expect(findOwnerControl(renderer.root).props.value).toBe('personal');
    expect(visibleText()).not.toContain('First test organization');
    expect(visibleText()).not.toContain('Second test organization');
    typeName(renderer.root, 'New organization profile');
    await pressCreate(renderer.root);
    expect(createMutate.mock.calls[0]?.[0]).toEqual({ name: 'New organization profile' });
    createMutate.mockClear();

    selectOwner('organization');
    expect(visibleText()).toContain('Second test organization');
    expect(visibleText()).not.toContain('First test organization');

    await pressCreate(renderer.root);
    await waitFor(() => createMutate.mock.calls.length > 0);
    expect(createMutate.mock.calls[0]?.[0]).toEqual({
      name: 'New organization profile',
      organizationId: 'org-2',
    });

    unmount();
  });

  it('personal context: renders no owner control', async () => {
    boundaryState.organizationId = null;
    const { renderer, unmount } = await mount();

    expect(findAll(renderer.root, 'SegmentedControl')).toHaveLength(0);

    unmount();
  });

  it.each(['member', 'billing_manager'])(
    'does not offer organization ownership to a %s and still creates personal profiles',
    async role => {
      boundaryState.role = role;
      const { renderer, unmount } = await mount();

      expect(findAll(renderer.root, 'SegmentedControl')).toHaveLength(0);

      typeName(renderer.root, 'Backend debugging');
      await pressCreate(renderer.root);

      await waitFor(() => createMutate.mock.calls.length > 0);
      expect(createMutate.mock.calls[0]?.[0]).toEqual({ name: 'Backend debugging' });
      expect(routerReplace).toHaveBeenCalledWith('/profiles/profile-1');

      unmount();
    }
  );

  it.each([
    { name: 'unresolved membership', isResolving: true, role: undefined },
    { name: 'unresolved membership with a cached role', isResolving: true, role: 'owner' },
    { name: 'missing membership', isResolving: false, role: undefined },
  ])(
    'does not offer organization ownership for $name and still creates personal profiles',
    async ({ isResolving, role }) => {
      boundaryState.isResolving = isResolving;
      boundaryState.role = role;
      const { renderer, unmount } = await mount();

      expect(findAll(renderer.root, 'SegmentedControl')).toHaveLength(0);

      typeName(renderer.root, 'Backend debugging');
      await pressCreate(renderer.root);

      await waitFor(() => createMutate.mock.calls.length > 0);
      expect(createMutate.mock.calls[0]?.[0]).toEqual({ name: 'Backend debugging' });
      expect(routerReplace).toHaveBeenCalledWith('/profiles/profile-1');

      unmount();
    }
  );

  it('stale role: a selected organization cannot submit after the role drops', async () => {
    const { renderer, rerender, unmount } = await mount();

    act(() => {
      (findOwnerControl(renderer.root).props as { onChange: (v: string) => void }).onChange(
        'organization'
      );
    });

    boundaryState.role = 'member';
    rerender();

    expect(findAll(renderer.root, 'SegmentedControl')).toHaveLength(0);
    typeName(renderer.root, 'Backend debugging');
    await pressCreate(renderer.root);

    await waitFor(() => createMutate.mock.calls.length > 0);
    expect(createMutate.mock.calls[0]?.[0]).toEqual({ name: 'Backend debugging' });
    expect(routerReplace).toHaveBeenCalledWith('/profiles/profile-1');

    unmount();
  });

  it('layout stability: switching owner keeps the typed name', async () => {
    const { renderer, unmount } = await mount();

    typeName(renderer.root, 'Backend debugging');
    act(() => {
      (findOwnerControl(renderer.root).props as { onChange: (v: string) => void }).onChange(
        'organization'
      );
    });
    await pressCreate(renderer.root);

    await waitFor(() => createMutate.mock.calls.length > 0);
    expect(createMutate.mock.calls[0]?.[0]).toEqual({
      name: 'Backend debugging',
      organizationId: 'org-1',
    });

    unmount();
  });

  it('retryable: a failed create falls back to createFailed when the error has no message', async () => {
    const errorWithoutMessage = new Error('placeholder');
    errorWithoutMessage.message = '';
    createMutate.mockRejectedValue(errorWithoutMessage);
    const { renderer, unmount } = await mount();

    typeName(renderer.root, 'Backend debugging');
    await pressCreate(renderer.root);

    await waitFor(() => toastError.mock.calls.length > 0);
    expect(toastError).toHaveBeenCalledWith("Couldn't create profile");
    expect(routerReplace).not.toHaveBeenCalled();

    unmount();
  });

  it('retryable: keeps the hook message and the typed name on a failed create', async () => {
    createMutate.mockRejectedValue(new Error('A profile with that name already exists'));
    const { renderer, unmount } = await mount();

    typeName(renderer.root, 'Backend debugging');
    await pressCreate(renderer.root);

    await waitFor(() => createMutate.mock.calls.length > 0);
    // The mutation hook owns the server-message toast; the screen adds none.
    expect(toastError).not.toHaveBeenCalled();
    expect(findField(renderer.root, 'Profile name').props.error).toBeUndefined();
    expect(routerReplace).not.toHaveBeenCalled();

    unmount();
  });
});
