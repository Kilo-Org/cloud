import { afterAll, beforeAll, beforeEach, describe, expect, test } from '@jest/globals';
import { randomUUID } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { eq, inArray } from 'drizzle-orm';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { code_indexing_manifest, type Organization, type User } from '@kilocode/db/schema';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { addUserToOrganization } from '@kilocode/web-shared/lib/organizations/organizations';
import {
  ALLOWED_ADMIN_ADDRESS,
  withAdminStepUpEnabled,
  withEnforcedAdminNetwork,
} from '@/tests/helpers/admin-network.helper';
import { POST } from './route';

const mockAvailability = { enabled: true };

jest.mock('@kilocode/web-shared/lib/user/server', () => ({
  ...jest.requireActual<Record<string, unknown>>('@kilocode/web-shared/lib/user/server'),
  getUserFromAuth: jest.fn(),
}));

jest.mock('@/lib/code-indexing/availability.server', () => ({
  CODE_INDEXING_GONE_MESSAGE: 'Managed code indexing is no longer available.',
  isCodeIndexingEnabled: () => mockAvailability.enabled,
  codeIndexingGoneResponse: () =>
    Response.json(
      { error: 'gone', message: 'Managed code indexing is no longer available.' },
      { status: 410 }
    ),
}));

// A fixed minimum the gate enforces; the real version comparison runs.
jest.mock('@kilocode/web-shared/lib/trpc/min-version', () => ({
  ...jest.requireActual<Record<string, unknown>>('@kilocode/web-shared/lib/trpc/min-version'),
  getMinimumVersions: async () => ({ ios: '2.0.0', android: '2.0.0' }),
}));

type MilvusDelete = { collection_name: string; filter: string };

jest.mock('@/lib/code-indexing/milvus', () => {
  const deletes: MilvusDelete[] = [];
  return {
    getMilvusClient: () => ({
      delete: async (params: MilvusDelete) => {
        deletes.push(params);
      },
    }),
    __milvusDeletes: deletes,
  };
});

const milvusDeletes = () =>
  jest.requireMock<{ __milvusDeletes: MilvusDelete[] }>('@/lib/code-indexing/milvus')
    .__milvusDeletes;

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);

const ROUTE = '/api/code-indexing/delete';

function createRequest(body?: string, headers: Record<string, string> = {}) {
  return new NextRequest(`http://localhost:3000${ROUTE}`, {
    method: 'POST',
    body,
    // The app middleware sets `x-pathname` on every request.
    headers: { 'Content-Type': 'application/json', 'x-pathname': ROUTE, ...headers },
  });
}

/** A browser session of `user`, as `getUserFromAuth` resolves it. */
function signInWithSession(user: User) {
  mockedGetUserFromAuth.mockResolvedValue({
    authFailedResponse: null,
    user,
    credential: 'session',
    webSessionId: 'test-web-session',
    webSessionPepper: user.web_session_pepper,
  } as never);
}

async function manifestFiles(organizationId: string): Promise<string[]> {
  const rows = await db
    .select({ filePath: code_indexing_manifest.file_path })
    .from(code_indexing_manifest)
    .where(eq(code_indexing_manifest.organization_id, organizationId));
  return rows.map(row => row.filePath).sort();
}

