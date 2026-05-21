import { describe, expect, it, vi } from 'vitest';
import { resolveWastelandWith, type RegistryLookup } from './resolve-wasteland';

function fakeRegistry(
  rows: Array<{
    wasteland_id: string;
    owner_type: 'user' | 'org';
    owner_user_id: string | null;
    organization_id: string | null;
    name: string;
    dolthub_upstream: string | null;
  }>
): RegistryLookup {
  return {
    findByOwnerRepo: vi.fn(async (owner: string, repo: string) => {
      const target = `${owner}/${repo}`.toLowerCase();
      return (
        rows.find(r => r.dolthub_upstream && r.dolthub_upstream.toLowerCase() === target) ?? null
      );
    }),
  };
}

describe('resolveWastelandWith', () => {
  it('maps the registry record to the camelCase resolver shape', async () => {
    const registry = fakeRegistry([
      {
        wasteland_id: 'wl-1',
        owner_type: 'org',
        owner_user_id: null,
        organization_id: 'org-1',
        name: 'commons',
        dolthub_upstream: 'octo/commons',
      },
    ]);
    const resolved = await resolveWastelandWith(registry, { owner: 'octo', repo: 'commons' });
    expect(resolved).toEqual({
      wastelandId: 'wl-1',
      ownerType: 'org',
      ownerUserId: null,
      organizationId: 'org-1',
      name: 'commons',
      dolthubUpstream: 'octo/commons',
    });
  });

  it('returns null when the registry has no row', async () => {
    const registry = fakeRegistry([]);
    expect(await resolveWastelandWith(registry, { owner: 'nope', repo: 'missing' })).toBeNull();
  });

  it('returns null when a row is found but has a null upstream', async () => {
    // The fake's `findByOwnerRepo` already filters nulls; this test
    // pins the defence-in-depth branch by handing back a row with a
    // null `dolthub_upstream` directly.
    const registry: RegistryLookup = {
      findByOwnerRepo: async () => ({
        wasteland_id: 'wl-1',
        owner_type: 'user',
        owner_user_id: 'u1',
        organization_id: null,
        name: 'orphan',
        dolthub_upstream: null,
      }),
    };
    expect(await resolveWastelandWith(registry, { owner: 'octo', repo: 'orphan' })).toBeNull();
  });

  it('forwards owner/repo to the registry verbatim', async () => {
    const registry = fakeRegistry([]);
    await resolveWastelandWith(registry, { owner: 'OctoCat', repo: 'Repo' });
    expect(registry.findByOwnerRepo).toHaveBeenCalledWith('OctoCat', 'Repo');
  });
});
