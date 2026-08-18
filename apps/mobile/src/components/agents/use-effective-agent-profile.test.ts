/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN hooks under vitest (node env, no jsdom); see src/components/agents/use-new-session-creator.test.ts */
import * as React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { useQuery } from '@tanstack/react-query';

import {
  resolveCombinedDefault,
  resolvePersonalDefault,
  useEffectiveAgentProfile,
} from './use-effective-agent-profile';

// The hook module imports the tRPC client (which pulls in react-native via
// expo-secure-store); the pure resolvers under test never touch it, so stub the
// client out to keep this suite in the DOM-free `mobile-pure` environment.
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

describe('resolvePersonalDefault', () => {
  it('returns the profile marked isDefault', () => {
    const personal = [profile({ id: 'a' }), profile({ id: 'b', isDefault: true })];
    expect(resolvePersonalDefault(personal)?.id).toBe('b');
  });

  it('returns null when no profile is the default', () => {
    const personal = [profile({ id: 'a' }), profile({ id: 'b' })];
    expect(resolvePersonalDefault(personal)).toBeNull();
  });

  it('returns null for an empty list', () => {
    expect(resolvePersonalDefault([])).toBeNull();
  });
});

describe('resolveCombinedDefault', () => {
  it('resolves the personal default over the org default (personal wins)', () => {
    const personalDefault = profile({ id: 'personal-default', isDefault: true });
    const orgDefault = profile({ id: 'org-default', isDefault: true });
    const combined = {
      orgProfiles: [withOwner(orgDefault, 'organization')],
      personalProfiles: [withOwner(personalDefault, 'user')],
      effectiveDefaultId: 'personal-default',
    };
    expect(resolveCombinedDefault(combined)?.id).toBe('personal-default');
  });

  it('resolves the org default when no personal default exists', () => {
    const orgDefault = profile({ id: 'org-default', isDefault: true });
    const combined = {
      orgProfiles: [withOwner(orgDefault, 'organization')],
      personalProfiles: [withOwner(profile({ id: 'personal-plain' }), 'user')],
      effectiveDefaultId: 'org-default',
    };
    expect(resolveCombinedDefault(combined)?.id).toBe('org-default');
  });

  it('returns null when there is no effective default', () => {
    const combined = {
      orgProfiles: [withOwner(profile({ id: 'org-plain' }), 'organization')],
      personalProfiles: [withOwner(profile({ id: 'personal-plain' }), 'user')],
      effectiveDefaultId: null,
    };
    expect(resolveCombinedDefault(combined)).toBeNull();
  });
});

type ProfileResult = ReturnType<typeof useEffectiveAgentProfile>;

function ProfileHarness({
  organizationId,
  resultRef,
}: {
  organizationId?: string;
  resultRef: { current: ProfileResult | null };
}) {
  const result = useEffectiveAgentProfile(organizationId);
  resultRef.current = result;
  return null;
}

function mountProfile(organizationId?: string): ProfileResult {
  const resultRef: { current: ProfileResult | null } = { current: null };
  act(() => {
    TestRenderer.create(React.createElement(ProfileHarness, { organizationId, resultRef }));
  });
  const result = resultRef.current;
  if (result === null) {
    throw new Error('useEffectiveAgentProfile did not run');
  }
  return result;
}

describe('useEffectiveAgentProfile', () => {
  it('keeps Start enabled and omits profileId on query error despite cached data', () => {
    // React Query keeps `data` on error; the hook must not leak that cached
    // profile into the form (the error row shows and Start sends no id). A
    // settled error also leaves the gate false, so Start stays enabled.
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- partial query result; the hook reads only data/isPending/isError/refetch
    vi.mocked(useQuery).mockReturnValue({
      data: [profile({ id: 'cached-default', isDefault: true })],
      isPending: false,
      isError: true,
      refetch: vi.fn(),
    } as never);

    const personal = mountProfile();
    expect(personal.isError).toBe(true);
    expect(personal.isLoading).toBe(false);
    expect(personal.profile).toBeNull();
    expect(personal.profileId).toBeNull();

    const org = mountProfile('org-1');
    expect(org.isError).toBe(true);
    expect(org.isLoading).toBe(false);
    expect(org.profile).toBeNull();
    expect(org.profileId).toBeNull();
  });

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
});