describe('POST /api/code-indexing/delete', () => {
  let owner: User;
  let member: User;
  let admin: User;
  let organization: Organization;

  beforeAll(async () => {
    const suffix = randomUUID().slice(0, 8);
    owner = await insertTestUser({
      id: randomUUID(),
      google_user_email: `code-index-rest-owner-${suffix}@example.com`,
    });
    member = await insertTestUser({
      id: randomUUID(),
      google_user_email: `code-index-rest-member-${suffix}@example.com`,
    });
    admin = await insertTestUser({
      id: randomUUID(),
      google_user_email: `code-index-rest-admin-${suffix}@example.com`,
      is_admin: true,
    });
    organization = await createTestOrganization(`Code Index REST ${suffix}`, owner.id, 0);
    await addUserToOrganization(organization.id, member.id, 'member');
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    mockAvailability.enabled = true;
    milvusDeletes().length = 0;
    await db
      .delete(code_indexing_manifest)
      .where(inArray(code_indexing_manifest.organization_id, [organization.id, member.id]));
    await db.insert(code_indexing_manifest).values({
      organization_id: organization.id,
      kilo_user_id: owner.id,
      project_id: 'acme/app',
      git_branch: 'main',
      file_hash: randomUUID(),
      file_path: 'src/old.ts',
      chunk_count: 3,
    });
  });

  afterAll(async () => {
    await db
      .delete(code_indexing_manifest)
      .where(inArray(code_indexing_manifest.organization_id, [organization.id, member.id]));
  });

  test('returns 400 for malformed JSON body', async () => {
    const response = await POST(createRequest('not-json{'));

    expect(response.status).toBe(400);
    expect(mockedGetUserFromAuth).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      error: 'Invalid JSON body',
      message: 'Invalid JSON body',
    });
  });

  test('returns 400 for an absent body', async () => {
    const response = await POST(createRequest());

    expect(response.status).toBe(400);
    expect(mockedGetUserFromAuth).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      error: 'Invalid JSON body',
      message: 'Invalid JSON body',
    });
  });

  test('keeps the 401 for a blocked account off the mobile client and changes nothing', async () => {
    mockedGetUserFromAuth.mockResolvedValue({
      user: null,
      refusalReason: 'account_blocked',
      authFailedResponse: NextResponse.json(
        { success: false, error: 'Access denied (R1)' },
        { status: 403 }
      ),
    } as never);

    const response = await POST(
      createRequest(JSON.stringify({ organizationId: organization.id, projectId: 'acme/app' }))
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: 'User not authenticated - no user to set on context',
      message: 'User not authenticated - no user to set on context',
    });
    expect(await manifestFiles(organization.id)).toEqual(['src/old.ts']);
  });

  test('returns 400 for a body that fails validation', async () => {
    signInWithSession(member);

    const response = await POST(createRequest(JSON.stringify({ organizationId: organization.id })));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: 'Validation failed' });
    expect(await manifestFiles(organization.id)).toEqual(['src/old.ts']);
  });

  test('lets an organization member delete files through its membership', async () => {
    signInWithSession(member);

    const response = await POST(
      createRequest(
        JSON.stringify({
          organizationId: organization.id,
          projectId: 'acme/app',
          filePaths: ['src/old.ts'],
        })
      )
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true, deletedFiles: 1 });
    expect(await manifestFiles(organization.id)).toEqual([]);
  });

  test('keeps the ordinary { success: false } answer for an account without the entitlement', async () => {
    signInWithSession(member);

    const response = await POST(createRequest(JSON.stringify({ projectId: 'me/local' })));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: false, deletedFiles: 0 });
    expect(milvusDeletes()).toHaveLength(0);
  });

  test('binds a staff organization write proof to this REST pathname and method', async () => {
    signInWithSession(admin);

    const response = await withEnforcedAdminNetwork(() =>
      withAdminStepUpEnabled(() =>
        POST(
          createRequest(
            JSON.stringify({
              organizationId: organization.id,
              projectId: 'acme/app',
              filePaths: ['src/old.ts'],
            }),
            ALLOWED_ADMIN_ADDRESS
          )
        )
      )
    );

    expect(response.status).toBe(403);
    const body = (await response.json()) as { stepUp?: { binding?: unknown } };
    expect(body.stepUp?.binding).toEqual({
      actionClass: 'support_write',
      surface: 'rest',
      route: ROUTE,
      method: 'post',
      targetKind: 'organization',
      targetId: organization.id,
    });
    expect(await manifestFiles(organization.id)).toEqual(['src/old.ts']);
    expect(milvusDeletes()).toHaveLength(0);
  });

  test('refuses a Cloud Agent authority as the tRPC adapter did and changes nothing', async () => {
    mockedGetUserFromAuth.mockResolvedValue({
      authFailedResponse: null,
      user: member,
      credential: 'session',
      cloudAgentAuthority: { ownerId: member.id },
    } as never);

    const response = await POST(
      createRequest(
        JSON.stringify({
          organizationId: organization.id,
          projectId: 'acme/app',
          filePaths: ['src/old.ts'],
        })
      )
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'Cloud Agent authority denied',
      message: 'Cloud Agent authority denied',
    });
    expect(mockedGetUserFromAuth).toHaveBeenCalledWith(
      expect.objectContaining({ requestPathname: ROUTE })
    );
    expect(await manifestFiles(organization.id)).toEqual(['src/old.ts']);
    expect(milvusDeletes()).toHaveLength(0);
  });

  describe('mobile client', () => {
    const mobileHeaders = (version: string) => ({
      'x-kilo-client': 'mobile',
      'x-kilo-app-platform': 'ios',
      'x-kilo-app-version': version,
    });
    const body = () =>
      JSON.stringify({
        organizationId: organization.id,
        projectId: 'acme/app',
        filePaths: ['src/old.ts'],
      });

    test('refuses an app below the minimum version with the app update answer', async () => {
      signInWithSession(member);

      const response = await POST(createRequest(body(), mobileHeaders('1.9.9')));

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        error: 'App update required',
        message: 'App update required',
      });
      expect(await manifestFiles(organization.id)).toEqual(['src/old.ts']);
      expect(milvusDeletes()).toHaveLength(0);
    });

    test('refuses a blocked account with the 403 blocked answer, not the 401', async () => {
      mockedGetUserFromAuth.mockResolvedValue({
        user: null,
        refusalReason: 'account_blocked',
        authFailedResponse: NextResponse.json(
          { success: false, error: 'Access denied (R1)' },
          { status: 403 }
        ),
      } as never);

      const response = await POST(createRequest(body(), mobileHeaders('2.0.0')));

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        error: 'Account access is blocked',
        message: 'Account access is blocked',
      });
      expect(await manifestFiles(organization.id)).toEqual(['src/old.ts']);
    });

    test('lets a current app delete files', async () => {
      signInWithSession(member);

      const response = await POST(createRequest(body(), mobileHeaders('2.0.0')));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ success: true, deletedFiles: 1 });
      expect(await manifestFiles(organization.id)).toEqual([]);
    });
  });
});
