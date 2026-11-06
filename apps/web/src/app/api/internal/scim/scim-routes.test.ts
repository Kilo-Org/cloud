import { describe, expect, test } from '@jest/globals';
import { INTERNAL_API_SECRET } from '@kilocode/web-shared/lib/config.server';
import { NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';

import type * as DirectorySync from '@/lib/scim/directory-sync';

import { PUT as putMembership, DELETE as deleteMembership } from './memberships/route';
import {
  PUT as putOrganization,
  DELETE as deleteOrganization,
} from './organizations/[directoryId]/route';
import {
  PUT as putSubOrganization,
  DELETE as deleteSubOrganization,
} from './sub-organizations/[directoryGroupId]/route';
import { PUT as putUser } from './users/[externalId]/route';

// The routes are a transport shell over `@/lib/scim/directory-sync`, whose
// behaviour is covered against a real database in
// `src/lib/scim/directory-sync.integration.test.ts`. These tests cover what the
// shell owns: authentication, body validation, and the conflict status mapping
// the Worker depends on to decide whether to advance its cursor.
jest.mock('@/lib/scim/directory-sync', () => {
  class DirectorySyncConflictError extends Error {}
  return {
    DirectorySyncConflictError,
    upsertDirectoryOrganization: jest.fn(async () => ({ id: 'org-1', created: true })),
    deleteDirectoryOrganization: jest.fn(async () => ({ id: 'org-1', deleted: true })),
    upsertDirectorySubOrganization: jest.fn(async () => ({ id: 'org-2', created: true })),
    deleteDirectorySubOrganization: jest.fn(async () => ({ id: 'org-2', deleted: true })),
    upsertDirectoryUser: jest.fn(async () => ({ id: 'user-1', created: true })),
    addDirectoryMembership: jest.fn(async () => ({
      organizationId: 'org-2',
      parentOrganizationId: 'org-1',
      kiloUserId: 'user-1',
      created: true,
      clearedRemovalTombstone: false,
    })),
    removeDirectoryMembership: jest.fn(async () => ({
      organizationId: 'org-2',
      parentOrganizationId: 'org-1',
      kiloUserId: 'user-1',
      removed: true,
      revokedParentMembership: false,
    })),
  };
});

const directorySync = jest.requireMock<typeof DirectorySync>('@/lib/scim/directory-sync');

function request(body: unknown, { authenticated = true }: { authenticated?: boolean } = {}) {
  return new NextRequest('https://kilocode.ai/api/internal/scim/test', {
    method: 'PUT',
    headers: authenticated
      ? { 'x-internal-api-key': INTERNAL_API_SECRET ?? '', 'content-type': 'application/json' }
      : { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const organizationBody = { workOSOrganizationId: 'org_123', name: 'Acme' };
const subOrganizationBody = {
  directoryId: 'directory_123',
  directoryIdpId: 'idp_group_123',
  name: 'engineering',
};
const userBody = {
  directoryId: 'directory_123',
  email: 'person@acme.test',
  firstName: 'A',
  lastName: 'B',
  idpId: 'idp_1',
};
const membershipBody = { directoryGroupId: 'directory_group_123', externalId: 'directory_user_1' };

const organizationParams = { params: Promise.resolve({ directoryId: 'directory_123' }) };
const groupParams = { params: Promise.resolve({ directoryGroupId: 'directory_group_123' }) };
const userParams = { params: Promise.resolve({ externalId: 'directory_user_1' }) };

beforeEach(() => {
  jest.clearAllMocks();
});

describe('authentication', () => {
  test.each([
    [
      'PUT organizations',
      () =>
        putOrganization(request(organizationBody, { authenticated: false }), organizationParams),
    ],
    [
      'DELETE organizations',
      () => deleteOrganization(request({}, { authenticated: false }), organizationParams),
    ],
    [
      'PUT sub-organizations',
      () => putSubOrganization(request(subOrganizationBody, { authenticated: false }), groupParams),
    ],
    [
      'DELETE sub-organizations',
      () => deleteSubOrganization(request({}, { authenticated: false }), groupParams),
    ],
    ['PUT users', () => putUser(request(userBody, { authenticated: false }), userParams)],
    ['PUT memberships', () => putMembership(request(membershipBody, { authenticated: false }))],
    [
      'DELETE memberships',
      () => deleteMembership(request(membershipBody, { authenticated: false })),
    ],
  ])('%s rejects an unauthenticated request', async (_name, call) => {
    const response = await call();

    expect(response.status).toBe(401);
  });

  test('an unauthenticated request performs no write', async () => {
    await putOrganization(request(organizationBody, { authenticated: false }), organizationParams);

    expect(directorySync.upsertDirectoryOrganization).not.toHaveBeenCalled();
  });
});

describe('validation', () => {
  test.each([
    ['a missing WorkOS organization id', { name: 'Acme' }],
    ['an empty name', { workOSOrganizationId: 'org_123', name: '' }],
    ['an unexpected field', { ...organizationBody, role: 'admin' }],
  ])('PUT organizations rejects %s', async (_name, body) => {
    const response = await putOrganization(request(body), organizationParams);

    expect(response.status).toBe(400);
    expect(directorySync.upsertDirectoryOrganization).not.toHaveBeenCalled();
  });

  test('PUT users rejects a malformed email', async () => {
    const response = await putUser(request({ ...userBody, email: 'not-an-email' }), userParams);

    expect(response.status).toBe(400);
    expect(directorySync.upsertDirectoryUser).not.toHaveBeenCalled();
  });

  test('PUT memberships rejects a body missing the group', async () => {
    const response = await putMembership(request({ externalId: 'directory_user_1' }));

    expect(response.status).toBe(400);
    expect(directorySync.addDirectoryMembership).not.toHaveBeenCalled();
  });

  test('a non-JSON body is rejected rather than throwing', async () => {
    const malformed = new NextRequest('https://kilocode.ai/api/internal/scim/test', {
      method: 'PUT',
      headers: { 'x-internal-api-key': INTERNAL_API_SECRET ?? '' },
      body: 'not-json',
    });

    const response = await putOrganization(malformed, organizationParams);

    expect(response.status).toBe(400);
  });
});

describe('success', () => {
  test('PUT organizations returns the upsert result', async () => {
    const response = await putOrganization(request(organizationBody), organizationParams);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: 'org-1', created: true });
    expect(directorySync.upsertDirectoryOrganization).toHaveBeenCalledWith(
      'directory_123',
      organizationBody
    );
  });

  test('PUT memberships reports a cleared removal tombstone', async () => {
    jest.mocked(directorySync.addDirectoryMembership).mockResolvedValueOnce({
      organizationId: 'org-2',
      parentOrganizationId: 'org-1',
      kiloUserId: 'user-1',
      created: true,
      clearedRemovalTombstone: true,
    });

    const response = await putMembership(request(membershipBody));

    expect(await response.json()).toMatchObject({ clearedRemovalTombstone: true });
  });

  test('DELETE memberships reads the pair from the body', async () => {
    const response = await deleteMembership(request(membershipBody));

    expect(response.status).toBe(200);
    expect(directorySync.removeDirectoryMembership).toHaveBeenCalledWith(membershipBody);
  });

  test('DELETE memberships converges with nothing to remove', async () => {
    // An unknown group or user is the removal's converged state, not a
    // conflict, so the Worker advances its cursor rather than retrying for an
    // add that may never arrive.
    jest.mocked(directorySync.removeDirectoryMembership).mockResolvedValueOnce({
      organizationId: null,
      parentOrganizationId: null,
      kiloUserId: null,
      removed: false,
      revokedParentMembership: false,
    });

    const response = await deleteMembership(request(membershipBody));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      organizationId: null,
      parentOrganizationId: null,
      kiloUserId: null,
      removed: false,
      revokedParentMembership: false,
    });
  });
});

describe('error mapping', () => {
  test('a conflict is 409 so the Worker retries without advancing its cursor', async () => {
    jest
      .mocked(directorySync.upsertDirectorySubOrganization)
      .mockRejectedValueOnce(
        new directorySync.DirectorySyncConflictError('No organization is bound to directory x')
      );

    const response = await putSubOrganization(request(subOrganizationBody), groupParams);

    expect(response.status).toBe(409);
    // The message names the missing dependency, which the Worker logs.
    expect(await response.json()).toEqual({ error: 'No organization is bound to directory x' });
  });

  test('an unexpected failure is 500 and does not leak driver detail', async () => {
    const leaky = new Error('duplicate key value violates unique constraint "idx_x" (secret-sql)');
    jest.mocked(directorySync.upsertDirectoryOrganization).mockRejectedValueOnce(leaky);

    const response = await putOrganization(request(organizationBody), organizationParams);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Directory sync write failed' });
  });
});

describe('path parameters', () => {
  test('an empty directory id is rejected', async () => {
    const response = await putOrganization(request(organizationBody), {
      params: Promise.resolve({ directoryId: '' }),
    });

    expect(response.status).toBe(400);
    expect(directorySync.upsertDirectoryOrganization).not.toHaveBeenCalled();
  });

  test('the path identifier is passed through verbatim', async () => {
    const directoryId = `directory_${randomUUID()}`;

    await putOrganization(request(organizationBody), {
      params: Promise.resolve({ directoryId }),
    });

    expect(directorySync.upsertDirectoryOrganization).toHaveBeenCalledWith(
      directoryId,
      organizationBody
    );
  });
});
