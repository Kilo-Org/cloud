import * as React from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { describe, expect, it, vi } from 'vitest';
import { useQuery } from '@tanstack/react-query';

import { useEffectiveAgentProfile } from './use-effective-agent-profile';

// The hook module imports the tRPC client (which pulls in react-native via
// expo-secure-store); stub the client out to keep this suite in the DOM-free
// `mobile-pure` environment.
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    agentProfiles: {
      list: { queryOptions: () => ({}) },
      listCombined: { queryOptions: () => ({}) },
    },
  }),
  trpcClient: {},
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: vi.fn(),
}));

type ProfileSummary = {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
  varCount: number;
  commandCount: number;
  mcpServerCount: number;
  skillCount: number;
  agentCount: number;
  kiloCommandCount: number;
};

type ProfileWithOwner = ProfileSummary & { ownerType: 'organization' | 'user' };

function profile(overrides: Partial<ProfileSummary> & { id: string }): ProfileSummary {
  return {
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

function withOwner(p: ProfileSummary, ownerType: 'organization' | 'user'): ProfileWithOwner {
  return { ...p, ownerType };
}

type ProfileResult = ReturnType<typeof useEffectiveAgentProfile>;

function ProfileHarness({
  organizationId,
  overrideProfileId,
  resultRef,
}: {
  organizationId?: string;
  overrideProfileId?: string | null;
  resultRef: { current: ProfileResult | null };
}) {
  const result = useEffectiveAgentProfile(organizationId, overrideProfileId);
  resultRef.current = result;
  return null;
}

function mountProfile(organizationId?: string, overrideProfileId?: string | null): ProfileResult {
  const resultRef: { current: ProfileResult | null } = { current: null };
  act(() => {
    TestRenderer.create(
      React.createElement(ProfileHarness, { organizationId, overrideProfileId, resultRef })
    );
  });
  const result = resultRef.current;
  if (result === null) {
    throw new Error('useEffectiveAgentProfile did not run');
  }
  return result;
}

describe('useEffectiveAgentProfile', () => {
  it.each([false, true])(
    'omits cached profileId and gates Start only during retry (isFetching: %s)',
    isFetching => {
      // React Query keeps `data` on error; the hook must not leak that cached
      // profile into the form (the error row shows and Start sends no id). A
      // settled error also leaves the gate false, so Start stays enabled.
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- partial query result; the hook reads only data/isPending/isFetching/isError/refetch
      vi.mocked(useQuery).mockReturnValue({
        data: [profile({ id: 'cached-default', isDefault: true })],
        isPending: false,
        isFetching,
        isError: true,
        refetch: vi.fn(),
      } as never);

      const personal = mountProfile();
      expect(personal.isError).toBe(true);
      expect(personal.isLoading).toBe(isFetching);
      expect(personal.profile).toBeNull();
      expect(personal.profileId).toBeNull();

      const org = mountProfile('org-1');
      expect(org.isError).toBe(true);
      expect(org.isLoading).toBe(isFetching);
      expect(org.profile).toBeNull();
      expect(org.profileId).toBeNull();
    }
  );

  it('reports loading (not error) while the query is in flight so Start stays blocked', () => {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- partial query result; the hook reads only data/isPending/isError/refetch
    vi.mocked(useQuery).mockReturnValue({
      data: undefined,
      isPending: true,
      isError: false,
      refetch: vi.fn(),
    } as never);

    const result = mountProfile();
    expect(result.isLoading).toBe(true);
    expect(result.isError).toBe(false);
    expect(result.profile).toBeNull();
    expect(result.profileId).toBeNull();
  });

  it('blocks Start on a paused first fetch (isPending true, isFetching false)', () => {
    // React Query v5 `isLoading` is `isPending && isFetching`, so a paused
    // (offline) first fetch reports `isLoading: false` while still unsettled.
    // The gate must read `isPending`, so Start stays blocked until it settles.
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- partial query result; the hook reads only data/isPending/isError/refetch
    vi.mocked(useQuery).mockReturnValue({
      data: undefined,
      isPending: true,
      isFetching: false,
      isError: false,
      refetch: vi.fn(),
    } as never);

    const result = mountProfile();
    expect(result.isLoading).toBe(true);
    expect(result.isError).toBe(false);
    expect(result.profile).toBeNull();
    expect(result.profileId).toBeNull();
  });

  it('submits the picked override and exposes it as the selection', () => {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- partial query result; the hook reads only data/isPending/isError/refetch
    vi.mocked(useQuery).mockReturnValue({
      data: [
        profile({ id: 'default', name: 'Default', isDefault: true }),
        profile({ id: 'picked', name: 'Picked' }),
      ],
      isPending: false,
      isError: false,
      refetch: vi.fn(),
    } as never);

    const result = mountProfile(undefined, 'picked');
    expect(result.selectedProfileId).toBe('picked');
    expect(result.profileId).toBe('picked');
    expect(result.profile?.name).toBe('Picked');
    expect(result.hasOverride).toBe(true);
    expect(result.overrideNeedsAttention).toBe(false);
  });

  it('drops a stale override and flags attention instead of submitting it', () => {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- partial query result; the hook reads only data/isPending/isError/refetch
    vi.mocked(useQuery).mockReturnValue({
      data: [profile({ id: 'default', isDefault: true })],
      isPending: false,
      isError: false,
      refetch: vi.fn(),
    } as never);

    const result = mountProfile(undefined, 'deleted');
    // The picker can still see which id was picked, but nothing stale is sent.
    expect(result.selectedProfileId).toBe('deleted');
    expect(result.profileId).toBeNull();
    expect(result.profile).toBeNull();
    expect(result.hasOverride).toBe(false);
    expect(result.overrideNeedsAttention).toBe(true);
  });

  it('exposes every profile and the effective default for the picker', () => {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- partial query result; the hook reads only data/isPending/isError/refetch
    vi.mocked(useQuery).mockReturnValue({
      data: [profile({ id: 'a' }), profile({ id: 'default', isDefault: true })],
      isPending: false,
      isError: false,
      refetch: vi.fn(),
    } as never);

    const result = mountProfile();
    expect(result.effectiveDefaultId).toBe('default');
    expect(result.allProfiles.map(p => p.id)).toEqual(['a', 'default']);
    expect(result.profileId).toBe('default');
    expect(result.hasOverride).toBe(false);
  });

  it('composes org and personal profiles for the org picker', () => {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- partial query result; the hook reads only data/isPending/isError/refetch
    vi.mocked(useQuery).mockReturnValue({
      data: {
        orgProfiles: [withOwner(profile({ id: 'org' }), 'organization')],
        personalProfiles: [withOwner(profile({ id: 'personal', isDefault: true }), 'user')],
        effectiveDefaultId: 'personal',
      },
      isPending: false,
      isError: false,
      refetch: vi.fn(),
    } as never);

    const result = mountProfile('org-1');
    expect(result.effectiveDefaultId).toBe('personal');
    expect(result.allProfiles.map(p => p.id)).toEqual(['org', 'personal']);
    expect(result.profileId).toBe('personal');
  });
});
