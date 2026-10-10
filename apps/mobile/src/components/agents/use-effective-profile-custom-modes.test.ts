import * as React from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useQuery } from '@tanstack/react-query';

import { useEffectiveProfileCustomModes } from './use-effective-profile-custom-modes';

type QueryCall = {
  tag: 'list' | 'listCombined' | 'get';
  input: Record<string, unknown>;
  enabled: boolean | undefined;
};

// Hoisted so the `vi.mock` factory below can record into it without hitting the
// temporal dead zone while the mocked module is imported.
const calls = vi.hoisted(
  () =>
    [] as {
      tag: 'list' | 'listCombined' | 'get';
      input: Record<string, unknown>;
      enabled: boolean | undefined;
    }[]
);

// Capture the `enabled` flag and input every query is built with, so a test can
// prove the profile `get` waits for the org ownership lookup to resolve.
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    agentProfiles: {
      list: {
        queryOptions: (input: Record<string, unknown>, options?: { enabled?: boolean }) => {
          calls.push({ tag: 'list', input, enabled: options?.enabled });
          return { tag: 'list' };
        },
      },
      listCombined: {
        queryOptions: (input: Record<string, unknown>, options?: { enabled?: boolean }) => {
          calls.push({ tag: 'listCombined', input, enabled: options?.enabled });
          return { tag: 'listCombined' };
        },
      },
      get: {
        queryOptions: (input: Record<string, unknown>, options?: { enabled?: boolean }) => {
          calls.push({ tag: 'get', input, enabled: options?.enabled });
          return { tag: 'get' };
        },
      },
    },
  }),
  trpcClient: {},
}));

vi.mock('@tanstack/react-query', () => ({ useQuery: vi.fn() }));

function profileRow(id: string, isDefault = false) {
  return {
    id,
    name: id,
    description: null,
    isDefault,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    varCount: 0,
    commandCount: 0,
    mcpServerCount: 0,
    skillCount: 0,
    agentCount: 0,
    kiloCommandCount: 0,
  };
}

type QueryResult = { data: unknown; isLoading: boolean };

function mockQueries(results: {
  list: QueryResult;
  listCombined: QueryResult;
  get: QueryResult;
}): void {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- partial query results; the hook reads only data/isLoading
  vi.mocked(useQuery).mockImplementation(
    ((options: { tag: keyof typeof results }) => results[options.tag]) as never
  );
}

type Result = ReturnType<typeof useEffectiveProfileCustomModes>;

function Harness({
  organizationId,
  profileId,
  resultRef,
}: {
  organizationId?: string;
  profileId?: string | null;
  resultRef: { current: Result | null };
}) {
  const result = useEffectiveProfileCustomModes(organizationId, profileId);
  resultRef.current = result;
  return null;
}

function mount(
  organizationId?: string,
  profileId?: string | null
): { result: Result; get: QueryCall | undefined } {
  const resultRef: { current: Result | null } = { current: null };
  act(() => {
    TestRenderer.create(React.createElement(Harness, { organizationId, profileId, resultRef }));
  });
  const result = resultRef.current;
  if (result === null) {
    throw new Error('useEffectiveProfileCustomModes did not run');
  }
  return { result, get: calls.find(call => call.tag === 'get') };
}

beforeEach(() => {
  calls.splice(0);
  vi.mocked(useQuery).mockReset();
});

describe('useEffectiveProfileCustomModes', () => {
  it('waits for the org ownership lookup before fetching an explicit profile', () => {
    // The combined read is still in flight, so the profile's owner is unknown.
    // Enabling the `get` now would fire without the organization id and throw
    // `Profile not found` for an org profile.
    mockQueries({
      list: { data: undefined, isLoading: false },
      listCombined: { data: undefined, isLoading: true },
      get: { data: undefined, isLoading: false },
    });

    const { get } = mount('org-1', 'p-recorded');

    expect(get?.enabled).toBe(false);
  });

  it('fetches an org profile with the organization id once the lookup resolves', () => {
    mockQueries({
      list: { data: undefined, isLoading: false },
      listCombined: {
        data: {
          orgProfiles: [profileRow('p-recorded')],
          personalProfiles: [],
          effectiveDefaultId: null,
        },
        isLoading: false,
      },
      get: { data: { agents: [] }, isLoading: false },
    });

    const { get } = mount('org-1', 'p-recorded');

    expect(get?.enabled).toBe(true);
    expect(get?.input.organizationId).toBe('org-1');
  });

  it('fetches a personal profile without the organization id', () => {
    mockQueries({
      list: { data: [profileRow('p-default', true)], isLoading: false },
      listCombined: { data: undefined, isLoading: false },
      get: { data: { agents: [] }, isLoading: false },
    });

    const { get } = mount(undefined, 'p-personal');

    expect(get?.enabled).toBe(true);
    expect(get?.input.organizationId).toBeUndefined();
    expect(get?.input.profileId).toBe('p-personal');
  });

  it("falls back to the effective default profile's agents when none is recorded", () => {
    mockQueries({
      list: { data: [profileRow('p-default', true)], isLoading: false },
      listCombined: { data: undefined, isLoading: false },
      get: { data: { agents: [] }, isLoading: false },
    });

    const { get } = mount(undefined, null);

    expect(get?.enabled).toBe(true);
    expect(get?.input.profileId).toBe('p-default');
  });
});
