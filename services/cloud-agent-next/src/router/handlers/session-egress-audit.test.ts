import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccessibleCloudAgentSession } from '@kilocode/worker-utils/cloud-agent-session-access';
import type { GetEgressAuditResponse } from '@kilocode/worker-utils/egress-audit';
import type { SessionMetadata } from '../../persistence/session-metadata.js';
import type { SandboxId, TRPCContext } from '../../types.js';

const { queryAccess } = vi.hoisted(() => ({ queryAccess: vi.fn() }));

vi.mock('@cloudflare/sandbox', () => ({ getSandbox: vi.fn() }));
vi.mock('@kilocode/db/client', () => ({ getWorkerDb: vi.fn(() => ({})) }));
vi.mock('@kilocode/worker-utils/cloud-agent-session-access', () => ({
  queryAccessibleCloudAgentSession: queryAccess,
}));

import { appRouter } from '../../router.js';

const userId = 'oauth/google:audit-owner';
const sessionId = 'workspace_12345678-1234-4234-9234-123456789abc';
const legacySessionId = 'agent_12345678-1234-4234-9234-123456789abc';
const organizationId = '11111111-1111-4111-8111-111111111111';
const sandboxId = 'ses-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as SandboxId;
const sharedSandboxId = 'usr-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as SandboxId;
const access: AccessibleCloudAgentSession = { kiloSessionId: 'kilo_root', organizationId: null };
const audit: GetEgressAuditResponse = {
  records: [
    {
      id: 7,
      requestId: '12345678-1234-4234-9234-123456789abc',
      allocationRef: 'allocation:1',
      timestamp: '2026-10-15T12:00:00.000Z',
      method: 'GET',
      hostname: 'example.com',
      protocol: 'https:',
      port: 443,
      decision: 'denied',
    },
  ],
  nextCursor: 7,
};

function sessionMetadata() {
  return {
    metadataSchemaVersion: 2,
    identity: { userId, sessionId },
    auth: { kiloSessionId: access.kiloSessionId },
    workspace: {
      sandboxId,
      sandboxProvider: 'cloudflare-containers',
      sandboxKind: 'isolated',
      egressMode: 'allowlist',
      egressAudit: true,
    },
    lifecycle: { version: 1, timestamp: 1 },
  } satisfies SessionMetadata;
}

function setup() {
  const metadata = sessionMetadata();
  const sessionStub = {
    getMetadata: vi.fn<() => Promise<SessionMetadata | null>>().mockResolvedValue(metadata),
  };
  const sandboxStub = { getEgressAudit: vi.fn().mockResolvedValue(audit) };
  const session = { idFromName: vi.fn(name => name), get: vi.fn(() => sessionStub) };
  const legacy = { idFromName: vi.fn(), get: vi.fn() };
  const containers = { getByName: vi.fn(() => sandboxStub) };
  const control = { getByName: vi.fn() };
  const context = {
    userId,
    authToken: 'current-token',
    request: new Request('https://worker.test/trpc'),
    env: {
      HYPERDRIVE: { connectionString: 'postgresql://test' },
      SANDBOX_SESSION: session,
      CLOUD_AGENT_SESSION: legacy,
      SANDBOX_CONTAINERS: containers,
      SANDBOX_CONTROL: control,
    },
  } as unknown as TRPCContext;
  return {
    metadata,
    sessionStub,
    sandboxStub,
    session,
    legacy,
    containers,
    control,
    context,
    caller: appRouter.createCaller(context),
  };
}

