jest.mock('@/lib/cloud-agent-next/cloud-agent-client', () => ({
  cleanupVercelSnapshotBuild: jest.fn(),
  getVercelComputeEnrollment: jest.fn(),
  startVercelSnapshotBuild: jest.fn(),
}));

jest.mock('@/lib/config.server', () => {
  const actual = jest.requireActual<typeof ConfigServerModule>('@/lib/config.server');
  const { generateKeyPairSync } = jest.requireActual<typeof NodeCryptoModule>('node:crypto');
  const { publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { ...actual, AGENT_ENV_VARS_PUBLIC_KEY: Buffer.from(publicKey).toString('base64') };
});

import type * as NodeCryptoModule from 'node:crypto';
import type * as ConfigServerModule from '@/lib/config.server';
import { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';
import {
  organization_memberships,
  organization_vercel_compute_credentials,
  organizations,
  type User,
} from '@kilocode/db/schema';
import {
  cleanupVercelSnapshotBuild,
  getVercelComputeEnrollment,
  startVercelSnapshotBuild,
} from '@/lib/cloud-agent-next/cloud-agent-client';
import { db } from '@/lib/drizzle';
import { createCallerFactory } from '@/lib/trpc/init';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { organizationVercelComputeRouter } from './organization-vercel-compute-router';

const TOKEN = 'vercel-router-test-token-do-not-expose';
const PROVIDER_DETAIL = 'private-provider-response-detail';
const TEAM = { id: 'team_test', slug: 'test-team', name: 'Test Team' };
const PROJECT = { id: 'prj_test', name: 'test-project', accountId: TEAM.id };
const organizationId = crypto.randomUUID();
const setupInput = { organizationId, token: TOKEN, teamId: TEAM.id, projectId: PROJECT.id };
const providerProcedures = ['discoverTeams', 'discoverProjects', 'add'] as const;
const createCaller = createCallerFactory(organizationVercelComputeRouter);
const mockEnrollment = jest.mocked(getVercelComputeEnrollment);
const mockStartBuild = jest.mocked(startVercelSnapshotBuild);
const mockCleanupBuild = jest.mocked(cleanupVercelSnapshotBuild);

let owner: User;
let organizationAdmin: User;
let billingManager: User;
let member: User;
let outsider: User;
let fetchMock: jest.SpiedFunction<typeof fetch>;

beforeAll(async () => {
  owner = await insertTestUser();
  organizationAdmin = await insertTestUser();
  billingManager = await insertTestUser();
  member = await insertTestUser();
  outsider = await insertTestUser();
  await db.insert(organizations).values({ id: organizationId, name: 'Vercel Discovery Test' });
  await db.insert(organization_memberships).values([
    { organization_id: organizationId, kilo_user_id: owner.id, role: 'owner' },
    { organization_id: organizationId, kilo_user_id: organizationAdmin.id, role: 'admin' },
    { organization_id: organizationId, kilo_user_id: billingManager.id, role: 'billing_manager' },
    { organization_id: organizationId, kilo_user_id: member.id, role: 'member' },
  ]);
});

beforeEach(async () => {
  await db
    .delete(organization_vercel_compute_credentials)
    .where(eq(organization_vercel_compute_credentials.organization_id, organizationId));
  jest.resetAllMocks();
  mockEnrollment.mockResolvedValue(true);
  mockStartBuild.mockResolvedValue(undefined);
  mockCleanupBuild.mockResolvedValue(undefined);
  fetchMock = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected request'));
});

afterEach(() => {
  jest.restoreAllMocks();
});

function mockTeamDiscovery() {
  fetchMock.mockResolvedValueOnce(
    Response.json({
      teams: [{ ...TEAM, token: TOKEN, billing: { secret: PROVIDER_DETAIL } }],
      pagination: { count: 1, next: null, prev: null },
    })
  );
}

function mockProjectDiscovery() {
  fetchMock.mockResolvedValueOnce(Response.json(TEAM)).mockResolvedValueOnce(
    Response.json({
      projects: [{ ...PROJECT, env: [{ value: TOKEN }], secret: PROVIDER_DETAIL }],
      pagination: { count: 1, next: null, prev: null },
    })
  );
}

function mockSelectionValidation(project = PROJECT) {
  fetchMock
    .mockResolvedValueOnce(Response.json(TEAM))
    .mockResolvedValueOnce(Response.json(project));
}

function getCredential() {
  return db.query.organization_vercel_compute_credentials.findFirst({
    where: eq(organization_vercel_compute_credentials.organization_id, organizationId),
  });
}

async function expectNoSetup() {
  expect(await getCredential()).toBeUndefined();
  expect(mockStartBuild).not.toHaveBeenCalled();
  expect(mockCleanupBuild).not.toHaveBeenCalled();
}

async function expectSanitizedError(result: Promise<unknown>, code: TRPCError['code']) {
  const error: unknown = await result.catch((error: unknown) => error);
  expect(error).toBeInstanceOf(TRPCError);
  if (!(error instanceof TRPCError)) throw new Error('Expected a TRPCError');
  expect(error.code).toBe(code);
  expect(error.cause).toBeUndefined();
  const serialized = JSON.stringify(error, Object.getOwnPropertyNames(error));
  expect(serialized).not.toContain(TOKEN);
  expect(serialized).not.toContain(PROVIDER_DETAIL);
}

describe('Vercel discovery authorization', () => {
  it('allows owners and organization admins to discover safe metadata without creating setup rows', async () => {
    for (const user of [owner, organizationAdmin]) {
      const caller = createCaller({ user });
      mockTeamDiscovery();
      await expect(caller.discoverTeams({ organizationId, token: TOKEN })).resolves.toEqual([TEAM]);
      mockProjectDiscovery();
      await expect(
        caller.discoverProjects({ organizationId, token: TOKEN, teamId: TEAM.id })
      ).resolves.toEqual([
        { id: PROJECT.id, name: PROJECT.name, slug: PROJECT.name, teamId: TEAM.id },
      ]);
      await expect(caller.getStatus({ organizationId })).resolves.toBeNull();
    }
    await expectNoSetup();
  });

  it('rejects billing managers, members, and nonmembers before checking enrollment or Vercel', async () => {
    for (const user of [billingManager, member, outsider]) {
      const caller = createCaller({ user });
      for (const procedure of providerProcedures) {
        await expectSanitizedError(caller[procedure](setupInput), 'UNAUTHORIZED');
      }
    }
    expect(mockEnrollment).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    await expectNoSetup();
  });

  it.each(providerProcedures)(
    'requires BYOC enrollment before %s makes a provider request',
    async procedure => {
      mockEnrollment.mockResolvedValue(false);
      const caller = createCaller({ user: owner });

      await expectSanitizedError(caller[procedure](setupInput), 'FORBIDDEN');

      expect(mockEnrollment).toHaveBeenCalledWith(organizationId);
      expect(fetchMock).not.toHaveBeenCalled();
      await expectNoSetup();
    }
  );

  it.each(providerProcedures)(
    'fails closed and sanitizes unavailable enrollment for %s',
    async procedure => {
      mockEnrollment.mockRejectedValue(new Error(`${TOKEN} ${PROVIDER_DETAIL}`));
      const caller = createCaller({ user: owner });

      await expectSanitizedError(caller[procedure](setupInput), 'SERVICE_UNAVAILABLE');

      expect(fetchMock).not.toHaveBeenCalled();
      await expectNoSetup();
    }
  );

  it.each(['', '   ', 'x'.repeat(4097)])(
    'rejects an empty or oversized token before provider requests',
    async token => {
      const caller = createCaller({ user: owner });
      for (const procedure of providerProcedures) {
        await expect(caller[procedure]({ ...setupInput, token })).rejects.toMatchObject({
          code: 'BAD_REQUEST',
        });
      }
      expect(mockEnrollment).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      await expectNoSetup();
    }
  );

  it('uses the same normalized token during discovery and setup', async () => {
    const caller = createCaller({ user: owner });
    mockTeamDiscovery();
    await caller.discoverTeams({ organizationId, token: ` ${TOKEN}\n` });
    mockSelectionValidation();
    await caller.add({ ...setupInput, token: ` ${TOKEN}\n` });

    for (const [, options] of fetchMock.mock.calls) {
      expect(options?.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });
    }
  });
});

describe('Vercel discovery errors', () => {
  it.each([
    [401, 'UNAUTHORIZED'],
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [429, 'TOO_MANY_REQUESTS'],
    [503, 'SERVICE_UNAVAILABLE'],
  ] as const)('maps provider HTTP %s to sanitized application errors', async (status, code) => {
    const caller = createCaller({ user: owner });
    fetchMock.mockImplementation(async () =>
      Response.json({ error: { message: `${TOKEN} ${PROVIDER_DETAIL}` } }, { status })
    );

    for (const procedure of providerProcedures) {
      await expectSanitizedError(caller[procedure](setupInput), code);
    }

    await expect(caller.getStatus({ organizationId })).resolves.toBeNull();
    await expectNoSetup();
  });

  it('rejects malformed provider responses without returning their contents or starting setup', async () => {
    const caller = createCaller({ user: owner });
    fetchMock.mockImplementation(async () =>
      Response.json({ token: TOKEN, private: PROVIDER_DETAIL })
    );

    for (const procedure of providerProcedures) {
      await expectSanitizedError(caller[procedure](setupInput), 'BAD_GATEWAY');
    }
    await expectNoSetup();
  });

  it('does not expose network errors or their causes', async () => {
    const caller = createCaller({ user: owner });
    fetchMock.mockRejectedValue(new Error(TOKEN, { cause: { secret: PROVIDER_DETAIL } }));

    await expectSanitizedError(caller.discoverTeams(setupInput), 'SERVICE_UNAVAILABLE');
    await expectNoSetup();
  });
});

describe('Vercel setup validation', () => {
  it('validates the selected team and project before storing an encrypted credential and starting setup', async () => {
    const caller = createCaller({ user: owner });
    fetchMock.mockImplementation(async url => {
      expect(await getCredential()).toBeUndefined();
      expect(mockStartBuild).not.toHaveBeenCalled();
      return Response.json(String(url).includes('/v2/teams/') ? TEAM : PROJECT);
    });

    const status = await caller.add(setupInput);
    const credential = await getCredential();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(status).toMatchObject({
      organizationId,
      teamId: TEAM.id,
      projectId: PROJECT.id,
      setupStatus: 'pending',
      setupStep: 'validating_access',
    });
    expect(credential).toMatchObject({
      id: status.credentialId,
      organization_id: organizationId,
      team_id: TEAM.id,
      project_id: PROJECT.id,
      setup_status: 'pending',
      token_encrypted: {
        scheme: 'byoc-vercel-credential-rsa-aes-256-gcm',
        keyId: 'agent-env-vars-v1',
      },
    });
    expect(JSON.stringify(credential)).not.toContain(TOKEN);
    expect(mockStartBuild).toHaveBeenCalledWith({
      organizationId,
      credentialId: status.credentialId,
      buildGeneration: status.buildGeneration,
    });
    const savedStatus = await caller.getStatus({ organizationId });
    expect(savedStatus).toEqual(status);
    expect(savedStatus).not.toHaveProperty('token');
    expect(savedStatus).not.toHaveProperty('token_encrypted');
    expect(JSON.stringify(savedStatus)).not.toContain(TOKEN);
  });

  it('revalidates a changed token after successful discovery without persisting it', async () => {
    const caller = createCaller({ user: owner });
    mockTeamDiscovery();
    mockProjectDiscovery();
    await caller.discoverTeams(setupInput);
    await caller.discoverProjects(setupInput);
    fetchMock.mockResolvedValueOnce(Response.json({ error: TOKEN }, { status: 401 }));

    await expectSanitizedError(
      caller.add({ ...setupInput, token: 'changed-invalid-token' }),
      'UNAUTHORIZED'
    );

    expect(fetchMock).toHaveBeenLastCalledWith(
      `https://api.vercel.com/v2/teams/${TEAM.id}`,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer changed-invalid-token' }),
      })
    );
    await expectNoSetup();
  });

  it.each([
    { teamId: 'team_other', projectId: PROJECT.id },
    { teamId: TEAM.id, projectId: 'prj_other' },
  ])('rejects a tampered selection $teamId/$projectId', async selection => {
    const caller = createCaller({ user: owner });
    mockSelectionValidation();

    await expectSanitizedError(caller.add({ ...setupInput, ...selection }), 'FORBIDDEN');
    await expectNoSetup();
  });

  it('rejects a project that moved to another team after discovery', async () => {
    const caller = createCaller({ user: owner });
    mockProjectDiscovery();
    await caller.discoverProjects(setupInput);
    mockSelectionValidation({ ...PROJECT, accountId: 'team_other' });

    await expectSanitizedError(caller.add(setupInput), 'FORBIDDEN');
    await expectNoSetup();
  });

  it('rejects a project that was deleted after discovery', async () => {
    const caller = createCaller({ user: owner });
    mockProjectDiscovery();
    await caller.discoverProjects(setupInput);
    fetchMock
      .mockResolvedValueOnce(Response.json(TEAM))
      .mockResolvedValueOnce(Response.json({ error: TOKEN }, { status: 404 }));

    await expectSanitizedError(caller.add(setupInput), 'NOT_FOUND');
    await expectNoSetup();
  });

  it('keeps discovery read-only when credentials already exist and preserves the unique-organization guard', async () => {
    const caller = createCaller({ user: owner });
    mockSelectionValidation();
    await caller.add(setupInput);
    const existing = await getCredential();
    mockStartBuild.mockClear();
    mockTeamDiscovery();
    mockProjectDiscovery();

    await caller.discoverTeams(setupInput);
    await caller.discoverProjects(setupInput);
    expect(await getCredential()).toEqual(existing);
    expect(mockStartBuild).not.toHaveBeenCalled();

    fetchMock.mockClear();
    await expectSanitizedError(caller.add(setupInput), 'CONFLICT');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await getCredential()).toEqual(existing);
  });

  it('preserves failed setup, retry, and unenrolled removal without exposing the token', async () => {
    const caller = createCaller({ user: owner });
    mockSelectionValidation();
    mockStartBuild.mockRejectedValueOnce(new Error(`${TOKEN} ${PROVIDER_DETAIL}`));

    await expect(caller.add(setupInput)).rejects.toMatchObject({
      message: 'Cloud Agent snapshot build could not be started',
    });
    const failed = await caller.getStatus({ organizationId });
    expect(failed).toMatchObject({ setupStatus: 'failed', setupError: 'setup_start_failed' });
    expect(JSON.stringify(failed)).not.toContain(TOKEN);
    expect(JSON.stringify(failed)).not.toContain(PROVIDER_DETAIL);

    const retried = await caller.retrySetup({ organizationId });
    expect(retried.credentialId).toBe(failed?.credentialId);
    expect(retried.buildGeneration).not.toBe(failed?.buildGeneration);
    expect(retried.setupStatus).toBe('pending');
    expect(retried.setupError).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    mockEnrollment.mockResolvedValue(false);
    await expect(caller.remove({ organizationId })).resolves.toEqual({ success: true });
    await expect(caller.getStatus({ organizationId })).resolves.toBeNull();
    expect(mockCleanupBuild).toHaveBeenCalledTimes(2);
  });
});
