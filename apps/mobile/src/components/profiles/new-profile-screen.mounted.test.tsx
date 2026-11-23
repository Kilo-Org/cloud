import { beforeEach, describe, expect, it } from 'vitest';

import {
  boundaryState,
  createMutate,
  findAll,
  findField,
  findOwnerControl,
  mount,
  pressCreate,
  resetNewProfileState,
  routerReplace,
  toastError,
  toastSuccess,
  typeName,
} from '@/components/profiles/new-profile-screen.mounted.test-helpers';
import { act } from '@/test/renderer';
import { waitFor } from '@/test/render-with-providers';

// ── Tests ──────────────────────────────────────────────────────────────────

describe('NewProfileScreen', () => {
  beforeEach(resetNewProfileState);

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

  it.each(['owner', 'admin'])(
    'does not offer organization ownership to an %s of an ended-plan organization, and creates personal profiles only',
    async role => {
      boundaryState.role = role;
      boundaryState.org = {
        organizationName: 'First test organization',
        isTrialExpiredForEnforcement: true,
      };
      const { renderer, unmount } = await mount();

      // The plan gate refuses every organization create from this manager, so
      // the choice would be a dead end; Personal stays available.
      expect(findAll(renderer.root, 'SegmentedControl')).toHaveLength(0);

      typeName(renderer.root, 'Backend debugging');
      await pressCreate(renderer.root);

      await waitFor(() => createMutate.mock.calls.length > 0);
      expect(createMutate.mock.calls[0]?.[0]).toEqual({ name: 'Backend debugging' });
      expect(routerReplace).toHaveBeenCalledWith('/profiles/profile-1');

      unmount();
    }
  );

  it('offers organization ownership to a manager of an organization whose plan is live', async () => {
    boundaryState.role = 'admin';
    boundaryState.org = {
      organizationName: 'First test organization',
      isTrialExpiredForEnforcement: false,
    };
    const { renderer, unmount } = await mount();

    const control = findOwnerControl(renderer.root);
    expect(control.props.options).toEqual([
      { value: 'personal', label: 'Personal' },
      { value: 'organization', label: 'Organization' },
    ]);

    // The test renderer hands element props back untyped; this one control's
    // handler is the only field the case drives.
    const ownerControlProps = control.props as { onChange: (value: string) => void };
    act(() => {
      ownerControlProps.onChange('organization');
    });
    typeName(renderer.root, 'Org profile');
    await pressCreate(renderer.root);

    await waitFor(() => createMutate.mock.calls.length > 0);
    expect(createMutate.mock.calls[0]?.[0]).toEqual({
      name: 'Org profile',
      organizationId: 'org-1',
    });

    unmount();
  });

  it('keeps offering organization ownership when the membership row has no plan verdict', async () => {
    boundaryState.role = 'owner';
    boundaryState.org = { organizationName: 'First test organization' };
    const { renderer, unmount } = await mount();

    // An organization row written before the field existed says nothing about
    // the plan, and an unknown plan is not a lapsed one.
    expect(findAll(renderer.root, 'SegmentedControl')).toHaveLength(1);

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
