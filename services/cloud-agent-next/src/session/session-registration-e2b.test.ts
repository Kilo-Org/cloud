import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerDb } from '@kilocode/db/client';
import type { OperationLedgerRow } from '@kilocode/db/schema';
import type { Env } from '../types.js';
import type { SessionMetadata } from '../persistence/session-metadata.js';
import { E2BProviderError } from '../byoc/e2b-errors.js';
import type * as E2BCredentialResolver from '../byoc/e2b-credential-resolver.js';
import type * as VercelCredentialResolver from '../byoc/vercel-credential-resolver.js';
import {
  createSessionWithLedger,
  SESSION_CREATE_TOMBSTONED_IDS_KEY,
  type SessionRegistrationContext,
} from './session-registration.js';
import type { SessionCreateRequest } from './session-requests.js';

const mocks = vi.hoisted(() => ({
  admit: vi.fn(),
  progress: vi.fn(),
  settle: vi.fn(),
  pending: vi.fn(),
  db: vi.fn(),
  ingest: vi.fn(),
  delete: vi.fn(),
  sessionId: vi.fn(),
  enrollment: vi.fn(),
  credential: vi.fn(),
  vercel: vi.fn(),
  onprem: vi.fn(),
  profile: vi.fn(),
  membership: vi.fn(),
}));

vi.mock('@kilocode/db/operation-ledger', () => ({
  admitOperation: mocks.admit,
  recordOperationProgress: mocks.progress,
  settleOperation: mocks.settle,
  markReconcilePending: mocks.pending,
}));
vi.mock('../db/pg.js', () => ({ getPgDb: mocks.db }));
vi.mock('../utils/do-retry.js', () => ({
  withDORetry: (getStub: () => unknown, operation: (stub: unknown) => unknown) =>
    operation(getStub()),
}));
vi.mock('../session-service.js', () => ({
  generateSessionId: mocks.sessionId,
  SessionService: class {
    createCliSessionViaSessionIngest = mocks.ingest;
    deleteCliSessionViaSessionIngest = mocks.delete;
  },
}));
vi.mock('../telemetry/session-reports.js', () => ({
  createCloudAgentSessionReport: vi.fn(),
  recordCloudAgentSandboxIdentity: vi.fn(),
  recordCloudAgentSessionFailure: vi.fn(),
}));
vi.mock('../byoc/e2b-credential-resolver.js', async importOriginal => ({
  ...(await importOriginal<typeof E2BCredentialResolver>()),
  fetchByocE2BEnrollment: mocks.enrollment,
  fetchByocE2BCredential: mocks.credential,
}));
vi.mock('../byoc/vercel-credential-resolver.js', async importOriginal => ({
  ...(await importOriginal<typeof VercelCredentialResolver>()),
  fetchByocVercelEnrollment: mocks.vercel,
}));
vi.mock('../onprem/client.js', () => ({
  getSelectedBinding: mocks.onprem,
  resolveProfile: mocks.profile,
}));
vi.mock('../router/handlers/organization-membership.js', () => ({
  assertOrganizationMembership: mocks.membership,
}));

const organizationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const credentialId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const operationKey = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const workspaceId = 'workspace_dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const legacyId = 'agent_dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const binding = { kind: 'e2b', organizationId, credentialId } as const;
const containment = { github: false, gitlab: false, bitbucket: false, kilocode: false };
const status = {
  organizationId,
  credentialId,
  consentVersion: 'e2b-direct-v1',
  consentedAt: '2026-09-03T12:00:00.000Z',
  validatedAt: '2026-09-03T12:00:01.000Z',
  createdAt: '2026-09-03T12:00:02.000Z',
};

type Registration = Pick<
  SessionMetadata,
  'identity' | 'auth' | 'workspace' | 'repository' | 'agent'
>;

