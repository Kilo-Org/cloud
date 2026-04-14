import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { NextResponse } from 'next/server';
import { cleanupDbForTest, db } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createOrganization, addUserToOrganization } from '@/lib/organizations/organizations';
import { kiloclaw_instances } from '@kilocode/db/schema';
import { failureResult } from '@/lib/maybe-result';
import type { User } from '@kilocode/db/schema';
import type { KiloClawUserClient } from '@/lib/kiloclaw/kiloclaw-user-client';
import type { PlatformStatusResponse } from '@/lib/kiloclaw/types';
import type { getUserFromAuth } from '@/lib/user.server';

type GetUserFromAuthResult = Awaited<ReturnType<typeof getUserFromAuth>>;
type GetStatusResult = Awaited<ReturnType<KiloClawUserClient['getStatus']>>;

const mockGetUserFromAuth = jest.fn<() => Promise<GetUserFromAuthResult>>();
const mockGetStatus = jest.fn<() => Promise<GetStatusResult>>();

jest.mock('@/lib/user.server', () => ({
  getUserFromAuth: mockGetUserFromAuth,
}));

jest.mock('@/lib/kiloclaw/kiloclaw-user-client', () => ({
  KiloClawUserClient: jest.fn().mockImplementation(() => ({
    getStatus: mockGetStatus,
  })),
}));

function setUserAuth(user: User, organizationId?: string) {
  mockGetUserFromAuth.mockResolvedValue({
    user,
    authFailedResponse: null,
    organizationId,
  });
}

function makeStatusResponse(userId: string, sandboxId: string): PlatformStatusResponse {
  return {
    userId,
    sandboxId,
    provider: 'fly',
    runtimeId: null,
    storageId: null,
    region: null,
    status: 'running',
    provisionedAt: null,
    lastStartedAt: null,
    lastStoppedAt: null,
    envVarCount: 0,
    secretCount: 0,
    channelCount: 0,
    flyAppName: null,
    flyMachineId: null,
    flyVolumeId: null,
    flyRegion: null,
    machineSize: null,
    openclawVersion: null,
    imageVariant: null,
    trackedImageTag: null,
    trackedImageDigest: null,
    googleConnected: false,
    gmailNotificationsEnabled: false,
    execSecurity: null,
    execAsk: null,
    botName: null,
    botNature: null,
    botVibe: null,
    botEmoji: null,
  };
}

describe('GET /api/kiloclaw/status', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
    jest.clearAllMocks();
    mockGetUserFromAuth.mockReset();
    mockGetStatus.mockReset();
  });

  it('allows admins to resolve an org instance without membership', async () => {
    const adminUser = await insertTestUser({
      google_user_email: 'admin-kiloclaw-status@admin.example.com',
      is_admin: true,
    });
    const organization = await createOrganization('Admin Status Org', null, false);

    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({
        user_id: adminUser.id,
        sandbox_id: 'org-sandbox-admin',
        organization_id: organization.id,
        name: 'Org Claw',
      })
      .returning();

    setUserAuth(adminUser, organization.id);
    mockGetStatus.mockResolvedValue(makeStatusResponse(adminUser.id, instance.sandbox_id));

    const { GET } = await import('./route');
    const response = await GET();

    expect(response.status).toBe(200);
    expect(mockGetStatus).toHaveBeenCalledTimes(1);
  });

  it('rejects non-members on the org path before querying worker status', async () => {
    const user = await insertTestUser({
      google_user_email: 'non-member-kiloclaw-status@example.com',
    });
    const organization = await createOrganization('Non Member Org', null, false);

    setUserAuth(user, organization.id);

    const { GET } = await import('./route');
    const response = await GET();

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'You do not have access to this organization' });
    expect(mockGetStatus).not.toHaveBeenCalled();
  });

  it('returns 404 for org context with no active instance instead of falling back to personal', async () => {
    const user = await insertTestUser({
      google_user_email: 'org-status-no-instance@example.com',
    });
    const organization = await createOrganization('Org Without Instance', null, false);
    await addUserToOrganization(organization.id, user.id, 'member');

    setUserAuth(user, organization.id);

    const { GET } = await import('./route');
    const response = await GET();

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'No active instance for this organization' });
    expect(mockGetStatus).not.toHaveBeenCalled();
  });

  it('still resolves org status for a normal org member', async () => {
    const user = await insertTestUser({
      google_user_email: 'member-kiloclaw-status@example.com',
    });
    const organization = await createOrganization('Member Status Org', null, false);
    await addUserToOrganization(organization.id, user.id, 'member');

    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({
        user_id: user.id,
        sandbox_id: 'org-sandbox-member',
        organization_id: organization.id,
        name: 'Member Org Claw',
      })
      .returning();

    setUserAuth(user, organization.id);
    mockGetStatus.mockResolvedValue(makeStatusResponse(user.id, instance.sandbox_id));

    const { GET } = await import('./route');
    const response = await GET();

    expect(response.status).toBe(200);
    expect(mockGetStatus).toHaveBeenCalledTimes(1);
  });

  it('still resolves personal status without an organization context', async () => {
    const user = await insertTestUser({
      google_user_email: 'personal-kiloclaw-status@example.com',
    });

    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({
        user_id: user.id,
        sandbox_id: 'personal-sandbox',
        organization_id: null,
        name: 'Personal Claw',
      })
      .returning();

    setUserAuth(user);
    mockGetStatus.mockResolvedValue(makeStatusResponse(user.id, instance.sandbox_id));

    const { GET } = await import('./route');
    const response = await GET();

    expect(response.status).toBe(200);
    expect(mockGetStatus).toHaveBeenCalledTimes(1);
  });

  it('returns the auth failure response unchanged', async () => {
    const authFailedResponse = NextResponse.json(failureResult('Unauthorized'), { status: 401 });
    mockGetUserFromAuth.mockResolvedValue({
      user: null,
      authFailedResponse,
    });

    const { GET } = await import('./route');
    const response = await GET();

    expect(response).toBe(authFailedResponse);
    expect(mockGetStatus).not.toHaveBeenCalled();
  });
});