describe('Worker getEgressAudit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryAccess.mockReset().mockResolvedValue(access);
  });

  it.each([{ cursor: 0, limit: 1 }, { cursor: 6, limit: 100 }, {}])(
    'derives the container from trusted metadata and forwards pagination %j',
    async pagination => {
      const harness = setup();
      await expect(
        harness.caller.getEgressAudit({ cloudAgentSessionId: sessionId, ...pagination })
      ).resolves.toEqual(audit);
      expect(queryAccess).toHaveBeenCalledWith(expect.anything(), {
        kiloUserId: userId,
        cloudAgentSessionId: sessionId,
      });
      expect(harness.session.idFromName).toHaveBeenCalledWith(`${userId}:${sessionId}`);
      expect(harness.containers.getByName).toHaveBeenCalledExactlyOnceWith(sandboxId);
      expect(harness.sandboxStub.getEgressAudit).toHaveBeenCalledExactlyOnceWith({
        cursor: pagination.cursor,
        limit: pagination.limit ?? 50,
      });
      expect(harness.legacy.get).not.toHaveBeenCalled();
      expect(harness.control.getByName).not.toHaveBeenCalled();
    }
  );

  it('does not resolve session or container stubs until current access resolves', async () => {
    const started = Promise.withResolvers<void>();
    const authorized = Promise.withResolvers<AccessibleCloudAgentSession>();
    queryAccess.mockImplementationOnce(() => {
      started.resolve();
      return authorized.promise;
    });
    const harness = setup();
    const result = harness.caller.getEgressAudit({ cloudAgentSessionId: sessionId });
    await started.promise;
    expect(harness.session.idFromName).not.toHaveBeenCalled();
    expect(harness.sessionStub.getMetadata).not.toHaveBeenCalled();
    expect(harness.containers.getByName).not.toHaveBeenCalled();
    authorized.resolve(access);
    await expect(result).resolves.toEqual(audit);
  });

  it('waits for metadata validation before accessing the container', async () => {
    const started = Promise.withResolvers<void>();
    const metadata = Promise.withResolvers<SessionMetadata>();
    const harness = setup();
    harness.sessionStub.getMetadata.mockImplementationOnce(() => {
      started.resolve();
      return metadata.promise;
    });
    const result = harness.caller.getEgressAudit({ cloudAgentSessionId: sessionId });
    await started.promise;
    expect(harness.containers.getByName).not.toHaveBeenCalled();
    metadata.resolve(harness.metadata);
    await expect(result).resolves.toEqual(audit);
  });

  it.each(['userId', 'authToken'] as const)(
    'requires authenticated %s before access lookup',
    async field => {
      const harness = setup();
      harness.context[field] = '';
      await expect(
        harness.caller.getEgressAudit({ cloudAgentSessionId: sessionId })
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      expect(queryAccess).not.toHaveBeenCalled();
      expect(harness.session.get).not.toHaveBeenCalled();
      expect(harness.containers.getByName).not.toHaveBeenCalled();
    }
  );

  it.each(['foreign owner', 'revoked organization membership', 'deleted organization'])(
    'rejects current access denied for %s before any DO call',
    async () => {
      queryAccess.mockResolvedValueOnce(null);
      const harness = setup();
      await expect(
        harness.caller.getEgressAudit({ cloudAgentSessionId: sessionId })
      ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'Session access denied' });
      expect(harness.session.idFromName).not.toHaveBeenCalled();
      expect(harness.session.get).not.toHaveBeenCalled();
      expect(harness.legacy.get).not.toHaveBeenCalled();
      expect(harness.containers.getByName).not.toHaveBeenCalled();
    }
  );

  it('fails closed if the authoritative access lookup fails', async () => {
    queryAccess.mockRejectedValueOnce(new Error('database unavailable'));
    const harness = setup();
    await expect(
      harness.caller.getEgressAudit({ cloudAgentSessionId: sessionId })
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    expect(harness.session.get).not.toHaveBeenCalled();
    expect(harness.containers.getByName).not.toHaveBeenCalled();
  });

  it('rechecks revoked access on later pages despite stale validated context and session metadata', async () => {
    const harness = setup();
    harness.context.validatedSessionAccess = {
      ...access,
      kiloUserId: userId,
      cloudAgentSessionId: sessionId,
    };
    await harness.caller.getEgressAudit({ cloudAgentSessionId: sessionId });
    harness.sessionStub.getMetadata.mockClear();
    harness.containers.getByName.mockClear();
    queryAccess.mockResolvedValueOnce(null);
    await expect(
      harness.caller.getEgressAudit({ cloudAgentSessionId: sessionId, cursor: 7 })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(queryAccess).toHaveBeenCalledTimes(2);
    expect(harness.sessionStub.getMetadata).not.toHaveBeenCalled();
    expect(harness.containers.getByName).not.toHaveBeenCalled();
  });

  it.each([
    { userId: 'another-owner' },
    { sessionId: 'workspace_22345678-1234-4234-9234-123456789abc' },
    { orgId: organizationId },
  ])('rejects mismatched metadata identity %j before the container RPC', async identity => {
    const harness = setup();
    harness.sessionStub.getMetadata.mockResolvedValue({
      ...harness.metadata,
      identity: { ...harness.metadata.identity, ...identity },
    });
    await expect(
      harness.caller.getEgressAudit({ cloudAgentSessionId: sessionId })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(harness.containers.getByName).not.toHaveBeenCalled();
  });

  it.each([undefined, '22222222-2222-4222-8222-222222222222'])(
    'requires metadata to match current organization access, not %s',
    async orgId => {
      queryAccess.mockResolvedValue({ ...access, organizationId });
      const harness = setup();
      harness.sessionStub.getMetadata.mockResolvedValue({
        ...harness.metadata,
        identity: { ...harness.metadata.identity, orgId },
      });
      await expect(
        harness.caller.getEgressAudit({ cloudAgentSessionId: sessionId })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(harness.containers.getByName).not.toHaveBeenCalled();
    }
  );

  it('allows matching organization metadata', async () => {
    queryAccess.mockResolvedValue({ ...access, organizationId });
    const harness = setup();
    harness.sessionStub.getMetadata.mockResolvedValue({
      ...harness.metadata,
      identity: { ...harness.metadata.identity, orgId: organizationId },
    });
    await expect(
      harness.caller.getEgressAudit({ cloudAgentSessionId: sessionId })
    ).resolves.toEqual(audit);
  });

  it('rejects missing metadata without accessing a sandbox', async () => {
    const harness = setup();
    harness.sessionStub.getMetadata.mockResolvedValue(null);
    await expect(
      harness.caller.getEgressAudit({ cloudAgentSessionId: sessionId })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(harness.containers.getByName).not.toHaveBeenCalled();
  });

  it('authorizes legacy sessions before rejecting them without either session DO', async () => {
    const harness = setup();
    await expect(
      harness.caller.getEgressAudit({ cloudAgentSessionId: legacySessionId })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(queryAccess).toHaveBeenCalledTimes(1);
    queryAccess.mockResolvedValueOnce(null);
    await expect(
      harness.caller.getEgressAudit({ cloudAgentSessionId: legacySessionId })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(harness.session.get).not.toHaveBeenCalled();
    expect(harness.legacy.get).not.toHaveBeenCalled();
    expect(harness.containers.getByName).not.toHaveBeenCalled();
  });

  it.each([undefined, {}, { egressAudit: false }])(
    'returns an empty page without a container RPC when audit is not enabled: %j',
    async workspace => {
      const harness = setup();
      harness.sessionStub.getMetadata.mockResolvedValue({ ...harness.metadata, workspace });
      await expect(
        harness.caller.getEgressAudit({ cloudAgentSessionId: sessionId })
      ).resolves.toEqual({ records: [], nextCursor: null });
      expect(harness.containers.getByName).not.toHaveBeenCalled();
    }
  );

  it('rejects audit-enabled sessions without a sandbox', async () => {
    const harness = setup();
    harness.sessionStub.getMetadata.mockResolvedValue({
      ...harness.metadata,
      workspace: { ...harness.metadata.workspace, sandboxId: undefined },
    });
    await expect(
      harness.caller.getEgressAudit({ cloudAgentSessionId: sessionId })
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'Session has no sandbox audit history',
    });
    expect(harness.containers.getByName).not.toHaveBeenCalled();
  });

  it.each([undefined, 'unrestricted', 'allowlist'] as const)(
    'returns audit history independently of egress mode: %s',
    async egressMode => {
      const harness = setup();
      harness.sessionStub.getMetadata.mockResolvedValue({
        ...harness.metadata,
        workspace: { ...harness.metadata.workspace, egressMode },
      });
      await expect(
        harness.caller.getEgressAudit({ cloudAgentSessionId: sessionId })
      ).resolves.toEqual(audit);
      expect(harness.containers.getByName).toHaveBeenCalledWith(sandboxId);
    }
  );

  it.each([
    { sandboxKind: 'shared', sandboxId: sharedSandboxId },
    { sandboxKind: undefined, sandboxId: sharedSandboxId },
    { sandboxKind: 'isolated-standard' },
    { sandboxRoute: { kind: 'shared', routeKey: sharedSandboxId } },
    { sandboxProvider: 'cloudflare' },
    { sandboxProvider: 'vercel' },
  ] satisfies Partial<NonNullable<SessionMetadata['workspace']>>[])(
    'rejects unsupported or shared placement %j without a container RPC',
    async workspace => {
      const harness = setup();
      harness.sessionStub.getMetadata.mockResolvedValue({
        ...harness.metadata,
        workspace: { ...harness.metadata.workspace, ...workspace },
      });
      await expect(
        harness.caller.getEgressAudit({ cloudAgentSessionId: sessionId })
      ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
      expect(harness.containers.getByName).not.toHaveBeenCalled();
    }
  );

  it('supports persisted isolated session IDs without an explicit sandbox kind', async () => {
    const harness = setup();
    harness.sessionStub.getMetadata.mockResolvedValue({
      ...harness.metadata,
      workspace: { ...harness.metadata.workspace, sandboxKind: undefined },
    });
    await expect(
      harness.caller.getEgressAudit({ cloudAgentSessionId: sessionId })
    ).resolves.toEqual(audit);
    expect(harness.containers.getByName).toHaveBeenCalledWith(sandboxId);
  });

  it.each([
    { cursor: -1 },
    { cursor: 1.5 },
    { cursor: Number.MAX_SAFE_INTEGER + 1 },
    { limit: 0 },
    { limit: 101 },
    { limit: 1.5 },
    { sandboxId: sharedSandboxId },
    { organizationId },
  ])(
    'rejects invalid pagination or untrusted routing input %j before access lookup',
    async input => {
      const harness = setup();
      await expect(
        harness.caller.getEgressAudit({ cloudAgentSessionId: sessionId, ...input })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(queryAccess).not.toHaveBeenCalled();
      expect(harness.session.get).not.toHaveBeenCalled();
      expect(harness.containers.getByName).not.toHaveBeenCalled();
    }
  );

  it.each([
    { records: audit.records },
    { records: [], nextCursor: -1 },
    { records: Array.from({ length: 101 }, () => audit.records[0]), nextCursor: null },
    { records: [{ ...audit.records[0], decision: 'unknown' }], nextCursor: null },
    {
      records: [{ ...audit.records[0], hostname: 'example.com/private?token=secret' }],
      nextCursor: null,
    },
  ])('validates container output before returning it: %j', async output => {
    const harness = setup();
    harness.sandboxStub.getEgressAudit.mockResolvedValue(output);
    await expect(
      harness.caller.getEgressAudit({ cloudAgentSessionId: sessionId })
    ).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
  });

  it('strips fields outside the public audit response', async () => {
    const harness = setup();
    harness.sandboxStub.getEgressAudit.mockResolvedValue({
      ...audit,
      sandboxId,
      records: audit.records.map(record => ({ ...record, url: 'https://example.com/private' })),
    });
    await expect(
      harness.caller.getEgressAudit({ cloudAgentSessionId: sessionId })
    ).resolves.toEqual(audit);
  });
});