function fixture(
  envOverrides: Partial<Env> = {},
  inputOverrides: Partial<SessionCreateRequest> = {}
) {
  const input: SessionCreateRequest = {
    repository: { type: 'github', repo: 'acme/repo' },
    agent: { mode: 'code', model: 'test-model' },
    initialTurn: { type: 'prompt', prompt: 'Implement a focused change' },
    options: {
      kilocodeOrganizationId: organizationId,
      createdOnPlatform: 'cloud-agent-web',
      clientProvenance: 'browser',
      operationKey,
    },
    ...inputOverrides,
  };
  const row: OperationLedgerRow = {
    id: operationKey,
    operation_key: operationKey,
    domain: 'session',
    intent: 'create_cloud',
    kilo_user_id: 'oauth/user',
    organization_id: input.options?.kilocodeOrganizationId ?? null,
    resource_key: null,
    provider_ref: null,
    taxonomy: 'safe-retry',
    status: 'admitted',
    outcome_code: null,
    canonical_result: null,
    admitted_at: new Date().toISOString(),
    settled_at: null,
    lease_expires_at: new Date(Date.now() + 120_000).toISOString(),
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  };
  let ownership: Record<string, unknown> | null = null;
  let metadata: SessionMetadata | null = null;
  const stub = {
    createSessionWithInitialAdmission: vi.fn(async (command: Registration) => {
      metadata = { ...command, metadataSchemaVersion: 2, lifecycle: { version: 1, timestamp: 1 } };
      return {
        success: true,
        outcome: 'queued',
        messageId: 'msg_018f1e2d3c4bAbCdEfGhIjKlMn',
        compatibilityDelivery: 'queued',
      };
    }),
    registerSession: vi.fn(async (command: Registration) => {
      metadata = { ...command, metadataSchemaVersion: 2, lifecycle: { version: 1, timestamp: 1 } };
      return { success: true };
    }),
    getMetadata: vi.fn(async () => metadata),
    getMessageResult: vi.fn(async () => ({ type: 'found', result: { status: 'queued' } })),
  };
  const namespace = { idFromName: vi.fn((name: string) => name), get: vi.fn(() => stub) };
  const ctx: SessionRegistrationContext = {
    userId: 'oauth/user',
    authToken: 'local-test-token',
    env: {
      BYOC_E2B_ORG_IDS: organizationId,
      CONTROL_PLANE_IDS: '*',
      WORKTREE_CREATION_ENABLED_IDS: '*',
      PER_SESSION_SANDBOX_ORG_IDS: '*',
      CREDENTIAL_CONTAINMENT_ENABLED: 'true',
      SANDBOX_SESSION: namespace,
      CLOUD_AGENT_SESSION: namespace,
      ...envOverrides,
    } as Env,
  };
  mocks.db.mockReturnValue({
    select: (fields?: Record<string, unknown>) => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            // `select()` with no projection is the operation-ledger lookup;
            // `select({...})` is the cli_sessions_v2 ownership lookup and
            // `select({ email })` resolves the analytics identity channel.
            if (fields === undefined) return ownership ? [row] : [];
            if ('email' in fields) return [{ email: 'test@example.test' }];
            return ownership ? [ownership] : [];
          },
        }),
      }),
    }),
  } as unknown as WorkerDb);
  mocks.admit.mockImplementation(async () => ({
    admission:
      row.status === 'completed'
        ? 'duplicate_settled'
        : row.canonical_result
          ? 'duplicate_reconcile_pending'
          : 'admitted',
    row,
  }));
  mocks.progress.mockImplementation(
    async (_db: WorkerDb, _id: string, progress: Record<string, unknown>) => {
      row.canonical_result = { ...row.canonical_result, ...progress };
      return row;
    }
  );
  mocks.settle.mockImplementation(
    async (
      _db: WorkerDb,
      result: { status: OperationLedgerRow['status']; canonicalResult?: Record<string, unknown> }
    ) => {
      row.status = result.status;
      row.canonical_result = { ...row.canonical_result, ...result.canonicalResult };
      return { settled: true, row };
    }
  );
  mocks.pending.mockImplementation(async () => {
    row.status = 'reconcile_pending';
  });
  mocks.ingest.mockImplementation(async (...args: unknown[]) => {
    ownership = {
      sessionId: args[0],
      cloudAgentSessionId: args[1],
      cloudAgentSessionScopeId: args[1],
      organizationId: args[4] ?? null,
      worktreeId: args[9] ?? null,
    };
    return { status: 'ready', clone: { sessionId: args[0], copiedItemCount: 0 } };
  });
  const run = (billingOrigin?: string) =>
    createSessionWithLedger(input, ctx, { operationKey, startedAt: Date.now(), billingOrigin });
  return {
    ctx,
    input,
    row,
    stub,
    run,
    dropOwnership: () => {
      ownership = null;
    },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.onprem.mockResolvedValue(null);
  mocks.enrollment.mockResolvedValue(status);
  mocks.credential.mockResolvedValue({ ...status, apiKeyEncrypted: 'not-persisted' });
  mocks.sessionId.mockImplementation((plane: string) =>
    plane === 'control' ? workspaceId : legacyId
  );
});

