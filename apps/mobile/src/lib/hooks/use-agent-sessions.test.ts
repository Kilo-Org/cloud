import { describe, expect, it, vi } from 'vitest';

import {
  buildActiveSessionsInput,
  buildAgentSessionListInput,
  buildAgentSessionSearchInput,
} from '@/lib/agent-session-input';
import {
  buildAgentSessionSearchQueryOptions,
  buildStoredSessionsQueryOptions,
} from '@/lib/hooks/use-agent-sessions';

// The hook module transitively imports react-native (via the user-web-
// connection lifecycle) and the real tRPC client (via `@/lib/trpc`), which the
// node vitest pipeline cannot transform. The options builder itself is pure,
// so only the module-load chain needs these mocks; no hook is mounted.
vi.mock('@/lib/trpc', () => ({
  useTRPC: vi.fn(),
}));

vi.mock('@/lib/hooks/use-user-web-connection-state', () => ({
  useUserWebConnectionState: () => false,
}));

vi.mock('@/lib/active-sessions-live-sync', () => ({
  refreshActiveSessionsNow: vi.fn().mockResolvedValue(false),
}));

vi.mock('react-native', () => ({
  InteractionManager: { runAfterInteractions: vi.fn() },
}));

function createTrpcStub(infiniteQueryOptions: unknown) {
  const stub = { cliSessionsV2: { list: { infiniteQueryOptions } } };
  return stub as never;
}

function createSearchTrpcStub(infiniteQueryOptions: unknown) {
  const stub = { cliSessionsV2: { search: { infiniteQueryOptions } } };
  return stub as never;
}

describe('buildAgentSessionListInput', () => {
  it('defaults to updated_at when sortBy is omitted (matches pre-feature behavior)', () => {
    expect(
      buildAgentSessionListInput({
        createdOnPlatform: 'cli',
        organizationId: null,
      })
    ).toMatchObject({
      orderBy: 'updated_at',
      limit: 30,
      includeChildren: false,
      createdOnPlatform: 'cli',
      organizationId: null,
    });
  });

  it('passes updated_at through when explicitly requested', () => {
    expect(
      buildAgentSessionListInput({
        sortBy: 'updated_at',
      }).orderBy
    ).toBe('updated_at');
  });

  it('passes created_at through when explicitly requested', () => {
    expect(
      buildAgentSessionListInput({
        sortBy: 'created_at',
      }).orderBy
    ).toBe('created_at');
  });

  it('falls back to updated_at for an unknown sort value (defensive default)', () => {
    expect(
      buildAgentSessionListInput({
        sortBy: 'title' as unknown as 'updated_at',
      }).orderBy
    ).toBe('updated_at');
  });

  it('forwards filter fields alongside the sort', () => {
    expect(
      buildAgentSessionListInput({
        sortBy: 'created_at',
        createdOnPlatform: ['cli', 'extension'],
        gitUrl: ['https://github.com/foo/bar'],
        organizationId: 'org-1',
      })
    ).toEqual({
      limit: 30,
      orderBy: 'created_at',
      includeChildren: false,
      createdOnPlatform: ['cli', 'extension'],
      gitUrl: ['https://github.com/foo/bar'],
      organizationId: 'org-1',
    });
  });
});

describe('buildActiveSessionsInput', () => {
  it('collapses null to { organizationId: null }', () => {
    expect(buildActiveSessionsInput(null)).toEqual({ organizationId: null });
  });

  it('passes a uuid through unchanged', () => {
    expect(buildActiveSessionsInput('a1b2c3d4-e5f6-7890-abcd-ef1234567890')).toEqual({
      organizationId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    });
  });

  it('collapses undefined to { organizationId: null }', () => {
    expect(buildActiveSessionsInput(undefined)).toEqual({ organizationId: null });
  });

  it('produces the same key for null and undefined (key-stability rule)', () => {
    expect(buildActiveSessionsInput(null)).toEqual(buildActiveSessionsInput(undefined));
  });
});

