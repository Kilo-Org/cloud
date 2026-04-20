import { describe, expect, it, beforeAll, beforeEach, jest } from '@jest/globals';
import { db, cleanupDbForTest } from '@/lib/drizzle';
import { kiloclaw_instances } from '@kilocode/db/schema';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createOrganization } from '@/lib/organizations/organizations';
import type { User, Organization } from '@kilocode/db/schema';
import type { createCallerForUser as createCallerForUserType } from '@/routers/test-utils';

type PatchWebSearchConfig = (
  userId: string,
  patch: { exaMode?: 'kilo-proxy' | 'disabled' | null },
  instanceId?: string
) => Promise<{ exaMode: 'kilo-proxy' | 'disabled' | null }>;

const mockPatchWebSearchConfig = jest.fn<PatchWebSearchConfig>();

jest.mock('@/lib/kiloclaw/kiloclaw-internal-client', () => {
  const actual: Record<string, unknown> = jest.requireActual(
    '@/lib/kiloclaw/kiloclaw-internal-client'
  );

  return {
    KiloClawInternalClient: jest.fn().mockImplementation(() => ({
      patchWebSearchConfig: mockPatchWebSearchConfig,
    })),
    KiloClawApiError: actual.KiloClawApiError,
  };
});

jest.mock('next/headers', () => {
  const get = jest.fn<() => unknown>();

  return {
    cookies: jest.fn<() => Promise<{ get: typeof get }>>().mockResolvedValue({ get }),
    headers: jest.fn<() => Map<string, string>>().mockReturnValue(new Map()),
  };
});

let createCallerForUser: typeof createCallerForUserType;
let user: User;
let org: Organization;

beforeAll(async () => {
  const mod = await import('@/routers/test-utils');
  createCallerForUser = mod.createCallerForUser;
});

beforeEach(async () => {
  await cleanupDbForTest();
  mockPatchWebSearchConfig.mockReset();

  user = await insertTestUser({
    google_user_email: `org-kiloclaw-web-search-${crypto.randomUUID()}@example.com`,
  });
  org = await createOrganization('Org KiloClaw Web Search Test', user.id);
});

async function createActiveOrgInstance(userId: string, organizationId: string): Promise<string> {
  const instanceId = crypto.randomUUID();
  const [row] = await db
    .insert(kiloclaw_instances)
    .values({
      id: instanceId,
      user_id: userId,
      organization_id: organizationId,
      sandbox_id: `ki_${instanceId.replace(/-/g, '')}`,
    })
    .returning({ id: kiloclaw_instances.id });

  if (!row) throw new Error('Failed to create organization KiloClaw instance');
  return row.id;
}

describe('organizations.kiloclaw.patchWebSearchConfig', () => {
  it('patches web search config for the active org instance', async () => {
    const instanceId = await createActiveOrgInstance(user.id, org.id);
    mockPatchWebSearchConfig.mockResolvedValue({ exaMode: 'disabled' });

    const caller = await createCallerForUser(user.id);
    await expect(
      caller.organizations.kiloclaw.patchWebSearchConfig({
        organizationId: org.id,
        exaMode: 'disabled',
      })
    ).resolves.toEqual({ exaMode: 'disabled' });

    expect(mockPatchWebSearchConfig).toHaveBeenCalledTimes(1);
    expect(mockPatchWebSearchConfig).toHaveBeenCalledWith(
      user.id,
      { exaMode: 'disabled' },
      instanceId
    );

    const firstCall = mockPatchWebSearchConfig.mock.calls[0];
    if (!firstCall) throw new Error('Expected patchWebSearchConfig to be called');
    expect(firstCall[1]).not.toHaveProperty('organizationId');
  });

  it('rejects when the organization has no active instance', async () => {
    const caller = await createCallerForUser(user.id);

    await expect(
      caller.organizations.kiloclaw.patchWebSearchConfig({
        organizationId: org.id,
        exaMode: 'disabled',
      })
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'No active KiloClaw instance found for this organization',
    });

    expect(mockPatchWebSearchConfig).not.toHaveBeenCalled();
  });
});
