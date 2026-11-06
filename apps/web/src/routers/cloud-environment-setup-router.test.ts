import { generateKeyPairSync } from 'node:crypto';
import { canContinueEnvironmentSetup } from '@/components/cloud-agent-next/environment-setup-display';
import type * as SetupWorker from '@/lib/cloud-agent/environment-setup/worker';
import type * as PublishValidation from '@/lib/cloud-agent/environment-setup/publish-validation';
import { beforeAll, beforeEach, afterEach, describe, expect, jest, test } from '@jest/globals';
import {
  createCallerFactory,
  createTRPCRouter,
  type TRPCContext,
} from '@kilocode/web-shared/lib/trpc/init';
import { db, cleanupDbForTest } from '@kilocode/web-shared/lib/drizzle';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { addUserToOrganization } from '@kilocode/web-shared/lib/organizations/organizations';
import {
  cloud_agent_environment_setup_runs as runs,
  cloud_agent_environments as environments,
  type User,
} from '@kilocode/db/schema';
import {
  createSetupRunWithDraft,
  getSetupRun,
  getEnvironment,
  attachSetupSession,
  reserveVerification,
  attachVerificationChild,
  updateEnvironment,
  type EnvironmentOwner,
  createEnvironment,
  addSecretRequests,
  recordVerification,
  cancelSetupRun,
} from '@kilocode/cloud-agent-profile';
import {
  getSandboxAllocationRequest,
  type SandboxAllocationRequest,
} from '@kilocode/worker-utils/sandbox-allocation';
import {
  ParentCallbackTargetSchema,
  type CloudAgentAuthority,
} from '@kilocode/worker-utils/cloud-agent-authority';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

const mockBeforePublish = jest.fn<() => void>();
jest.mock('@/lib/cloud-agent/environment-setup/publish-validation', () => {
  const actual = jest.requireActual<typeof PublishValidation>(
    '@/lib/cloud-agent/environment-setup/publish-validation'
  );
  return {
    ...actual,
    assertDraftPublishable: (draft: Parameters<typeof actual.assertDraftPublishable>[0]) => {
      actual.assertDraftPublishable(draft);
      mockBeforePublish();
    },
  };
});

const mockEnabled = jest.fn(async () => true);
const mockPrepare =
  jest.fn<(input: unknown) => Promise<{ cloudAgentSessionId: string; kiloSessionId: string }>>();
const mockGetSession = jest.fn<(id: string) => Promise<unknown>>();
const mockSendMessage = jest.fn<(input: unknown) => Promise<unknown>>();
const mockGetEgressAudit =
  jest.fn<
    (
      input: unknown
    ) => Promise<{ records: { hostname: string; decision: string }[]; nextCursor: number | null }>
  >();
const mockClient = {
  prepareSession: mockPrepare,
  getSession: mockGetSession,
  sendMessage: mockSendMessage,
  interruptSession: jest.fn(async () => ({})),
  getEgressAudit: mockGetEgressAudit,
};
const mockCapabilities = jest.fn<
  () => Promise<{
    enabled: boolean;
    options: { allocation: SandboxAllocationRequest }[];
  }>
>(async () => ({
  enabled: true,
  options: [
    { allocation: getSandboxAllocationRequest('cloudflare-containers-standard-3') },
    { allocation: getSandboxAllocationRequest('cloudflare-containers-standard-4') },
  ],
}));

jest.mock('@kilocode/web-shared/lib/posthog-feature-flags', () => ({
  isReleaseToggleEnabled: mockEnabled,
}));
jest.mock('@/lib/cloud-agent/environment-setup/worker', () => ({
  ...jest.requireActual<typeof SetupWorker>('@/lib/cloud-agent/environment-setup/worker'),
  userCloudAgentClient: jest.fn(async () => mockClient),
}));
jest.mock('@/lib/cloud-agent-next/sandbox-allocation-offers', () => ({
  loadSandboxCapabilities: mockCapabilities,
}));
jest.mock('@/lib/cloud-agent-next/github-prepare-params', () => ({
  resolveGitHubPrepareParams: jest.fn(async (input: { githubRepo: string }) => ({
    githubRepo: input.githubRepo,
    platform: 'github',
  })),
}));

