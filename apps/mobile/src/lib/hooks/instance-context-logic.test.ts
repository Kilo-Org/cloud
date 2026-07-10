import { describe, expect, it, vi } from 'vitest';

import { type ClawInstance, deriveInstanceContext } from './instance-context-logic';

function makeInstance(overrides: Partial<ClawInstance> = {}): ClawInstance {
  const instance: ClawInstance = {
    id: 'row-1',
    sandboxId: 'sandbox-1',
    name: 'My Instance',
    organizationId: null,
    organizationName: null,
    botName: null,
    botEmoji: null,
    status: 'running',
    ...overrides,
  };
  return instance;
}

describe('deriveInstanceContext', () => {
  it('returns loading while the list is still fetching', () => {
    const refetch = vi.fn<() => void>();
    expect(
      deriveInstanceContext('sandbox-1', { data: undefined, isError: false }, refetch)
    ).toEqual({
      status: 'loading',
    });
  });

  it('returns error when the initial load failed with no cached data', () => {
    const refetch = vi.fn<() => void>();
    const result = deriveInstanceContext('sandbox-1', { data: undefined, isError: true }, refetch);
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      result.refetch();
      expect(refetch).toHaveBeenCalledOnce();
    }
  });

  it('returns not_found when the list loaded successfully with no match', () => {
    const refetch = vi.fn<() => void>();
    const result = deriveInstanceContext(
      'sandbox-missing',
      { data: [makeInstance()], isError: false },
      refetch
    );
    expect(result).toEqual({ status: 'not_found' });
  });

  it('returns ready with organizationId null for a personal instance', () => {
    const refetch = vi.fn<() => void>();
    const instance = makeInstance({ organizationId: null });
    const result = deriveInstanceContext(
      'sandbox-1',
      { data: [instance], isError: false },
      refetch
    );
    expect(result).toEqual({ status: 'ready', instance, organizationId: null, isOrg: false });
  });

  it('returns ready with isOrg true for an org instance', () => {
    const refetch = vi.fn<() => void>();
    const instance = makeInstance({ organizationId: 'org-1' });
    const result = deriveInstanceContext(
      'sandbox-1',
      { data: [instance], isError: false },
      refetch
    );
    expect(result).toEqual({ status: 'ready', instance, organizationId: 'org-1', isOrg: true });
  });

  it('prefers cached data over a background refetch error (preserve stale data)', () => {
    const refetch = vi.fn<() => void>();
    const instance = makeInstance();
    const result = deriveInstanceContext('sandbox-1', { data: [instance], isError: true }, refetch);
    expect(result.status).toBe('ready');
  });
});
