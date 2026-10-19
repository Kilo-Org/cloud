import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  fetchCollaboratorPermission,
  hasWriteAccess,
  parseCollaboratorPermission,
} from './github-collaborator-permission';

describe('parseCollaboratorPermission', () => {
  it('accepts the known permission levels', () => {
    expect(parseCollaboratorPermission({ permission: 'admin' })).toBe('admin');
    expect(parseCollaboratorPermission({ permission: 'maintain' })).toBe('maintain');
    expect(parseCollaboratorPermission({ permission: 'write' })).toBe('write');
    expect(parseCollaboratorPermission({ permission: 'read' })).toBe('read');
    expect(parseCollaboratorPermission({ permission: 'none' })).toBe('none');
  });

  it('returns null for unknown or malformed bodies', () => {
    expect(parseCollaboratorPermission({ permission: 'tier-1' })).toBeNull();
    expect(parseCollaboratorPermission({})).toBeNull();
    expect(parseCollaboratorPermission(null)).toBeNull();
    expect(parseCollaboratorPermission('ok')).toBeNull();
    expect(parseCollaboratorPermission({ permission: 42 })).toBeNull();
  });
});

describe('hasWriteAccess', () => {
  it('grants only write tiers', () => {
    expect(hasWriteAccess('admin')).toBe(true);
    expect(hasWriteAccess('maintain')).toBe(true);
    expect(hasWriteAccess('write')).toBe(true);
    expect(hasWriteAccess('read')).toBe(false);
    expect(hasWriteAccess('none')).toBe(false);
    expect(hasWriteAccess(null)).toBe(false);
  });
});

describe('fetchCollaboratorPermission', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses the permission from a successful lookup', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ permission: 'write' }), { status: 200 }))
    );

    await expect(fetchCollaboratorPermission('acme/repo', 'alice', 'token')).resolves.toBe('write');
  });

  it('returns null on non-2xx responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('forbidden', { status: 403 }))
    );

    await expect(fetchCollaboratorPermission('acme/repo', 'alice', 'token')).resolves.toBeNull();
  });

  it('returns null on network errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      })
    );

    await expect(fetchCollaboratorPermission('acme/repo', 'alice', 'token')).resolves.toBeNull();
  });
});
