/* eslint-disable max-lines -- mounted hook integration; the read, mutation, and optimistic contracts exceed the default line limit */
import { createElement } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { act } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestQueryClient, renderWithProviders, waitFor } from '@/test/render-with-providers';
import {
  type AgentProfileListItem,
  useAgentProfile,
  useAgentProfileList,
  useAgentProfileMutations,
} from '@/lib/hooks/use-agent-profiles';

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  queries: {
    list: vi.fn(),
    listCombined: vi.fn(),
    get: vi.fn(),
  },
  queryInputs: {
    list: undefined as unknown,
    listCombined: undefined as unknown,
    get: undefined as unknown,
  },
  mutations: {
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    setAsDefault: vi.fn(),
    clearDefault: vi.fn(),
    setVar: vi.fn(),
    deleteVar: vi.fn(),
    setCommands: vi.fn(),
    createCustomSkill: vi.fn(),
    updateSkill: vi.fn(),
    deleteSkill: vi.fn(),
    setSkillEnabled: vi.fn(),
  },
  toastError: vi.fn(),
}));

vi.mock('@/lib/trpc', () => {
  function queryProcedure(name: keyof typeof mocks.queries, path: string) {
    return {
      pathFilter: () => ({ queryKey: ['agentProfiles', path] }),
      queryKey: (input: unknown) => ['agentProfiles', path, input],
      queryOptions: (input: unknown) => {
        mocks.queryInputs[name] = input;
        return {
          queryKey: ['agentProfiles', path, input],
          queryFn: () => mocks.queries[name](),
        };
      },
    };
  }
  function mutationProcedure(name: keyof typeof mocks.mutations, path: string) {
    return {
      pathFilter: () => ({ queryKey: ['agentProfiles', path] }),
      mutationOptions: (options: Record<string, unknown>) => ({
        ...options,
        mutationKey: ['agentProfiles', path],
        mutationFn: (input: unknown) => mocks.mutations[name](input),
      }),
    };
  }
  const trpc = {
    agentProfiles: {
      pathFilter: () => ({ queryKey: ['agentProfiles'] }),
      list: queryProcedure('list', 'list'),
      listCombined: queryProcedure('listCombined', 'listCombined'),
      get: queryProcedure('get', 'get'),
      create: mutationProcedure('create', 'create'),
      update: mutationProcedure('update', 'update'),
      delete: mutationProcedure('delete', 'delete'),
      setAsDefault: mutationProcedure('setAsDefault', 'setAsDefault'),
      clearDefault: mutationProcedure('clearDefault', 'clearDefault'),
      setVar: mutationProcedure('setVar', 'setVar'),
      deleteVar: mutationProcedure('deleteVar', 'deleteVar'),
      setCommands: mutationProcedure('setCommands', 'setCommands'),
      createCustomSkill: mutationProcedure('createCustomSkill', 'createCustomSkill'),
      updateSkill: mutationProcedure('updateSkill', 'updateSkill'),
      deleteSkill: mutationProcedure('deleteSkill', 'deleteSkill'),
      setSkillEnabled: mutationProcedure('setSkillEnabled', 'setSkillEnabled'),
    },
  };
  return { useTRPC: () => trpc };
});

vi.mock('sonner-native', () => ({ toast: { error: mocks.toastError } }));

// ── Helpers ────────────────────────────────────────────────────────────────

function summary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'profile-1',
    name: 'Profile',
    description: null,
    isDefault: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    varCount: 0,
    commandCount: 0,
    mcpServerCount: 0,
    skillCount: 0,
    agentCount: 0,
    kiloCommandCount: 0,
    ...overrides,
  };
}

type ListResult = ReturnType<typeof useAgentProfileList>;
type MutationsResult = ReturnType<typeof useAgentProfileMutations>;

function ListProbe({
  holder,
  organizationId,
}: {
  holder: { current: ListResult | null };
  organizationId?: string;
}) {
  holder.current = useAgentProfileList(organizationId);
  return null;
}

