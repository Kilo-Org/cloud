import { describe, expect, it } from 'vitest';

import {
  buildAgentSessionListInput,
  buildAgentSessionSearchInput,
} from '@/lib/agent-session-input';

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

describe('buildAgentSessionSearchInput', () => {
  it('defaults to updated_at when sortBy is omitted', () => {
    expect(buildAgentSessionSearchInput({ searchQuery: 'hello' })).toMatchObject({
      search_string: 'hello',
      orderBy: 'updated_at',
      limit: 50,
      includeChildren: false,
    });
  });

  it('uses created_at when explicitly requested', () => {
    expect(
      buildAgentSessionSearchInput({ searchQuery: 'hello', sortBy: 'created_at' })
    ).toMatchObject({
      search_string: 'hello',
      orderBy: 'created_at',
      limit: 50,
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
      limit: 50,
      orderBy: 'created_at',
      includeChildren: false,
      createdOnPlatform: 'cli',
      gitUrl: 'https://github.com/foo/bar',
      organizationId: 'org-1',
    });
  });
});