describe('E2B root registration', () => {
  it('forces the control plane and records full identity and consent-derived policy before ownership', async () => {
    const f = fixture({ CONTROL_PLANE_IDS: '' });
    const createOwnership = mocks.ingest.getMockImplementation();
    mocks.ingest.mockImplementation(async (...args: unknown[]) => {
      expect(f.row.canonical_result).toMatchObject({
        sandboxProvider: 'e2b',
        sandboxProviderBinding: binding,
        credentialContainment: containment,
      });
      expect(JSON.stringify(f.row.canonical_result)).not.toContain('apiKeyEncrypted');
      return createOwnership?.(...args);
    });
    const result = await f.run();
    expect(result.cloudAgentSessionId).toBe(workspaceId);
    expect(mocks.sessionId).toHaveBeenCalledWith('control');
    expect(f.stub.createSessionWithInitialAdmission).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace: expect.objectContaining({
          sandboxProvider: 'e2b',
          sandboxProviderBinding: binding,
          credentialContainment: containment,
        }),
      })
    );
    expect(mocks.vercel).not.toHaveBeenCalled();
  });

  it('does not create ownership if the binding and policy cannot be recorded', async () => {
    const f = fixture();
    mocks.progress.mockResolvedValue(null);
    await expect(f.run()).rejects.toMatchObject({ message: 'creation_in_progress' });
    expect(mocks.ingest).not.toHaveBeenCalled();
    expect(f.stub.createSessionWithInitialAdmission).not.toHaveBeenCalled();
  });

  it('keeps a valid selected on-prem binding ahead of overlapping cloud enrollment', async () => {
    const onprem = {
      kind: 'onprem',
      organizationId,
      installationId: credentialId,
      profileId: 'gvisor',
    };
    mocks.onprem.mockResolvedValueOnce(onprem);
    const f = fixture({ BYOC_VERCEL_ORG_IDS: '*', CREDENTIAL_CONTAINMENT_ENABLED: 'false' });
    await f.run();
    expect(mocks.profile).toHaveBeenCalledWith(f.ctx.env, onprem);
    expect(f.stub.createSessionWithInitialAdmission).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace: expect.objectContaining({
          sandboxProviderBinding: onprem,
          credentialContainment: { github: true, gitlab: false, bitbucket: false, kilocode: true },
        }),
      })
    );
    expect(mocks.enrollment).not.toHaveBeenCalled();
    expect(mocks.vercel).not.toHaveBeenCalled();
  });

  it('rejects overlapping Vercel/E2B enrollment without creating ownership', async () => {
    const f = fixture({ BYOC_VERCEL_ORG_IDS: '*' });
    await expect(f.run()).rejects.toMatchObject({ code: 'byoc_e2b_policy_mismatch' });
    expect(mocks.ingest).not.toHaveBeenCalled();
    expect(mocks.enrollment).not.toHaveBeenCalled();
  });

  it('retains the trusted Code Reviewer exception but not a client-supplied origin', async () => {
    const f = fixture({ BYOC_VERCEL_ORG_IDS: '*' });
    await f.run('code-review');
    expect(f.stub.createSessionWithInitialAdmission).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace: expect.objectContaining({
          sandboxProvider: 'cloudflare',
          sandboxId: expect.stringMatching(/^crv-/),
        }),
      })
    );
    expect(mocks.enrollment).not.toHaveBeenCalled();
    const untrusted = fixture(
      { BYOC_VERCEL_ORG_IDS: '*' },
      { options: { kilocodeOrganizationId: organizationId, createdOnPlatform: 'code-review' } }
    );
    await expect(untrusted.run()).rejects.toMatchObject({ code: 'byoc_e2b_policy_mismatch' });
  });

  it('never enrolls personal sessions through a wildcard', async () => {
    const f = fixture({ BYOC_E2B_ORG_IDS: '*' }, { options: { operationKey } });
    await f.run();
    expect(mocks.enrollment).not.toHaveBeenCalled();
    expect(f.stub.createSessionWithInitialAdmission).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace: expect.objectContaining({ sandboxProvider: 'cloudflare' }),
      })
    );
  });

  it.each([
    'byoc_e2b_credential_missing',
    'byoc_e2b_credential_invalid',
    'byoc_e2b_consent_missing',
    'byoc_e2b_unavailable',
  ] as const)('does not fall back or create ownership after %s', async code => {
    mocks.enrollment.mockRejectedValueOnce(new E2BProviderError(code));
    const f = fixture();
    await expect(f.run()).rejects.toMatchObject({ code });
    expect(mocks.ingest).not.toHaveBeenCalled();
    expect(f.stub.createSessionWithInitialAdmission).not.toHaveBeenCalled();
  });

  it.each([{ devcontainer: true }, { sandboxAllocation: 'isolated-standard' }] as const)(
    'rejects unsupported allocation %j before ownership',
    async runtime => {
      const f = fixture({}, { runtime });
      await expect(f.run()).rejects.toThrow();
      expect(mocks.ingest).not.toHaveBeenCalled();
    }
  );
});