async function buildCaller() {
  const { cloudEnvironmentsRouter } = await import('./cloud-environments-router');
  return createCallerFactory(createTRPCRouter({ cloudEnvironments: cloudEnvironmentsRouter }));
}
let callerFactory: Awaited<ReturnType<typeof buildCaller>>;
beforeAll(async () => {
  callerFactory = await buildCaller();
});
const setupSessionId = 'workspace_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const childSessionId = 'workspace_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const kiloSessionId = 'ses_12345678901234567890123456';
const repositories = [{ platform: 'github' as const, fullName: 'acme/widgets' }];
const checks = [{ name: 'smoke', command: 'true', expect: 'success' }];
function caller(user: User, cloudAgentAuthority?: CloudAgentAuthority) {
  return callerFactory({ user, cloudAgentAuthority } as TRPCContext).cloudEnvironments.setupRuns;
}
async function runFor(user: User, owner: EnvironmentOwner = { type: 'user', id: user.id }) {
  const created = await db.transaction(tx =>
    createSetupRunWithDraft(tx, '', {
      owner,
      createdByUserId: user.id,
      repositories: [{ platform: 'github', repoFullName: 'acme/widgets' }],
      requirements: 'Run tests',
      egressMode: 'allowlist',
      model: 'test/model',
      variant: 'test-variant',
      launchRepoFullName: 'acme/widgets',
      sandboxOptions: ['cloudflare-containers-standard-3'],
    })
  );
  await db.transaction(tx =>
    attachSetupSession(tx, {
      runId: created.runId,
      owner,
      cloudAgentSessionId: setupSessionId,
      kiloSessionId,
    })
  );
  return { ...created, owner };
}
function authority(
  user: User,
  runId: string,
  environmentId: string,
  organizationId: string | null = null
): CloudAgentAuthority {
  return {
    version: 1,
    ownerId: user.id,
    parentSessionId: setupSessionId,
    organizationId,
    authorizationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    environmentSetup: { runId, environmentId },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockEnabled.mockResolvedValue(true);
  mockCapabilities.mockResolvedValue({
    enabled: true,
    options: [
      { allocation: getSandboxAllocationRequest('cloudflare-containers-standard-3') },
      { allocation: getSandboxAllocationRequest('cloudflare-containers-standard-4') },
    ],
  });
  mockPrepare.mockResolvedValue({ cloudAgentSessionId: setupSessionId, kiloSessionId });
  mockGetSession.mockResolvedValue({ execution: { status: 'running' } });
  mockSendMessage.mockResolvedValue({});
  mockGetEgressAudit.mockResolvedValue({ records: [], nextCursor: null });
});
afterEach(async () => {
  await cleanupDbForTest();
});