function MutationsProbe({
  holder,
  organizationId,
}: {
  holder: { current: MutationsResult | null };
  organizationId?: string;
}) {
  holder.current = useAgentProfileMutations(organizationId);
  return null;
}

function ProfileProbe({
  holder,
  profileId,
  organizationId,
}: {
  holder: { current: ReturnType<typeof useAgentProfile> | null };
  profileId: string;
  organizationId?: string;
}) {
  holder.current = useAgentProfile(profileId, organizationId);
  return null;
}

function current<T>(holder: { current: T | null }): T {
  const result = holder.current;
  if (!result) {
    throw new Error('probe did not render');
  }
  return result;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('useAgentProfileList', () => {
  beforeEach(() => {
    mocks.queries.list.mockReset().mockResolvedValue([]);
    mocks.queries.listCombined.mockReset().mockResolvedValue({
      orgProfiles: [],
      personalProfiles: [],
      effectiveDefaultId: null,
    });
    mocks.queries.get.mockReset().mockResolvedValue({});
    mocks.queryInputs.list = undefined;
    mocks.queryInputs.listCombined = undefined;
    mocks.queryInputs.get = undefined;
  });

  it('personal context reads list and exposes personalProfiles with the personal default', async () => {
    mocks.queries.list.mockResolvedValue([
      summary({ id: 'personal-1', isDefault: false }),
      summary({ id: 'personal-2', isDefault: true }),
    ]);

    const holder: { current: ListResult | null } = { current: null };
    const { unmount } = await renderWithProviders(createElement(ListProbe, { holder }));

    await waitFor(() => current(holder).personalProfiles.length === 2);

    expect(current(holder).personalProfiles.map(profile => profile.id)).toEqual([
      'personal-1',
      'personal-2',
    ]);
    expect(current(holder).orgProfiles).toEqual([]);
    expect(current(holder).effectiveDefaultId).toBe('personal-2');
    expect(current(holder).isError).toBe(false);
    expect(mocks.queries.listCombined).not.toHaveBeenCalled();
    unmount();
  });

  it('org context reads listCombined and surfaces effectiveDefaultId', async () => {
    mocks.queries.listCombined.mockResolvedValue({
      orgProfiles: [summary({ id: 'org-1', ownerType: 'organization' })],
      personalProfiles: [summary({ id: 'personal-1', ownerType: 'user', isDefault: true })],
      effectiveDefaultId: 'personal-1',
    });

    const holder: { current: ListResult | null } = { current: null };
    const { unmount } = await renderWithProviders(
      createElement(ListProbe, { holder, organizationId: 'org-1' })
    );

    await waitFor(() => current(holder).effectiveDefaultId === 'personal-1');

    expect(current(holder).orgProfiles.map(profile => profile.id)).toEqual(['org-1']);
    expect(current(holder).personalProfiles.map(profile => profile.id)).toEqual(['personal-1']);
    expect(mocks.queries.list).not.toHaveBeenCalled();
    unmount();
  });

  it('starts empty on an organization switch instead of keeping the prior rows', async () => {
    type Combined = {
      orgProfiles: Record<string, unknown>[];
      personalProfiles: Record<string, unknown>[];
      effectiveDefaultId: string | null;
    };
    const first = Promise.withResolvers<Combined>();
    const second = Promise.withResolvers<Combined>();
    mocks.queries.listCombined
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const holder: { current: ListResult | null } = { current: null };
    const { renderer, queryClient, unmount } = await renderWithProviders(
      createElement(ListProbe, { holder, organizationId: 'org-1' })
    );

    first.resolve({
      orgProfiles: [summary({ id: 'org-1', ownerType: 'organization' })],
      personalProfiles: [],
      effectiveDefaultId: null,
    });
    await waitFor(() => current(holder).orgProfiles.length === 1);

    // Switch context while the new organization's read is still pending. The
    // previous organization's rows must not render under the new scope.
    await act(async () => {
      renderer.update(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(ListProbe, { holder, organizationId: 'org-2' })
        )
      );
      await Promise.resolve();
    });

    expect(current(holder).orgProfiles).toEqual([]);
    expect(current(holder).isLoading).toBe(true);

    second.resolve({
      orgProfiles: [summary({ id: 'org-2', ownerType: 'organization' })],
      personalProfiles: [],
      effectiveDefaultId: null,
    });
    await waitFor(
      () =>
        current(holder)
          .orgProfiles.map(profile => profile.id)
          .join(',') === 'org-2'
    );
    unmount();
  });
});