describe('E2B admission retry', () => {
  it.each([{ kind: 'prompt' }, { kind: 'clone-only' }] as const)(
    'rejects unsupported isolated-standard $kind creation before admission',
    async ({ kind }) => {
      const f = fixture(
        {},
        {
          runtime: { sandboxAllocation: 'isolated-standard' },
          ...(kind === 'clone-only'
            ? {
                initialTurn: undefined,
                clone: { cloneFromKiloSessionId: 'ses_abcdefghijklmnopqrstuvwxyz' },
              }
            : {}),
        }
      );

      await expect(f.run()).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'Isolated Standard allocation is not supported for control-plane sessions',
      });
      expect.soft(f.row.status).toBe('admitted');
      await expect(f.run()).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'Isolated Standard allocation is not supported for control-plane sessions',
      });
      expect(mocks.admit).not.toHaveBeenCalled();
      expect(mocks.settle).not.toHaveBeenCalled();
      expect(mocks.pending).not.toHaveBeenCalled();
      expect(mocks.progress).not.toHaveBeenCalled();
      expect(mocks.sessionId).not.toHaveBeenCalled();
      expect(mocks.ingest).not.toHaveBeenCalled();
      expect(mocks.onprem).not.toHaveBeenCalled();
      expect(mocks.enrollment).not.toHaveBeenCalled();
      expect(mocks.credential).not.toHaveBeenCalled();
      expect(mocks.vercel).not.toHaveBeenCalled();
      expect(f.stub.createSessionWithInitialAdmission).not.toHaveBeenCalled();
      expect(f.stub.registerSession).not.toHaveBeenCalled();
      expect(f.stub.getMetadata).not.toHaveBeenCalled();
    }
  );

  it('replays a completed isolated-standard Cloudflare create after E2B enrollment', async () => {
    const f = fixture(
      { BYOC_E2B_ORG_IDS: '', CONTROL_PLANE_IDS: '', SANDBOX_SELECTION_IDS: organizationId },
      { runtime: { sandboxAllocation: 'isolated-standard' } }
    );
    const original = await f.run();
    expect(f.row.status).toBe('completed');
    expect(f.row.canonical_result).toMatchObject({
      sandboxProvider: 'cloudflare',
      sandboxId: expect.stringMatching(/^istd-/),
    });

    f.ctx.env.BYOC_E2B_ORG_IDS = organizationId;

    await expect(f.run()).resolves.toEqual({ ...original, replayed: true });
    expect(mocks.sessionId).toHaveBeenCalledTimes(1);
    expect(mocks.ingest).toHaveBeenCalledTimes(1);
    expect(f.stub.createSessionWithInitialAdmission).toHaveBeenCalledTimes(1);
    expect(mocks.enrollment).not.toHaveBeenCalled();
    expect(mocks.credential).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    'resumes the saved binding and policy with grouped=%s and missing ownership',
    async grouped => {
      const f = fixture({
        WORKTREE_CREATION_ENABLED_IDS: grouped ? '*' : '',
        CREDENTIAL_CONTAINMENT_ENABLED: 'false',
      });
      f.stub.createSessionWithInitialAdmission.mockRejectedValueOnce(
        new Error('registration outcome unknown')
      );
      await expect(f.run()).rejects.toThrow('registration outcome unknown');
      const saved = { ...f.row.canonical_result };
      f.dropOwnership();
      Object.assign(f.ctx.env, {
        BYOC_E2B_ORG_IDS: '',
        BYOC_VERCEL_ORG_IDS: '*',
        CREDENTIAL_CONTAINMENT_ENABLED: 'true',
      });
      mocks.onprem.mockResolvedValue({
        kind: 'onprem',
        organizationId,
        installationId: operationKey,
        profileId: 'different',
      });
      mocks.enrollment.mockClear();
      mocks.onprem.mockClear();
      const result = await f.run();
      expect(result).toMatchObject({
        cloudAgentSessionId: saved.cloudAgentSessionId,
        kiloSessionId: saved.kiloSessionId,
        replayed: true,
      });
      expect(f.stub.createSessionWithInitialAdmission).toHaveBeenLastCalledWith(
        expect.objectContaining({
          workspace: expect.objectContaining({
            sandboxProviderBinding: binding,
            credentialContainment: containment,
          }),
        })
      );
      expect(mocks.credential).toHaveBeenCalledWith(f.ctx.env, { organizationId, credentialId });
      expect(mocks.enrollment).not.toHaveBeenCalled();
      expect(mocks.onprem).not.toHaveBeenCalled();
      expect(mocks.sessionId).toHaveBeenCalledTimes(1);
    }
  );

  it('validates exact consent before reissuing a clone ownership call', async () => {
    const f = fixture(
      {},
      {
        initialTurn: undefined,
        clone: { cloneFromKiloSessionId: 'ses_abcdefghijklmnopqrstuvwxyz' },
      }
    );
    f.stub.registerSession.mockRejectedValueOnce(new Error('registration outcome unknown'));
    await expect(f.run()).rejects.toThrow();
    f.dropOwnership();
    mocks.credential.mockRejectedValueOnce(new E2BProviderError('byoc_e2b_consent_missing'));
    const calls = mocks.ingest.mock.calls.length;
    await expect(f.run()).rejects.toMatchObject({ code: 'byoc_e2b_consent_missing' });
    expect(mocks.ingest).toHaveBeenCalledTimes(calls);
    expect(mocks.sessionId).toHaveBeenCalledTimes(1);
  });

  it('fails partial recovery when the saved connection is removed instead of selecting a replacement', async () => {
    const f = fixture();
    f.stub.createSessionWithInitialAdmission.mockRejectedValueOnce(
      new Error('registration outcome unknown')
    );
    await expect(f.run()).rejects.toThrow();
    mocks.credential.mockRejectedValueOnce(new E2BProviderError('byoc_e2b_credential_missing'));
    mocks.enrollment.mockResolvedValue({ ...status, credentialId: operationKey });
    await expect(f.run()).rejects.toMatchObject({ code: 'byoc_e2b_credential_missing' });
    expect(mocks.enrollment).toHaveBeenCalledTimes(1);
    expect(f.stub.createSessionWithInitialAdmission).toHaveBeenCalledTimes(1);
  });

  it.each([
    undefined,
    { github: false, gitlab: false, kilocode: false },
    { ...containment, github: true },
  ])(
    'rejects missing or changed saved flags %j without ownership or registration effects',
    async credentialContainment => {
      const f = fixture();
      await f.run();
      f.row.status = 'reconcile_pending';
      f.row.canonical_result = { ...f.row.canonical_result, credentialContainment };
      await expect(f.run()).rejects.toMatchObject({ code: 'byoc_e2b_policy_mismatch' });
      expect(mocks.ingest).toHaveBeenCalledTimes(1);
      expect(f.stub.createSessionWithInitialAdmission).toHaveBeenCalledTimes(1);
      expect(mocks.credential).not.toHaveBeenCalled();
    }
  );

  it.each(['completed', 'reconcile_pending'] as const)(
    'does not revalidate removed credentials for already registered %s replay',
    async state => {
      const f = fixture();
      const original = await f.run();
      f.row.status = state;
      f.ctx.env.BYOC_E2B_ORG_IDS = '';
      mocks.credential.mockRejectedValue(new E2BProviderError('byoc_e2b_credential_missing'));
      await expect(f.run()).resolves.toEqual({ ...original, replayed: true });
      expect(mocks.credential).not.toHaveBeenCalled();
      expect(mocks.enrollment).toHaveBeenCalledTimes(1);
    }
  );

  it('rejects a different binding in committed metadata on a pending ledger replay', async () => {
    const f = fixture();
    await f.run();
    f.row.status = 'reconcile_pending';
    const stored = await f.stub.getMetadata();
    if (!stored) throw new Error('Expected registered metadata');
    f.stub.getMetadata.mockResolvedValue({
      ...stored,
      workspace: {
        ...stored.workspace,
        sandboxProviderBinding: { ...binding, credentialId: operationKey },
      },
    });
    await expect(f.run()).rejects.toMatchObject({ code: 'byoc_e2b_policy_mismatch' });
    expect(mocks.credential).not.toHaveBeenCalled();
  });

  it('does not reselect or allocate from tombstoned E2B destination IDs', async () => {
    const f = fixture({ WORKTREE_CREATION_ENABLED_IDS: '' });
    await f.run();
    f.row.status = 'reconcile_pending';
    f.dropOwnership();
    f.row.canonical_result = {
      ...f.row.canonical_result,
      [SESSION_CREATE_TOMBSTONED_IDS_KEY]: {
        cloudAgentSessionId: workspaceId,
        kiloSessionId: f.row.canonical_result?.kiloSessionId,
      },
    };
    await expect(f.run()).rejects.toMatchObject({ message: 'session_creation_failed' });
    expect(mocks.sessionId).toHaveBeenCalledTimes(1);
  });
});
