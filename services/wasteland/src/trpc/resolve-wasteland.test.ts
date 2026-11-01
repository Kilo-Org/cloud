import { describe, expect, it, vi } from 'vitest';
import { resolveWastelandWith, type WastelandViewer } from './resolve-wasteland';

type Row = {
  wasteland_id: string;
  owner_type: 'user' | 'org';
  owner_user_id: string | null;
  organization_id: string | null;
  name: string;
  dolthub_upstream: string | null;
};

/**
 * Fake registry stub matching the DO contract: every claimant of the
 * slug, in the registry's own order (primary key), with no knowledge of
 * who is asking.
 */
function fakeRegistry(rows: Row[]) {
  return {
    findAllByOwnerRepo: vi.fn(async (owner: string, repo: string) => {
      const target = `${owner}/${repo}`.toLowerCase();
      return rows.filter(
        r => r.dolthub_upstream !== null && r.dolthub_upstream.toLowerCase() === target
      );
    }),
  };
}

const viewer: WastelandViewer = { userId: 'user-1', isAdmin: false, orgMemberships: [] };

function ownerRow(overrides: Partial<Row> = {}): Row {
  return {
    wasteland_id: 'wl-a',
    owner_type: 'user',
    owner_user_id: 'user-1',
    organization_id: null,
    name: 'commons',
    dolthub_upstream: 'octo/commons',
    ...overrides,
  };
}

function otherOwnerRow(overrides: Partial<Row> = {}): Row {
  return ownerRow({
    wasteland_id: 'wl-b',
    owner_user_id: 'user-2',
    name: 'someone-else',
    ...overrides,
  });
}

describe('resolveWastelandWith', () => {
  it('maps the single accessible claimant to the resolver shape', async () => {
    const registry = fakeRegistry([ownerRow()]);
    const resolution = await resolveWastelandWith(registry, viewer, {
      owner: 'octo',
      repo: 'commons',
    });
    expect(resolution).toEqual({
      kind: 'resolved',
      wasteland: {
        wastelandId: 'wl-a',
        ownerType: 'user',
        ownerUserId: 'user-1',
        organizationId: null,
        name: 'commons',
        dolthubUpstream: 'octo/commons',
      },
    });
  });

  it('reports none when nothing is registered for the address', async () => {
    const registry = fakeRegistry([]);
    expect(
      await resolveWastelandWith(registry, viewer, { owner: 'nope', repo: 'missing' })
    ).toEqual({ kind: 'none' });
  });

  it('skips a row whose upstream reads back as null', async () => {
    const registry = fakeRegistry([ownerRow({ dolthub_upstream: null })]);
    expect(
      await resolveWastelandWith(registry, viewer, { owner: 'octo', repo: 'commons' })
    ).toEqual({ kind: 'none' });
  });

  it('forwards the owner/repo pair to the registry verbatim', async () => {
    const registry = fakeRegistry([]);
    await resolveWastelandWith(registry, viewer, { owner: 'OctoCat', repo: 'Repo' });
    expect(registry.findAllByOwnerRepo).toHaveBeenCalledWith('OctoCat', 'Repo');
  });

  describe('shared upstreams', () => {
    it('resolves the caller own claimant regardless of registry order', async () => {
      for (const rows of [
        [otherOwnerRow(), ownerRow()],
        [ownerRow(), otherOwnerRow()],
      ]) {
        const registry = fakeRegistry(rows);
        const resolution = await resolveWastelandWith(registry, viewer, {
          owner: 'octo',
          repo: 'commons',
        });
        expect(resolution.kind).toBe('resolved');
        expect(resolution.kind === 'resolved' && resolution.wasteland.wastelandId).toBe('wl-a');
      }
    });

    it('reports none when every claimant belongs to another user', async () => {
      const registry = fakeRegistry([
        otherOwnerRow({ wasteland_id: 'wl-b' }),
        otherOwnerRow({ wasteland_id: 'wl-c', owner_user_id: 'user-3' }),
      ]);
      expect(
        await resolveWastelandWith(registry, viewer, { owner: 'octo', repo: 'commons' })
      ).toEqual({ kind: 'none' });
    });

    it('reports every claimant the caller can reach as ambiguous, in registry order', async () => {
      const registry = fakeRegistry([
        ownerRow({ wasteland_id: 'wl-a', name: 'first' }),
        otherOwnerRow(),
        ownerRow({ wasteland_id: 'wl-c', name: 'second' }),
      ]);
      const resolution = await resolveWastelandWith(registry, viewer, {
        owner: 'octo',
        repo: 'commons',
      });
      expect(resolution.kind).toBe('ambiguous');
      expect(resolution.kind === 'ambiguous' && resolution.candidates.map(c => c.name)).toEqual([
        'first',
        'second',
      ]);
    });
  });

  describe('org-owned wastelands', () => {
    const orgRow = ownerRow({
      owner_type: 'org',
      owner_user_id: null,
      organization_id: 'org-1',
    });

    it('resolves for a non-billing-manager member', async () => {
      const registry = fakeRegistry([orgRow]);
      const resolution = await resolveWastelandWith(
        registry,
        { ...viewer, orgMemberships: [{ orgId: 'org-1', role: 'member' }] },
        { owner: 'octo', repo: 'commons' }
      );
      expect(resolution.kind).toBe('resolved');
    });

    it('reports none for a billing manager', async () => {
      const registry = fakeRegistry([orgRow]);
      expect(
        await resolveWastelandWith(
          registry,
          { ...viewer, orgMemberships: [{ orgId: 'org-1', role: 'billing_manager' }] },
          { owner: 'octo', repo: 'commons' }
        )
      ).toEqual({ kind: 'none' });
    });

    it('reports none for a member of a different org', async () => {
      const registry = fakeRegistry([orgRow]);
      expect(
        await resolveWastelandWith(
          registry,
          { ...viewer, orgMemberships: [{ orgId: 'org-2', role: 'owner' }] },
          { owner: 'octo', repo: 'commons' }
        )
      ).toEqual({ kind: 'none' });
    });
  });

  describe('admin', () => {
    const admin: WastelandViewer = { userId: 'admin-1', isAdmin: true, orgMemberships: [] };

    it('resolves a single claimant owned by someone else', async () => {
      const registry = fakeRegistry([otherOwnerRow()]);
      const resolution = await resolveWastelandWith(registry, admin, {
        owner: 'octo',
        repo: 'commons',
      });
      expect(resolution.kind).toBe('resolved');
      expect(resolution.kind === 'resolved' && resolution.wasteland.wastelandId).toBe('wl-b');
    });

    it('reports ambiguity instead of picking a claimant to administer', async () => {
      const registry = fakeRegistry([ownerRow(), otherOwnerRow()]);
      const resolution = await resolveWastelandWith(registry, admin, {
        owner: 'octo',
        repo: 'commons',
      });
      expect(resolution.kind).toBe('ambiguous');
    });
  });
});