describe('useAgentProfile', () => {
  it('reads get with the profile id and the organization context', async () => {
    mocks.queries.get.mockResolvedValue({ id: 'profile-1', name: 'Org profile' });

    const holder: { current: ReturnType<typeof useAgentProfile> | null } = { current: null };
    const { unmount } = await renderWithProviders(
      createElement(ProfileProbe, { holder, profileId: 'profile-1', organizationId: 'org-1' })
    );

    await waitFor(() => current(holder).data !== undefined);
    expect(mocks.queryInputs.get).toEqual({ profileId: 'profile-1', organizationId: 'org-1' });
    unmount();
  });
});

describe('useAgentProfileMutations', () => {
  beforeEach(() => {
    for (const mutation of Object.values(mocks.mutations)) {
      mutation.mockReset().mockResolvedValue({ success: true });
    }
    mocks.toastError.mockReset();
  });

  it('passes organizationId to the procedure and invalidates the agentProfiles key', async () => {
    const holder: { current: MutationsResult | null } = { current: null };
    const { queryClient, unmount } = await renderWithProviders(
      createElement(MutationsProbe, { holder, organizationId: 'org-1' })
    );
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    await act(async () => {
      await current(holder).setVar.mutateAsync({
        profileId: 'profile-1',
        key: 'API_KEY',
        value: 'secret-value',
        isSecret: false,
      });
    });

    expect(mocks.mutations.setVar).toHaveBeenCalledTimes(1);
    expect(mocks.mutations.setVar).toHaveBeenCalledWith({
      profileId: 'profile-1',
      organizationId: 'org-1',
      key: 'API_KEY',
      value: 'secret-value',
      isSecret: false,
    });
    await waitFor(() => invalidateSpy.mock.calls.length > 0);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['agentProfiles'] });
    unmount();
  });

  it('leaves organizationId off personal-context input', async () => {
    const holder: { current: MutationsResult | null } = { current: null };
    const { unmount } = await renderWithProviders(createElement(MutationsProbe, { holder }));

    await act(async () => {
      await current(holder).create.mutateAsync({ name: 'Backend debugging' });
    });

    expect(mocks.mutations.create).toHaveBeenCalledWith({ name: 'Backend debugging' });
    unmount();
  });

  it('toasts a rejected mutation once with the server message', async () => {
    mocks.mutations.create.mockRejectedValue(new Error('Profiles are limited to 50'));

    const holder: { current: MutationsResult | null } = { current: null };
    const { unmount } = await renderWithProviders(createElement(MutationsProbe, { holder }));

    await act(async () => {
      await expect(current(holder).create.mutateAsync({ name: 'Too many' })).rejects.toThrow(
        'Profiles are limited to 50'
      );
    });

    await waitFor(() => mocks.toastError.mock.calls.length > 0);
    expect(mocks.toastError).toHaveBeenCalledTimes(1);
    expect(mocks.toastError).toHaveBeenCalledWith('Profiles are limited to 50');
    unmount();
  });

  it('setAsDefault applies optimistically and rolls back when the server rejects', async () => {
    let rejectMutation: ((error: Error) => void) | undefined = undefined;
    mocks.mutations.setAsDefault.mockReturnValue(
      new Promise((_resolve, reject: (error: Error) => void) => {
        rejectMutation = reject;
      })
    );

    const queryClient = createTestQueryClient();
    const listKey = ['agentProfiles', 'list', {}];
    queryClient.setQueryData<AgentProfileListItem[]>(listKey, [
      summary({ id: 'personal-1', isDefault: true }),
      summary({ id: 'personal-2', isDefault: false }),
    ] as AgentProfileListItem[]);

    const holder: { current: MutationsResult | null } = { current: null };
    const { unmount } = await renderWithProviders(createElement(MutationsProbe, { holder }), {
      queryClient,
    });

    let pending: Promise<unknown> | undefined = undefined;
    act(() => {
      pending = current(holder).setAsDefault.mutateAsync({ profileId: 'personal-2' });
    });

    // Optimistic write is visible while the mutation is still in flight.
    await waitFor(() => {
      const data = queryClient.getQueryData<AgentProfileListItem[]>(listKey);
      return data?.map(profile => profile.isDefault).join(',') === 'false,true';
    });
    const optimistic = queryClient.getQueryData<AgentProfileListItem[]>(listKey);
    expect(optimistic?.map(profile => profile.isDefault)).toEqual([false, true]);

    await act(async () => {
      rejectMutation?.(new Error('Could not set default'));
      await pending?.catch(() => undefined);
    });

    const rolledBack = queryClient.getQueryData<AgentProfileListItem[]>(listKey);
    expect(rolledBack?.map(profile => profile.isDefault)).toEqual([true, false]);
    expect(mocks.toastError).toHaveBeenCalledTimes(1);
    unmount();
  });

  it.each([
    {
      organizationId: 'org-1',
      clear: false,
      effective: 'personal',
      personalDefault: true,
      orgDefault: true,
    },
    {
      organizationId: 'org-1',
      clear: true,
      effective: 'personal',
      personalDefault: true,
      orgDefault: false,
    },
    {
      organizationId: undefined,
      clear: true,
      effective: 'org',
      personalDefault: false,
      orgDefault: true,
    },
    {
      organizationId: undefined,
      clear: false,
      effective: 'personal',
      personalDefault: true,
      orgDefault: true,
    },
  ])(
    'scopes optimistic defaults to their owner: $organizationId clear=$clear',
    async ({ organizationId, clear, effective, personalDefault, orgDefault }) => {
      const holder: { current: MutationsResult | null } = { current: null };
      const { queryClient, unmount } = await renderWithProviders(
        createElement(MutationsProbe, { holder, organizationId })
      );
      const personal = summary({ id: 'personal', isDefault: true, ownerType: 'user' });
      const org = summary({ id: 'org', isDefault: true, ownerType: 'organization' });
      const combinedKey = ['agentProfiles', 'listCombined', { organizationId: 'org-1' }];
      const otherKey = ['agentProfiles', 'listCombined', { organizationId: 'org-2' }];
      const combined = {
        personalProfiles: [personal],
        orgProfiles: [org],
        effectiveDefaultId: 'personal',
      };
      queryClient.setQueryData(combinedKey, combined);
      queryClient.setQueryData(otherKey, {
        ...combined,
        orgProfiles: [summary({ id: 'other', isDefault: true })],
      });
      const listKey = ['agentProfiles', 'list', { organizationId }];
      const untouchedListKey = ['agentProfiles', 'list', { organizationId: 'org-2' }];
      const detailKey = ['agentProfiles', 'get', { profileId: 'other', organizationId: 'org-2' }];
      queryClient.setQueryData(listKey, [organizationId ? org : personal]);
      queryClient.setQueryData(untouchedListKey, [summary({ id: 'other', isDefault: true })]);
      queryClient.setQueryData(detailKey, summary({ id: 'other', isDefault: true }));
      await act(async () => {
        await (clear
          ? current(holder).clearDefault.mutateAsync({
              profileId: organizationId ? 'org' : 'personal',
            })
          : current(holder).setAsDefault.mutateAsync({
              profileId: organizationId ? 'org' : 'personal',
            }));
      });
      expect(queryClient.getQueryData(combinedKey)).toMatchObject({
        effectiveDefaultId: effective,
        personalProfiles: [{ isDefault: personalDefault }],
        orgProfiles: [{ isDefault: orgDefault }],
      });
      expect(queryClient.getQueryData(untouchedListKey)).toMatchObject([{ isDefault: true }]);
      expect(queryClient.getQueryData(detailKey)).toMatchObject({ isDefault: true });
      expect(queryClient.getQueryData(otherKey)).toMatchObject({
        orgProfiles: [{ isDefault: true }],
        personalProfiles: [{ isDefault: organizationId ? true : personalDefault }],
        effectiveDefaultId: !organizationId && clear ? 'other' : 'personal',
      });
      unmount();
    }
  );

  it('clearing a non-default leaves the same owner current default intact', async () => {
    const holder: { current: MutationsResult | null } = { current: null };
    const { queryClient, unmount } = await renderWithProviders(
      createElement(MutationsProbe, { holder })
    );
    const listKey = ['agentProfiles', 'list', {}];
    const profiles = [summary({ id: 'default', isDefault: true }), summary({ id: 'other' })];
    queryClient.setQueryData(listKey, profiles);
    await act(async () => {
      await current(holder).clearDefault.mutateAsync({ profileId: 'other' });
    });
    expect(queryClient.getQueryData(listKey)).toEqual(profiles);
    unmount();
  });

  it('rolls back an organization default without touching another organization cache', async () => {
    const pending = Promise.withResolvers<{ success: boolean }>();
    mocks.mutations.setAsDefault.mockReturnValueOnce(pending.promise);
    const holder: { current: MutationsResult | null } = { current: null };
    const { queryClient, unmount } = await renderWithProviders(
      createElement(MutationsProbe, { holder, organizationId: 'org-1' })
    );
    const key = ['agentProfiles', 'listCombined', { organizationId: 'org-1' }];
    const otherKey = ['agentProfiles', 'listCombined', { organizationId: 'org-2' }];
    const original = {
      personalProfiles: [],
      orgProfiles: [summary({ id: 'previous', isDefault: true }), summary({ id: 'next' })],
      effectiveDefaultId: 'previous',
    };
    queryClient.setQueryData(key, original);
    queryClient.setQueryData(otherKey, original);
    let request: Promise<unknown> | undefined = undefined;
    act(() => {
      request = current(holder).setAsDefault.mutateAsync({ profileId: 'next' });
    });
    await waitFor(() => mocks.mutations.setAsDefault.mock.calls.length > 0);
    expect(queryClient.getQueryData(key)).toMatchObject({
      orgProfiles: [{ isDefault: false }, { isDefault: true }],
      effectiveDefaultId: 'next',
    });
    const refreshed = { ...original, effectiveDefaultId: null, orgProfiles: [] };
    queryClient.setQueryData(otherKey, refreshed);
    await act(async () => {
      pending.reject(new Error('Try again'));
      await request?.catch(() => undefined);
    });
    expect(queryClient.getQueryData(key)).toEqual(original);
    expect(queryClient.getQueryData(otherKey)).toEqual(refreshed);
    expect(mocks.toastError).toHaveBeenCalledWith('Try again');
    unmount();
  });

  it('setSkillEnabled applies optimistically to the profile detail', async () => {
    mocks.mutations.setSkillEnabled.mockResolvedValue({ success: true });

    const queryClient = createTestQueryClient();
    const detailKey = ['agentProfiles', 'get', { profileId: 'profile-1' }];
    queryClient.setQueryData(detailKey, {
      id: 'profile-1',
      name: 'Profile',
      isDefault: false,
      skills: [
        { id: 'skill-1', name: 'one', enabled: true },
        { id: 'skill-2', name: 'two', enabled: false },
      ],
    });

    const holder: { current: MutationsResult | null } = { current: null };
    const { unmount } = await renderWithProviders(createElement(MutationsProbe, { holder }), {
      queryClient,
    });

    await act(async () => {
      await current(holder).setSkillEnabled.mutateAsync({
        profileId: 'profile-1',
        skillId: 'skill-2',
        enabled: true,
      });
    });

    const detail = queryClient.getQueryData<{
      skills: { id: string; enabled: boolean }[];
    }>(detailKey);
    expect(detail?.skills.map(skill => [skill.id, skill.enabled])).toEqual([
      ['skill-1', true],
      ['skill-2', true],
    ]);
    unmount();
  });
});