describe('environment setup user procedures', () => {
  test('toggle off hides operations and reports disabled', async () => {
    const user = await insertTestUser();
    mockEnabled.mockResolvedValue(false);
    const api = caller(user);
    expect(await api.isEnabled({})).toEqual({ enabled: false, canStart: false });
    const runId = crypto.randomUUID();
    const operations = [
      () => api.start({ repositories, requirements: 'Run tests', model: 'test/model' }),
      () => api.get({ runId }),
      () => api.getBySession({ cloudAgentSessionId: setupSessionId }),
      () => api.listForEnvironment({ environmentId: crypto.randomUUID() }),
      () => api.resolveSecretRequests({ runId, skipped: [] }),
      () => api.resolveNetworkRequests({ runId, approved: [], declined: [] }),
      () => api.publish({ runId, force: false }),
      () => api.revert({ runId, force: false }),
      () => api.cancel({ runId }),
      () => api.resume({ runId, raiseVerificationLimit: false }),
      () => api.buildSnapshot({ runId }),
    ];
    for (const operation of operations)
      await expect(operation()).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  test('GitLab-first input is rejected before creating or preparing a setup', async () => {
    const user = await insertTestUser();
    await expect(
      caller(user).start({
        repositories: [{ platform: 'gitlab', projectPath: 'acme/widgets' }, ...repositories],
        requirements: 'Run tests',
        model: 'test/model',
      })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'The first repository must be a GitHub repository.',
    });
    expect(await db.select().from(runs)).toEqual([]);
    expect(await db.select().from(environments)).toEqual([]);
    expect(mockPrepare).not.toHaveBeenCalled();
  });
  test.each([undefined, 'unrestricted', 'allowlist'] as const)(
    'start applies network choice %s and attaches the setup session',
    async egressMode => {
      const user = await insertTestUser();
      const result = await caller(user).start({
        repositories,
        requirements: 'Run tests',
        model: 'test/model',
        egressMode,
      });
      const run = await getSetupRun(db, result.runId, { type: 'user', id: user.id });
      expect(run).toMatchObject({
        status: 'running',
        cloud_agent_session_id: setupSessionId,
        kilo_session_id: kiloSessionId,
      });
      expect(
        await getEnvironment(db, run.draft_environment_id!, { type: 'user', id: user.id })
      ).toMatchObject({
        isDraft: true,
        egressMode: egressMode ?? 'unrestricted',
        sandboxAllocation: 'cloudflare-containers-standard-3',
      });
      expect(mockPrepare).toHaveBeenCalledWith(
        expect.objectContaining({
          sandboxAllocation: 'cloudflare-containers-standard-4',
          environmentSetupRunId: run.id,
          requestedEnvironment: { id: run.draft_environment_id },
          operationKey: run.id,
          autoCommit: false,
          runtimeSkills: [expect.objectContaining({ name: 'environment-setup' })],
        })
      );
    }
  );
  test.each(['cloudflare-containers-standard-3', 'cloudflare-containers-standard-4'] as const)(
    'start requires both sizes when only %s is available',
    async allocation => {
      const user = await insertTestUser();
      mockCapabilities.mockResolvedValue({
        enabled: true,
        options: [{ allocation: getSandboxAllocationRequest(allocation) }],
      });
      await expect(
        caller(user).start({ repositories, requirements: 'Run tests', model: 'test/model' })
      ).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        message: 'Environment setup needs standard-4 for setup and standard-3 for verification.',
      });
      expect(await db.select().from(runs)).toEqual([]);
      expect(mockPrepare).not.toHaveBeenCalled();
    }
  );
  test('refinement develops on standard-4 and reserves default-size verification', async () => {
    const user = await insertTestUser();
    const owner = { type: 'user', id: user.id } as const;
    const target = await db.transaction(tx =>
      createEnvironment(tx, '', {
        owner,
        createdByUserId: user.id,
        name: 'Existing large environment',
        repositories: [{ platform: 'github', repoFullName: 'acme/widgets' }],
        sandboxAllocation: 'cloudflare-containers-standard-4',
      })
    );
    const created = await caller(user).start({
      repositories,
      requirements: 'Run tests',
      model: 'test/model',
      targetEnvironmentId: target.id,
    });
    const run = await getSetupRun(db, created.runId, owner);
    if (!run.draft_environment_id) throw new Error('Expected draft');
    expect(mockPrepare).toHaveBeenLastCalledWith(
      expect.objectContaining({ sandboxAllocation: 'cloudflare-containers-standard-4' })
    );
    expect(await getEnvironment(db, target.id, owner)).toMatchObject({
      sandboxAllocation: 'cloudflare-containers-standard-4',
    });
    expect(await getEnvironment(db, run.draft_environment_id, owner)).toMatchObject({
      sandboxAllocation: 'cloudflare-containers-standard-3',
    });
    mockPrepare.mockResolvedValueOnce({ cloudAgentSessionId: childSessionId, kiloSessionId });
    await caller(user, authority(user, run.id, run.draft_environment_id)).agent.startVerification({
      runId: run.id,
      checks,
    });
    expect(mockPrepare.mock.lastCall?.[0]).not.toHaveProperty('sandboxAllocation');
    expect(mockPrepare).toHaveBeenLastCalledWith(
      expect.objectContaining({ requestedEnvironment: { id: run.draft_environment_id } })
    );
    expect((await getSetupRun(db, run.id, owner)).pending_verification).toMatchObject({
      sandboxAllocation: 'cloudflare-containers-standard-3',
    });
  });
  test('start cancels the run when its session fails to start', async () => {
    const user = await insertTestUser();
    mockPrepare.mockRejectedValue(new Error('integration unavailable'));
    await expect(
      caller(user).start({ repositories, requirements: 'Run tests', model: 'test/model' })
    ).rejects.toThrow('integration unavailable');
    expect(await db.select().from(runs).where(eq(runs.owned_by_user_id, user.id))).toEqual([
      expect.objectContaining({
        status: 'cancelled',
        status_reason: 'session_start_failed',
        status_detail: 'integration unavailable',
      }),
    ]);
  });
  test('unavailable isolated allocations create no rows', async () => {
    const user = await insertTestUser();
    mockCapabilities.mockResolvedValue({ enabled: true, options: [] });
    await expect(
      caller(user).start({ repositories, requirements: 'Run tests', model: 'test/model' })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(await db.select().from(runs)).toEqual([]);
  });
  test('allocations without network auditing cannot start discovery', async () => {
    const user = await insertTestUser();
    mockCapabilities.mockResolvedValue({
      enabled: true,
      options: [{ allocation: getSandboxAllocationRequest('vercel-large') }],
    });
    await expect(
      caller(user).start({ repositories, requirements: 'Run tests', model: 'test/model' })
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('network auditing'),
    });
    expect(await db.select().from(runs)).toEqual([]);
    expect(mockPrepare).not.toHaveBeenCalled();
  });
  test('members and billing managers can read, but cannot manage runs', async () => {
    const ownerUser = await insertTestUser();
    const org = await createTestOrganization('Setup org', ownerUser.id, 0);
    const run = await runFor(ownerUser, { type: 'organization', id: org.id });
    for (const role of ['member', 'billing_manager'] as const) {
      const user = await insertTestUser();
      await addUserToOrganization(org.id, user.id, role);
      const api = caller(user);
      const input = { organizationId: org.id, runId: run.runId };
      expect(await api.get(input)).toMatchObject({ id: run.runId });
      for (const operation of [
        () => api.start({ organizationId: org.id, repositories, requirements: 'x', model: 'x' }),
        () => api.resolveSecretRequests({ ...input, skipped: [] }),
        () => api.publish(input),
        () => api.revert(input),
        () => api.cancel(input),
        () => api.resume(input),
      ])
        await expect(operation()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      expect(await api.isEnabled({ organizationId: org.id })).toMatchObject({ canStart: false });
    }
  });
  test('get reports stopped execution', async () => {
    const user = await insertTestUser();
    const run = await runFor(user);
    mockGetSession.mockResolvedValue({ execution: { status: 'failed', error: 'execution_limit' } });
    expect(await caller(user).get({ runId: run.runId })).toMatchObject({
      agentState: { kind: 'stopped', reason: 'execution_limit' },
    });
  });
  test('publish requires confirmation for a conflict', async () => {
    const user = await insertTestUser();
    const run = await runFor(user);
    await db.update(runs).set({ status: 'publish_conflict' }).where(eq(runs.id, run.runId));
    await expect(caller(user).publish({ runId: run.runId })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(await caller(user).publish({ runId: run.runId, force: true })).toMatchObject({
      status: 'published',
    });
  });
});

describe('environment setup agent procedures', () => {
  test('requires a matching authority claim', async () => {
    const user = await insertTestUser();
    const run = await runFor(user);
    await expect(caller(user).agent.getDraft({ runId: run.runId })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      caller(user, authority(user, crypto.randomUUID(), run.draftEnvironmentId)).agent.getDraft({
        runId: run.runId,
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  test('getDraft exposes keys and offered allocations without secret values', async () => {
    const user = await insertTestUser();
    const run = await runFor(user);
    await db.transaction(tx =>
      updateEnvironment(tx, '', {
        environmentId: run.draftEnvironmentId,
        owner: run.owner,
        plainVars: { PUBLIC: 'test' },
      })
    );
    const draft = await caller(
      user,
      authority(user, run.runId, run.draftEnvironmentId)
    ).agent.getDraft({ runId: run.runId });
    expect(draft).toMatchObject({
      offeredSandboxAllocations: ['cloudflare-containers-standard-3'],
      secretKeys: [],
      plainVars: { PUBLIC: 'test' },
    });
    expect(draft).not.toHaveProperty('secrets');
  });
  test('verification creates a callback child and releases failed reservations', async () => {
    const user = await insertTestUser();
    const run = await runFor(user);
    const api = caller(user, authority(user, run.runId, run.draftEnvironmentId));
    mockPrepare.mockRejectedValueOnce(new Error('launch failed'));
    await expect(api.agent.startVerification({ runId: run.runId, checks })).rejects.toThrow(
      'launch failed'
    );
    expect(await getSetupRun(db, run.runId, run.owner)).toMatchObject({
      verification_count: 0,
      pending_verification: null,
    });
    mockPrepare.mockResolvedValueOnce({ cloudAgentSessionId: childSessionId, kiloSessionId });
    await api.agent.startVerification({ runId: run.runId, checks });
    expect(
      z.object({ callbackTarget: ParentCallbackTargetSchema }).parse(mockPrepare.mock.lastCall?.[0])
    ).toEqual({ callbackTarget: { url: `workspace:${setupSessionId}` } });
    expect(mockPrepare).toHaveBeenLastCalledWith(
      expect.objectContaining({
        verificationOf: { runId: run.runId },
        requestedEnvironment: { id: run.draftEnvironmentId },
        callbackTarget: { url: `workspace:${setupSessionId}` },
      })
    );
  });
  test('verification without a setup session fails before reserving or launching a child', async () => {
    const user = await insertTestUser();
    const run = await runFor(user);
    await db.update(runs).set({ cloud_agent_session_id: null }).where(eq(runs.id, run.runId));
    const before = await getSetupRun(db, run.runId, run.owner);
    await expect(
      caller(user, authority(user, run.runId, run.draftEnvironmentId)).agent.startVerification({
        runId: run.runId,
        checks,
      })
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'Setup session is not available.',
    });
    expect(mockPrepare).not.toHaveBeenCalled();
    expect(await getSetupRun(db, run.runId, run.owner)).toEqual(before);
  });
  test('duplicate check names fail before reserving or launching a verification', async () => {
    const user = await insertTestUser();
    const run = await runFor(user);
    const before = await getSetupRun(db, run.runId, run.owner);
    await expect(
      caller(user, authority(user, run.runId, run.draftEnvironmentId)).agent.startVerification({
        runId: run.runId,
        checks: [checks[0], { ...checks[0], command: 'false' }],
      })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Verification check names must be unique.',
    });
    expect(mockPrepare).not.toHaveBeenCalled();
    expect(await getSetupRun(db, run.runId, run.owner)).toEqual(before);
  });

  test('duplicate result names fail without clearing the pending verification', async () => {
    const user = await insertTestUser();
    const run = await runFor(user);
    const api = caller(user, authority(user, run.runId, run.draftEnvironmentId));
    mockPrepare.mockResolvedValueOnce({ cloudAgentSessionId: childSessionId, kiloSessionId });
    await api.agent.startVerification({ runId: run.runId, checks });
    const before = await getSetupRun(db, run.runId, run.owner);
    mockGetSession.mockResolvedValue({
      kiloSessionId,
      environment: { configurationRevision: 1 },
      latestPreparation: { status: 'completed', setupDurationMs: 17 },
      egress: { mode: 'allowlist', allowlist: [] },
    });
    await expect(
      api.agent.recordVerification({
        runId: run.runId,
        childSessionId,
        results: [
          { name: 'smoke', passed: true, evidence: 'ok' },
          { name: 'smoke', passed: false, evidence: 'failed command' },
        ],
      })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Verification result names must be unique.',
    });
    expect(await getSetupRun(db, run.runId, run.owner)).toEqual(before);
    const result = await api.agent.recordVerification({
      runId: run.runId,
      childSessionId,
      results: [{ name: 'smoke', passed: true, evidence: 'ok' }],
    });
    expect(result.gate).toEqual({ ok: true });
  });

  test('a pending Worker launch blocks a second verification before child attachment', async () => {
    const user = await insertTestUser();
    const run = await runFor(user);
    const api = caller(user, authority(user, run.runId, run.draftEnvironmentId));
    let releaseLaunch: (result: {
      cloudAgentSessionId: string;
      kiloSessionId: string;
    }) => void = () => {};
    let markLaunchStarted: () => void = () => {};
    const launchStarted = new Promise<void>(resolve => {
      markLaunchStarted = resolve;
    });
    const launchResult = new Promise<{ cloudAgentSessionId: string; kiloSessionId: string }>(
      resolve => {
        releaseLaunch = resolve;
      }
    );
    mockPrepare.mockImplementationOnce(async () => {
      markLaunchStarted();
      return launchResult;
    });
    const first = api.agent.startVerification({ runId: run.runId, checks });
    await launchStarted;
    try {
      await expect(api.agent.startVerification({ runId: run.runId, checks })).rejects.toMatchObject(
        {
          code: 'CONFLICT',
        }
      );
      expect(mockPrepare).toHaveBeenCalledTimes(1);
    } finally {
      releaseLaunch({ cloudAgentSessionId: childSessionId, kiloSessionId });
      await first;
    }
    expect(await getSetupRun(db, run.runId, run.owner)).toMatchObject({
      verification_count: 1,
      status: 'verifying',
      pending_verification: { childSessionId },
    });
  });
  test('recordVerification uses observed preparation and rejects stale revisions at the gate', async () => {
    const user = await insertTestUser();
    const run = await runFor(user);
    const api = caller(user, authority(user, run.runId, run.draftEnvironmentId));
    const reserved = await db.transaction(tx =>
      reserveVerification(tx, { runId: run.runId, owner: run.owner, checks })
    );
    if (reserved.status !== 'reserved') throw new Error('Expected reservation');
    await db.transaction(tx =>
      attachVerificationChild(tx, {
        runId: run.runId,
        owner: run.owner,
        operationKey: reserved.operationKey,
        childSessionId,
        childKiloSessionId: kiloSessionId,
      })
    );
    await db.transaction(tx =>
      updateEnvironment(tx, '', {
        environmentId: run.draftEnvironmentId,
        owner: run.owner,
        commands: ['true'],
      })
    );
    mockGetSession.mockResolvedValue({
      kiloSessionId,
      environment: { configurationRevision: 1 },
      latestPreparation: { status: 'completed', setupDurationMs: 17 },
      egress: { mode: 'allowlist', allowlist: [] },
      execution: { status: 'completed' },
    });
    const result = await api.agent.recordVerification({
      runId: run.runId,
      childSessionId,
      results: [{ name: 'smoke', passed: true, evidence: 'ok' }],
    });
    expect(result.verification).toMatchObject({
      preparation: 'completed',
      configurationRevision: 1,
      setupDurationMs: 17,
    });
    expect(result.gate).toEqual({ ok: false, reason: expect.stringContaining('revision') });
    expect((await getSetupRun(db, run.runId, run.owner)).last_verification).toMatchObject({
      preparation: 'completed',
      setupDurationMs: 17,
    });
  });
  test('complete rejects missing verification without publishing', async () => {
    const user = await insertTestUser();
    const run = await runFor(user);
    await expect(
      caller(user, authority(user, run.runId, run.draftEnvironmentId)).agent.complete({
        runId: run.runId,
        summary: 'done',
      })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect((await getEnvironment(db, run.draftEnvironmentId, run.owner)).isDraft).toBe(true);
  });
});

async function verifyRun(run: Awaited<ReturnType<typeof runFor>>) {
  const draft = await getEnvironment(db, run.draftEnvironmentId, run.owner);
  const reservation = await db.transaction(tx =>
    reserveVerification(tx, { runId: run.runId, owner: run.owner, checks })
  );
  if (reservation.status !== 'reserved') throw new Error('Expected reservation');
  await db.transaction(tx =>
    attachVerificationChild(tx, {
      runId: run.runId,
      owner: run.owner,
      operationKey: reservation.operationKey,
      childSessionId,
      childKiloSessionId: kiloSessionId,
    })
  );
  await db.transaction(tx =>
    recordVerification(tx, {
      runId: run.runId,
      owner: run.owner,
      childSessionId,
      verification: {
        childSessionId,
        childKiloSessionId: kiloSessionId,
        configurationRevision: draft.configurationRevision,
        preparation: 'completed',
        preparationError: null,
        setupDurationMs: 10,
        egressMode: draft.egressMode,
        egressAllowlist: [...(draft.egressAllowlist ?? []), ...draft.egressRequiredHosts],
        checks,
        results: [{ name: 'smoke', passed: true, evidence: 'ok' }],
        recordedAt: new Date().toISOString(),
      },
    })
  );
}

describe('environment setup integration boundaries', () => {
  test('full access records suggestions and publishes after full-access verification without host approval', async () => {
    const user = await insertTestUser();
    const created = await caller(user).start({
      repositories,
      requirements: 'Run tests',
      model: 'test/model',
      egressMode: 'unrestricted',
    });
    const run = await getSetupRun(db, created.runId, { type: 'user', id: user.id });
    if (!run.draft_environment_id) throw new Error('Expected draft');
    const api = caller(user, authority(user, run.id, run.draft_environment_id));
    await api.agent.updateDraft({
      runId: run.id,
      expectedRevision: 1,
      requiredHosts: ['registry.npmjs.org'],
    });
    mockPrepare.mockResolvedValue({ cloudAgentSessionId: childSessionId, kiloSessionId });
    await api.agent.startVerification({ runId: run.id, checks });
    mockGetSession.mockResolvedValue({
      kiloSessionId,
      environment: { configurationRevision: 2 },
      latestPreparation: { status: 'completed' },
      egress: { mode: 'unrestricted' },
    });
    expect(
      (
        await api.agent.recordVerification({
          runId: run.id,
          childSessionId,
          results: [{ name: 'smoke', passed: true, evidence: 'ok' }],
        })
      ).gate
    ).toEqual({ ok: true });
    expect(
      await api.agent.complete({
        runId: run.id,
        summary: 'Full access selected; restricted access with registry.npmjs.org is recommended.',
      })
    ).toMatchObject({ status: 'published' });
    expect((await getSetupRun(db, run.id, { type: 'user', id: user.id })).network_requests).toEqual(
      []
    );
    expect(
      await getEnvironment(db, run.draft_environment_id, { type: 'user', id: user.id })
    ).toMatchObject({
      isDraft: false,
      egressMode: 'unrestricted',
      egressRequiredHosts: ['registry.npmjs.org'],
    });
  });
  test('discovers allowed hosts, waits for approval, then requires restricted verification before publication', async () => {
    const user = await insertTestUser();
    const run = await runFor(user);
    const api = caller(user, authority(user, run.runId, run.draftEnvironmentId));
    mockGetEgressAudit.mockResolvedValue({
      records: [
        { hostname: 'registry.npmjs.org', decision: 'allowed' },
        { hostname: 'telemetry.example.com', decision: 'allowed' },
      ],
      nextCursor: null,
    });
    const draft = await api.agent.getDraft({ runId: run.runId });
    expect(draft.network).toMatchObject({
      mode: 'none',
      discoveryAccess: 'full',
      discoveryAudit: {
        hosts: [
          { host: 'registry.npmjs.org', requestCount: 1 },
          { host: 'telemetry.example.com', requestCount: 1 },
        ],
        nextCursor: null,
      },
    });
    expect(mockGetEgressAudit).toHaveBeenCalledWith({
      cloudAgentSessionId: setupSessionId,
      limit: 100,
    });
    expect(
      await api.agent.requestNetworkHosts({
        runId: run.runId,
        hosts: [
          { host: 'registry.npmjs.org', reason: 'Install dependencies' },
          { host: 'telemetry.example.com', reason: 'Optional tool telemetry' },
        ],
      })
    ).toEqual({ requested: ['registry.npmjs.org', 'telemetry.example.com'] });
    expect((await getSetupRun(db, run.runId, run.owner)).network_requests[0]).toMatchObject({
      state: 'pending',
      evidence: { sessionId: setupSessionId, requestCount: 1 },
    });
    await expect(api.agent.startVerification({ runId: run.runId, checks })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('review the discovered network hosts'),
    });
    expect(mockPrepare).not.toHaveBeenCalled();

    await caller(user).resolveNetworkRequests({
      runId: run.runId,
      approved: ['registry.npmjs.org'],
      declined: ['telemetry.example.com'],
    });
    const approved = await getEnvironment(db, run.draftEnvironmentId, run.owner);
    expect(approved).toMatchObject({
      egressMode: 'allowlist',
      egressRequiredHosts: ['registry.npmjs.org'],
    });
    expect((await api.agent.getDraft({ runId: run.runId })).network.mode).toBe('limited');
    mockPrepare.mockResolvedValue({ cloudAgentSessionId: childSessionId, kiloSessionId });
    await api.agent.startVerification({ runId: run.runId, checks });
    mockGetSession.mockResolvedValue({
      kiloSessionId,
      environment: { configurationRevision: approved.configurationRevision },
      latestPreparation: { status: 'completed' },
      egress: { mode: 'unrestricted' },
    });
    expect(
      (
        await api.agent.recordVerification({
          runId: run.runId,
          childSessionId,
          results: [{ name: 'smoke', passed: true, evidence: 'ok' }],
        })
      ).gate
    ).toEqual({ ok: false, reason: expect.stringContaining('different network mode') });
    await expect(api.agent.complete({ runId: run.runId, summary: 'done' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });

    await api.agent.startVerification({ runId: run.runId, checks });
    mockGetSession.mockResolvedValue({
      kiloSessionId,
      environment: { configurationRevision: approved.configurationRevision },
      latestPreparation: { status: 'completed' },
      egress: { mode: 'allowlist', allowlist: ['registry.npmjs.org'] },
    });
    expect(
      (
        await api.agent.recordVerification({
          runId: run.runId,
          childSessionId,
          results: [{ name: 'smoke', passed: true, evidence: 'ok' }],
        })
      ).gate
    ).toEqual({ ok: true });
    expect(
      await api.agent.complete({ runId: run.runId, summary: 'Verified with approved hosts' })
    ).toMatchObject({ status: 'published' });
    expect(await getEnvironment(db, run.draftEnvironmentId, run.owner)).toMatchObject({
      isDraft: false,
      egressMode: 'allowlist',
      egressRequiredHosts: ['registry.npmjs.org'],
    });
  });

  test('completed verification publishes a new environment', async () => {
    const user = await insertTestUser();
    const run = await runFor(user);
    await verifyRun(run);
    const result = await caller(
      user,
      authority(user, run.runId, run.draftEnvironmentId)
    ).agent.complete({ runId: run.runId, summary: 'Tests pass' });
    expect(result).toMatchObject({ status: 'published' });
    expect(await getEnvironment(db, run.draftEnvironmentId, run.owner)).toMatchObject({
      isDraft: false,
    });
    expect(await getSetupRun(db, run.runId, run.owner)).toMatchObject({
      summary: 'Tests pass',
      status: 'published',
    });
  });
  test('repeated completion preserves the published summary and environment', async () => {
    const user = await insertTestUser();
    const run = await runFor(user);
    await verifyRun(run);
    const api = caller(user, authority(user, run.runId, run.draftEnvironmentId));
    await api.agent.complete({ runId: run.runId, summary: 'Published summary' });
    const before = await getSetupRun(db, run.runId, run.owner);
    const environment = await getEnvironment(db, run.draftEnvironmentId, run.owner);
    await expect(
      api.agent.complete({ runId: run.runId, summary: 'Unauthorized summary' })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await getSetupRun(db, run.runId, run.owner)).toEqual(before);
    expect(await getEnvironment(db, run.draftEnvironmentId, run.owner)).toEqual(environment);
  });
  test('cancellation that wins completion preserves the summary and draft', async () => {
    const user = await insertTestUser();
    const run = await runFor(user);
    await verifyRun(run);
    const draft = await getEnvironment(db, run.draftEnvironmentId, run.owner);
    let cancel = Promise.resolve();
    const transaction = db.transaction.bind(db);
    mockBeforePublish.mockImplementationOnce(() => {
      cancel = transaction(tx => cancelSetupRun(tx, { runId: run.runId, owner: run.owner }));
    });
    const transactionSpy = jest.spyOn(db, 'transaction').mockImplementation(async (...args) => {
      await cancel;
      return transaction(...args);
    });
    try {
      await expect(
        caller(user, authority(user, run.runId, run.draftEnvironmentId)).agent.complete({
          runId: run.runId,
          summary: 'Unauthorized summary',
        })
      ).rejects.toMatchObject({ code: 'CONFLICT' });
    } finally {
      transactionSpy.mockRestore();
    }
    expect(await getSetupRun(db, run.runId, run.owner)).toMatchObject({
      status: 'cancelled',
      summary: null,
    });
    expect(await getEnvironment(db, run.draftEnvironmentId, run.owner)).toEqual(draft);
  });
  test.each(['failed', 'publish_conflict'] as const)(
    'agent failure preserves a %s user decision',
    async status => {
      const user = await insertTestUser();
      const run = await runFor(user);
      await db
        .update(runs)
        .set({ status, status_reason: 'agent_failed', status_detail: 'Original reason' })
        .where(eq(runs.id, run.runId));
      const before = await getSetupRun(db, run.runId, run.owner);
      const draft = await getEnvironment(db, run.draftEnvironmentId, run.owner);
      await expect(
        caller(user, authority(user, run.runId, run.draftEnvironmentId)).agent.fail({
          runId: run.runId,
          reason: 'Replacement reason',
        })
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(await getSetupRun(db, run.runId, run.owner)).toEqual(before);
      expect(await getEnvironment(db, run.draftEnvironmentId, run.owner)).toEqual(draft);
    }
  );
  test.each(['running', 'needs_input', 'verifying'] as const)(
    'agent can fail a %s run',
    async status => {
      const user = await insertTestUser();
      const run = await runFor(user);
      await db.update(runs).set({ status }).where(eq(runs.id, run.runId));
      expect(
        await caller(user, authority(user, run.runId, run.draftEnvironmentId)).agent.fail({
          runId: run.runId,
          reason: 'Cannot continue',
        })
      ).toEqual({ status: 'failed' });
      expect(await getSetupRun(db, run.runId, run.owner)).toMatchObject({
        status: 'failed',
        status_reason: 'agent_failed',
        status_detail: 'Cannot continue',
        draft_environment_id: run.draftEnvironmentId,
      });
    }
  );
  test('completion preserves target edits and reports conflict', async () => {
    const user = await insertTestUser();
    const owner: EnvironmentOwner = { type: 'user', id: user.id };
    const target = await db.transaction(tx =>
      createEnvironment(tx, '', {
        owner,
        createdByUserId: user.id,
        name: 'target',
        repositories: [{ platform: 'github', repoFullName: 'acme/widgets' }],
      })
    );
    const created = await db.transaction(tx =>
      createSetupRunWithDraft(tx, '', {
        owner,
        createdByUserId: user.id,
        targetEnvironmentId: target.id,
        repositories: [{ platform: 'github', repoFullName: 'acme/widgets' }],
        requirements: 'Run tests',
        model: 'test/model',
        launchRepoFullName: 'acme/widgets',
        sandboxOptions: ['cloudflare-containers-standard-3'],
      })
    );
    await db.transaction(tx =>
      attachSetupSession(tx, {
        runId: created.runId,
        owner,
        cloudAgentSessionId: setupSessionId,
        kiloSessionId,
      })
    );
    await verifyRun({ ...created, owner });
    await db.transaction(tx =>
      updateEnvironment(tx, '', { environmentId: target.id, owner, commands: ['echo user edit'] })
    );
    expect(
      await caller(user, authority(user, created.runId, created.draftEnvironmentId)).agent.complete(
        { runId: created.runId, summary: 'done' }
      )
    ).toMatchObject({ status: 'publish_conflict' });
    expect((await getEnvironment(db, target.id, owner)).commands).toEqual(['echo user edit']);
  });
  test('secret resolution follows up with keys and excludes saved values', async () => {
    const user = await insertTestUser();
    const run = await runFor(user);
    await db.transaction(tx =>
      addSecretRequests(tx, {
        runId: run.runId,
        owner: run.owner,
        requests: [{ key: 'TEST_TOKEN', reason: 'tests', references: [] }],
      })
    );
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const key = Buffer.from(publicKey.export({ type: 'spki', format: 'pem' })).toString('base64');
    await db.transaction(tx =>
      updateEnvironment(tx, key, {
        environmentId: run.draftEnvironmentId,
        owner: run.owner,
        secrets: [{ key: 'TEST_TOKEN', value: 'private-value-must-stay-hidden' }],
      })
    );
    const result = await caller(user).resolveSecretRequests({ runId: run.runId, skipped: [] });
    expect(result).toMatchObject({ provided: ['TEST_TOKEN'], resumed: true });
    const followUp = JSON.stringify(mockSendMessage.mock.calls);
    expect(followUp).toContain('TEST_TOKEN');
    expect(followUp).not.toContain('private-value-must-stay-hidden');
    const draft = await caller(
      user,
      authority(user, run.runId, run.draftEnvironmentId)
    ).agent.getDraft({ runId: run.runId });
    expect(draft.secretKeys).toEqual(['TEST_TOKEN']);
    expect(JSON.stringify(draft)).not.toContain('private-value-must-stay-hidden');
  });
  test('failed input follow-up retains resolution and can resume the idle parent with its stored model', async () => {
    const user = await insertTestUser();
    const run = await runFor(user);
    await db.transaction(tx =>
      addSecretRequests(tx, {
        runId: run.runId,
        owner: run.owner,
        requests: [{ key: 'OPTIONAL_TOKEN', reason: 'Optional integration', references: [] }],
      })
    );
    mockGetSession.mockResolvedValue({
      execution: null,
      latestPreparation: { status: 'completed' },
    });
    mockSendMessage.mockRejectedValueOnce(new Error('Temporary message delivery failure'));
    const api = caller(user);
    expect(
      await api.resolveSecretRequests({ runId: run.runId, skipped: ['OPTIONAL_TOKEN'] })
    ).toMatchObject({ resumed: true, skipped: ['OPTIONAL_TOKEN'] });
    const idle = await api.get({ runId: run.runId });
    expect(idle).toMatchObject({
      status: 'running',
      agentState: { kind: 'idle' },
      secretRequests: [{ key: 'OPTIONAL_TOKEN', state: 'skipped' }],
    });
    expect(canContinueEnvironmentSetup(idle)).toBe(true);
    expect(await api.resume({ runId: run.runId })).toEqual({ status: 'running' });
    expect(mockSendMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cloudAgentSessionId: setupSessionId,
        payload: expect.objectContaining({ model: 'test/model', variant: 'test-variant' }),
      })
    );
    mockGetSession.mockResolvedValue({ execution: { status: 'running' } });
    expect(await api.get({ runId: run.runId })).toMatchObject({ agentState: { kind: 'working' } });
    expect(
      await caller(user, authority(user, run.runId, run.draftEnvironmentId)).agent.updateDraft({
        runId: run.runId,
        expectedRevision: 1,
        script: 'echo continued',
      })
    ).toBeDefined();
    expect((await getEnvironment(db, run.draftEnvironmentId, run.owner)).commands).toEqual([
      'echo continued',
    ]);
  });
  test.each([
    [{ execution: null }, 'idle'],
    [{ execution: { status: 'completed' } }, 'idle'],
    [{ execution: null, latestPreparation: { status: 'running' } }, 'working'],
    [{ execution: { status: 'pending' } }, 'working'],
  ] as const)('maps parent execution %j to %s', async (session, kind) => {
    const user = await insertTestUser();
    const run = await runFor(user);
    mockGetSession.mockResolvedValue(session);
    expect(await caller(user).get({ runId: run.runId })).toMatchObject({ agentState: { kind } });
  });
  test('failed parent reads remain unknown', async () => {
    const user = await insertTestUser();
    const run = await runFor(user);
    mockGetSession.mockRejectedValueOnce(new Error('Unavailable'));
    expect(await caller(user).get({ runId: run.runId })).toMatchObject({
      agentState: { kind: 'unknown' },
    });
  });
  test('member claims cannot use agent tools after role revocation', async () => {
    const user = await insertTestUser();
    const org = await createTestOrganization('Setup org', user.id, 0);
    const member = await insertTestUser();
    await addUserToOrganization(org.id, member.id, 'member');
    const run = await runFor(user, { type: 'organization', id: org.id });
    await expect(
      caller(member, authority(member, run.runId, run.draftEnvironmentId, org.id)).agent.getDraft({
        runId: run.runId,
      })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
  test('network recommendations require observed audit evidence from a bound session', async () => {
    const user = await insertTestUser();
    const run = await runFor(user);
    await verifyRun(run);
    await db.transaction(tx =>
      updateEnvironment(tx, '', {
        environmentId: run.draftEnvironmentId,
        owner: run.owner,
        egressMode: 'allowlist',
        egressAllowlist: [],
      })
    );
    const api = caller(user, authority(user, run.runId, run.draftEnvironmentId));
    const input = {
      runId: run.runId,
      childSessionId,
      hosts: [{ host: 'registry.npmjs.org', reason: 'Install dependencies' }],
    } satisfies Parameters<typeof api.agent.requestNetworkHosts>[0];
    await expect(
      api.agent.requestNetworkHosts({
        ...input,
        childSessionId: 'workspace_cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'Unknown verification session.' });
    expect(mockGetEgressAudit).not.toHaveBeenCalled();
    await expect(api.agent.requestNetworkHosts(input)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('No observed request'),
    });
    mockGetEgressAudit.mockResolvedValue({
      records: [
        { hostname: 'registry.npmjs.org:443', decision: 'denied' },
        { hostname: 'registry.npmjs.org', decision: 'allowed' },
      ],
      nextCursor: null,
    });
    expect(await api.agent.requestNetworkHosts(input)).toEqual({
      requested: ['registry.npmjs.org'],
    });
    expect((await getSetupRun(db, run.runId, run.owner)).network_requests).toEqual([
      expect.objectContaining({
        host: 'registry.npmjs.org',
        evidence: { sessionId: childSessionId, requestCount: 2 },
      }),
    ]);
  });
});