describe('buildAgentSessionSearchInput', () => {
  it('defaults to updated_at when sortBy is omitted', () => {
    expect(buildAgentSessionSearchInput({ searchQuery: 'hello' })).toMatchObject({
      search_string: 'hello',
      orderBy: 'updated_at',
      limit: 30,
      includeChildren: false,
    });
  });

  it('uses created_at when explicitly requested', () => {
    expect(
      buildAgentSessionSearchInput({ searchQuery: 'hello', sortBy: 'created_at' })
    ).toMatchObject({
      search_string: 'hello',
      orderBy: 'created_at',
      limit: 30,
    });
  });

  it('falls back to updated_at for an unknown sort value', () => {
    expect(
      buildAgentSessionSearchInput({
        searchQuery: 'hello',
        sortBy: 'name' as unknown as 'updated_at',
      }).orderBy
    ).toBe('updated_at');
  });

  it('forwards filter fields alongside the sort', () => {
    expect(
      buildAgentSessionSearchInput({
        searchQuery: 'hello',
        sortBy: 'created_at',
        createdOnPlatform: 'cli',
        gitUrl: 'https://github.com/foo/bar',
        organizationId: 'org-1',
      })
    ).toEqual({
      search_string: 'hello',
      limit: 30,
      orderBy: 'created_at',
      includeChildren: false,
      createdOnPlatform: 'cli',
      gitUrl: 'https://github.com/foo/bar',
      organizationId: 'org-1',
    });
  });

  it('has no cursor key — the query framework injects it', () => {
    const input = buildAgentSessionSearchInput({
      searchQuery: 'hello',
      organizationId: 'org-1',
    });
    expect(input).not.toHaveProperty('cursor');
  });
});

describe('buildStoredSessionsQueryOptions', () => {
  it('keeps the native window-focus refetch by default (Home and Share Gate)', () => {
    const infiniteQueryOptions = vi.fn((_input: unknown, options: object) => options);
    const result = buildStoredSessionsQueryOptions(createTrpcStub(infiniteQueryOptions), {});

    expect(infiniteQueryOptions).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 30 }),
      expect.objectContaining({ refetchOnWindowFocus: true })
    );
    expect(result.refetchOnWindowFocus).toBe(true);
  });

  it('disables the native window-focus refetch only for the Agents list configuration', () => {
    const infiniteQueryOptions = vi.fn((_input: unknown, options: object) => options);
    const result = buildStoredSessionsQueryOptions(createTrpcStub(infiniteQueryOptions), {
      refetchOnWindowFocus: false,
    });

    expect(infiniteQueryOptions).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 30 }),
      expect.objectContaining({ refetchOnWindowFocus: false })
    );
    expect(result.refetchOnWindowFocus).toBe(false);
  });

  it('keeps the explicit fetch paths enabled (enabled passthrough)', () => {
    const infiniteQueryOptions = vi.fn((_input: unknown, options: object) => options);
    const result = buildStoredSessionsQueryOptions(createTrpcStub(infiniteQueryOptions), {
      enabled: false,
    });

    expect(result.enabled).toBe(false);
  });

  it('carries a numeric maxPages retention bound', () => {
    const infiniteQueryOptions = vi.fn((_input: unknown, options: object) => options);
    const result = buildStoredSessionsQueryOptions(createTrpcStub(infiniteQueryOptions), {});

    expect(result.maxPages).toBeTypeOf('number');
  });
});

describe('buildAgentSessionSearchQueryOptions', () => {
  it('carries a numeric maxPages retention bound', () => {
    const infiniteQueryOptions = vi.fn((_input: unknown, options: object) => options);
    const result = buildAgentSessionSearchQueryOptions(createSearchTrpcStub(infiniteQueryOptions), {
      searchQuery: 'hello',
    });

    expect(result.maxPages).toBeTypeOf('number');
  });

  it('keeps the search-text gating (enabled passthrough)', () => {
    const infiniteQueryOptions = vi.fn((_input: unknown, options: object) => options);
    const result = buildAgentSessionSearchQueryOptions(createSearchTrpcStub(infiniteQueryOptions), {
      searchQuery: 'hello',
    });

    expect(result.enabled).toBe(true);
  });
});
