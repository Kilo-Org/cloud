import * as React from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useQuery } from '@tanstack/react-query';

import {
  type EffectiveProfileCustomModes,
  useEffectiveProfileCustomModes,
} from './use-effective-profile-custom-modes';

// Hoisted so the `vi.mock` factories below can record into them without hitting
// the temporal dead zone while the mocked modules are imported.
const calls = vi.hoisted(() => [] as { tag: 'list' | 'listCombined'; enabled?: boolean }[]);

/**
 * Every `useAgentProfileAgents` call, so a test can prove the profile's agents
 * read waits for the org ownership lookup and carries the right scope. The
 * module is mocked as a whole: the hook under test decides which profile and
 * scope to read, and the real read adds nothing those assertions need.
 */
const agentReads = vi.hoisted(
  () => [] as { profileId: string; organizationId: string | undefined; enabled: boolean }[]
);

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    agentProfiles: {
      list: {
        queryOptions: (_input: Record<string, unknown>, options?: { enabled?: boolean }) => {
          calls.push({ tag: 'list', enabled: options?.enabled });
          return { tag: 'list' };
        },
      },
      listCombined: {
        queryOptions: (_input: Record<string, unknown>, options?: { enabled?: boolean }) => {
          calls.push({ tag: 'listCombined', enabled: options?.enabled });
          return { tag: 'listCombined' };
        },
      },
    },
  }),
  trpcClient: {},
}));

vi.mock('@/lib/hooks/use-agent-profiles', () => ({
  useAgentProfileAgents: (
    profileId: string,
    organizationId: string | undefined,
    enabled: boolean
  ) => {
    agentReads.push({ profileId, organizationId, enabled });
    return { data: undefined, isLoading: false };
  },
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

function mockQueries(results: { list: QueryResult; listCombined: QueryResult }): void {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- partial query results; the hook reads only data/isLoading
  vi.mocked(useQuery).mockImplementation(
    ((options: { tag: keyof typeof results }) => results[options.tag]) as never
  );
}

function Harness({
  organizationId,
  profileId,
  resultRef,
}: {
  organizationId?: string;
  profileId?: string | null;
  resultRef: { current: EffectiveProfileCustomModes | null };
}) {
  const result = useEffectiveProfileCustomModes(organizationId, profileId);
  resultRef.current = result;
  return null;
}

function mount(
  organizationId?: string,
  profileId?: string | null
): { result: EffectiveProfileCustomModes; agentsRead: (typeof agentReads)[number] | undefined } {
  const resultRef: { current: EffectiveProfileCustomModes | null } = { current: null };
  act(() => {
    TestRenderer.create(React.createElement(Harness, { organizationId, profileId, resultRef }));
  });
  const result = resultRef.current;
  if (result === null) {
    throw new Error('useEffectiveProfileCustomModes did not run');
  }
  return { result, agentsRead: agentReads.at(-1) };
}

beforeEach(() => {
  calls.splice(0);
  agentReads.splice(0);
  vi.mocked(useQuery).mockReset();
});

describe('useEffectiveProfileCustomModes', () => {
  it('waits for the org ownership lookup before reading an explicit profile', () => {
    // The combined read is still in flight, so the profile's owner is unknown.
    // Reading the agents now would fire without the organization id and throw
    // `Profile not found` for an org profile.
    mockQueries({
      list: { data: undefined, isLoading: false },
      listCombined: { data: undefined, isLoading: true },
    });

    const { agentsRead } = mount('org-1', 'p-recorded');

    expect(agentsRead?.enabled).toBe(false);
  });

  it('reads an org profile with the organization id once the lookup resolves', () => {
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
    });

    const { agentsRead } = mount('org-1', 'p-recorded');

    expect(agentsRead?.enabled).toBe(true);
    expect(agentsRead?.organizationId).toBe('org-1');
    expect(agentsRead?.profileId).toBe('p-recorded');
  });

  it('reads a personal profile without the organization id', () => {
    mockQueries({
      list: { data: [profileRow('p-default', true)], isLoading: false },
      listCombined: { data: undefined, isLoading: false },
    });

    const { agentsRead } = mount(undefined, 'p-personal');

    expect(agentsRead?.enabled).toBe(true);
    expect(agentsRead?.organizationId).toBeUndefined();
    expect(agentsRead?.profileId).toBe('p-personal');
  });

  it("falls back to the effective default profile's agents when none is recorded", () => {
    mockQueries({
      list: { data: [profileRow('p-default', true)], isLoading: false },
      listCombined: { data: undefined, isLoading: false },
    });

    const { agentsRead } = mount(undefined, null);

    expect(agentsRead?.enabled).toBe(true);
    expect(agentsRead?.profileId).toBe('p-default');
  });
});
