import { createHash } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getWorkerDb } from '@kilocode/db/client';
import type * as DbClientModule from '@kilocode/db/client';
import {
  admitOperation,
  recordOperationAcceptance,
  settleOperation,
} from '@kilocode/db/operation-ledger';
import {
  agent_configs,
  kilocode_users,
  operation_ledgers,
  platform_integrations,
  security_findings,
  security_remediation_attempts,
} from '@kilocode/db/schema';
import type * as SecurityFindingAuditModule from '@kilocode/worker-utils/security-finding-audit';
import type * as QueriesModule from './db/queries.js';
import {
  getAnalysisActorById,
  getSecurityFindingById,
  resolveAutoAnalysisActor,
} from './db/queries.js';
import { logger } from './logger.js';
import {
  admitRemediationAttempt,
  applyAutoRemediationCommand,
  buildRemediationPrepareSessionBody,
  buildRemediationPrompt,
  cancelRemediation,
  dispatchSecurityLifecycleEventForFinding,
  finalizeRemediationCallbackFromEnv,
  maybeAdmitAutoRemediationForCompletedAnalysis,
  remediationTerminalLifecycleEvent,
  startManualRemediation,
} from './remediation.js';
import { DEFAULT_SECURITY_AGENT_CONFIG } from './types.js';

vi.mock('./db/queries.js', async importOriginal => ({
  ...(await importOriginal<typeof QueriesModule>()),
  getSecurityFindingById: vi.fn(),
  getAnalysisActorById: vi.fn(),
  resolveAutoAnalysisActor: vi.fn(),
}));

vi.mock('@kilocode/db/client', async importOriginal => ({
  ...(await importOriginal<typeof DbClientModule>()),
  getWorkerDb: vi.fn(),
}));

vi.mock('@kilocode/db/operation-ledger', () => ({
  admitOperation: vi.fn(),
  recordOperationAcceptance: vi.fn(),
  settleOperation: vi.fn(),
}));

vi.mock('@kilocode/worker-utils/security-finding-audit', async importOriginal => ({
  ...(await importOriginal<typeof SecurityFindingAuditModule>()),
  insertSecurityFindingAuditEvent: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('security remediation admission', () => {
  it('reports a missing finding without starting persistence', async () => {
    const findingId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const transaction = vi.fn();
    const log = vi.spyOn(logger, 'info');
    vi.mocked(getSecurityFindingById).mockResolvedValue(null as never);

    await expect(
      admitRemediationAttempt({
        db: { transaction } as never,
        findingId,
        origin: 'manual',
      })
    ).resolves.toEqual({ admitted: false, reason: 'finding_not_found' });

    expect(transaction).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('Security remediation admission rejected', {
      finding_id: findingId,
      origin: 'manual',
      reason: 'finding_not_found',
    });
  });
});

describe('security remediation approval gate', () => {
  const findingId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  const validFinding = {
    id: findingId,
    owned_by_user_id: 'user-1',
    owned_by_organization_id: null,
    repo_full_name: 'kilo/repo',
    source: 'dependabot',
    source_id: '42',
    status: 'open',
    severity: 'high',
    package_name: 'lodash',
    package_ecosystem: 'npm',
    dependency_scope: 'runtime',
    cve_id: null,
    ghsa_id: null,
    cwe_ids: null,
    cvss_score: null,
    title: 'Command Injection in lodash',
    description: null,
    vulnerable_version_range: '< 4.17.21',
    patched_version: '4.17.21',
    manifest_path: 'package.json',
    raw_data: { updated_at: '2026-01-01T00:00:00.000Z' },
    last_synced_at: '2026-01-02T00:00:00.000Z',
    analysis_status: 'completed',
    analysis_completed_at: '2026-01-02T00:05:00.000Z',
    analysis: {
      analyzedAt: '2026-01-02T00:05:00.000Z',
      sandboxAnalysis: {
        isExploitable: true,
        suggestedAction: 'open_pr',
        suggestedFix: 'Upgrade lodash to 4.17.21',
        usageLocations: [],
        summary: 'Reachable vulnerable lodash usage',
        rawMarkdown: '',
        analysisAt: '2026-01-02T00:05:00.000Z',
      },
    },
  };

  const emptyAttemptsDb = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve([])),
      })),
    })),
  };

  function approvalRequiredRuntimeConfig() {
    return {
      config: {
        ...DEFAULT_SECURITY_AGENT_CONFIG,
        auto_remediation_enabled: true,
        auto_remediation_require_approval: true,
      },
      isAgentEnabled: true,
      repoFullNamesInScope: ['kilo/repo'],
    };
  }

  it('rejects auto_policy admission with approval_required when approval is required', async () => {
    vi.mocked(getSecurityFindingById).mockResolvedValue(validFinding as never);

    await expect(
      admitRemediationAttempt({
        db: emptyAttemptsDb as never,
        findingId,
        origin: 'auto_policy',
        owner: { type: 'user', id: 'user-1' },
        runtimeConfig: approvalRequiredRuntimeConfig(),
      })
    ).resolves.toEqual({ admitted: false, reason: 'approval_required' });
  });

  it('never rejects manual admission for the approval flag', async () => {
    vi.mocked(getSecurityFindingById).mockResolvedValue({
      ...validFinding,
      analysis: {
        ...validFinding.analysis,
        sandboxAnalysis: {
          ...validFinding.analysis.sandboxAnalysis,
          suggestedAction: 'monitor',
        },
      },
    } as never);

    await expect(
      admitRemediationAttempt({
        db: emptyAttemptsDb as never,
        findingId,
        origin: 'manual',
        owner: { type: 'user', id: 'user-1' },
        runtimeConfig: approvalRequiredRuntimeConfig(),
      })
    ).resolves.toEqual({ admitted: false, reason: 'monitor_required' });
  });
});

describe('security remediation launch contract', () => {
  it('does not pass the new remediation branch as upstream checkout branch', () => {
    const body = buildRemediationPrepareSessionBody({
      prompt: 'Fix vulnerable package',
      model: 'kilo-auto/frontier',
      repoFullName: 'Kilo-Org/security-agent-testbed',
      organizationId: undefined,
      callbackTarget: {
        url: 'https://security-auto-analysis.test/internal/security-remediation-callback/attempt',
        headers: { 'X-Callback-Token': 'callback-token' },
      },
    });

    expect(body).toMatchObject({
      prompt: 'Fix vulnerable package',
      mode: 'code',
      model: 'kilo-auto/frontier',
      githubRepo: 'Kilo-Org/security-agent-testbed',
      createdOnPlatform: 'security-remediation',
      autoCommit: false,
    });
    expect(body).not.toHaveProperty('upstreamBranch');
  });

  it('instructs Cloud Agent to create and check out the remediation branch after clone', () => {
    const prompt = buildRemediationPrompt({
      finding: {
        repo_full_name: 'Kilo-Org/security-agent-testbed',
        package_name: 'handlebars',
        package_ecosystem: 'npm',
        severity: 'critical',
        dependency_scope: 'runtime',
        cve_id: null,
        ghsa_id: 'GHSA-765h-qjxv-5f44',
        title: 'Prototype Pollution in handlebars',
        vulnerable_version_range: '<4.7.7',
        patched_version: '4.7.7',
        manifest_path: 'package-lock.json',
        analysis: {
          sandboxAnalysis: {
            isExploitable: 'unknown',
            suggestedAction: 'manual_review',
            suggestedFix: 'Upgrade handlebars to 4.7.7.',
            usageLocations: [],
          },
        },
      } as never,
      branchName: 'security-remediation/handlebars-ghsa-765h-qjxv-5f44/b04cabeb31-1',
      findingUrl: 'https://app.kilo.ai/security-agent/findings?findingId=finding-1',
    });

    expect(prompt).toContain(
      'Create and check out branch security-remediation/handlebars-ghsa-765h-qjxv-5f44/b04cabeb31-1 from the current checkout'
    );
  });
});

describe('security lifecycle event mapping', () => {
  it.each([
    ['pr_opened', 'remediation_pr_opened'],
    ['failed', 'remediation_failed'],
    ['blocked', 'remediation_blocked'],
    ['no_changes_needed', 'remediation_no_changes_needed'],
    ['cancelled', 'remediation_cancelled'],
  ])('maps terminal status %s to %s', (status, event) => {
    expect(remediationTerminalLifecycleEvent(status)).toBe(event);
  });

  it('returns null for non-terminal statuses', () => {
    expect(remediationTerminalLifecycleEvent('queued')).toBeNull();
    expect(remediationTerminalLifecycleEvent('running')).toBeNull();
    expect(remediationTerminalLifecycleEvent('launching')).toBeNull();
  });
});

describe('dispatchSecurityLifecycleEventForFinding', () => {
  const findingId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts the lifecycle body for a personal finding', async () => {
    vi.mocked(getSecurityFindingById).mockResolvedValue({
      id: findingId,
      owned_by_user_id: 'user-1',
      owned_by_organization_id: null,
    } as never);
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await dispatchSecurityLifecycleEventForFinding({
      env: {
        KILOCODE_BACKEND_BASE_URL: 'https://api.kilo.ai',
        INTERNAL_API_SECRET: { get: vi.fn().mockResolvedValue('internal-secret') },
      } as never,
      db: {} as never,
      findingId,
      event: 'remediation_queued',
      remediationId: 'remediation-1',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.kilo.ai/api/internal/security-agent/notifications');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['X-Internal-Secret']).toBe('internal-secret');
    expect(JSON.parse(init.body as string)).toEqual({
      event: 'remediation_queued',
      findingId,
      scope: 'personal',
      remediationId: 'remediation-1',
      recipientUserIds: ['user-1'],
    });
  });

  it('resolves org owners and posts the org scope', async () => {
    vi.mocked(getSecurityFindingById).mockResolvedValue({
      id: findingId,
      owned_by_user_id: null,
      owned_by_organization_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    } as never);
    const db = {
      select: () => ({
        from: () => ({
          where: () =>
            Promise.resolve([{ userId: 'owner-1' }, { userId: 'owner-2' }, { userId: 'owner-1' }]),
        }),
      }),
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await dispatchSecurityLifecycleEventForFinding({
      env: {
        KILOCODE_BACKEND_BASE_URL: 'https://api.kilo.ai',
        INTERNAL_API_SECRET: { get: vi.fn().mockResolvedValue('internal-secret') },
      } as never,
      db: db as never,
      findingId,
      event: 'remediation_pr_opened',
      remediationId: 'remediation-1',
      prUrl: 'https://github.com/acme/api/pull/42',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      event: 'remediation_pr_opened',
      findingId,
      scope: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      remediationId: 'remediation-1',
      prUrl: 'https://github.com/acme/api/pull/42',
      recipientUserIds: ['owner-1', 'owner-2'],
    });
  });

  it('never throws when the POST fails', async () => {
    vi.mocked(getSecurityFindingById).mockResolvedValue({
      id: findingId,
      owned_by_user_id: 'user-1',
      owned_by_organization_id: null,
    } as never);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    await expect(
      dispatchSecurityLifecycleEventForFinding({
        env: {
          KILOCODE_BACKEND_BASE_URL: 'https://api.kilo.ai',
          INTERNAL_API_SECRET: { get: vi.fn().mockResolvedValue('internal-secret') },
        } as never,
        db: {} as never,
        findingId,
        event: 'analysis_completed',
      })
    ).resolves.toBeUndefined();
  });

  it('logs a warning when the POST returns a non-OK status', async () => {
    vi.mocked(getSecurityFindingById).mockResolvedValue({
      id: findingId,
      owned_by_user_id: 'user-1',
      owned_by_organization_id: null,
    } as never);
    const warn = vi.spyOn(logger, 'warn');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 401 })));

    await expect(
      dispatchSecurityLifecycleEventForFinding({
        env: {
          KILOCODE_BACKEND_BASE_URL: 'https://api.kilo.ai',
          INTERNAL_API_SECRET: { get: vi.fn().mockResolvedValue('internal-secret') },
        } as never,
        db: {} as never,
        findingId,
        event: 'analysis_completed',
      })
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith('Security lifecycle push dispatch returned non-OK status', {
      finding_id: findingId,
      event: 'analysis_completed',
      status: 401,
    });
  });

  it('does not POST when the finding is missing', async () => {
    vi.mocked(getSecurityFindingById).mockResolvedValue(null as never);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      dispatchSecurityLifecycleEventForFinding({
        env: {
          KILOCODE_BACKEND_BASE_URL: 'https://api.kilo.ai',
          INTERNAL_API_SECRET: { get: vi.fn().mockResolvedValue('internal-secret') },
        } as never,
        db: {} as never,
        findingId,
        event: 'analysis_completed',
      })
    ).resolves.toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not POST when the recipient list resolves empty', async () => {
    vi.mocked(getSecurityFindingById).mockResolvedValue({
      id: findingId,
      owned_by_user_id: null,
      owned_by_organization_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    } as never);
    const db = {
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([]),
        }),
      }),
    };
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      dispatchSecurityLifecycleEventForFinding({
        env: {
          KILOCODE_BACKEND_BASE_URL: 'https://api.kilo.ai',
          INTERNAL_API_SECRET: { get: vi.fn().mockResolvedValue('internal-secret') },
        } as never,
        db: db as never,
        findingId,
        event: 'analysis_completed',
      })
    ).resolves.toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('finalizeRemediationCallbackFromEnv lifecycle emit sites', () => {
  const ATTEMPT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const REMEDIATION_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const FINDING_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const ATTEMPT_TOKEN = 'attempt-token-123';

  const env = {
    HYPERDRIVE: { connectionString: 'postgres://test' },
    INTERNAL_API_SECRET: { get: vi.fn().mockResolvedValue('internal-secret') },
    KILOCODE_BACKEND_BASE_URL: 'https://api.kilo.ai',
  } as unknown as CloudflareEnv;

  const personalFinding = {
    id: FINDING_ID,
    owned_by_user_id: 'user-1',
    owned_by_organization_id: null,
  } as never;

  function sha256Hex(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  function buildAttempt(overrides: Record<string, unknown> = {}) {
    return {
      id: ATTEMPT_ID,
      finding_id: FINDING_ID,
      remediation_id: REMEDIATION_ID,
      callback_attempt_token_hash: sha256Hex(ATTEMPT_TOKEN),
      cloud_agent_session_id: 'agent-123',
      status: 'running',
      cancellation_requested_at: null,
      requested_by_user_id: null,
      owned_by_user_id: 'user-1',
      owned_by_organization_id: null,
      queued_at: '2026-01-01T00:00:00.000Z',
      origin: 'auto_policy',
      remediation_model_slug: 'anthropic/claude-opus-4.6',
      branch_name: 'security-remediation/package-advisory/abc123-1',
      ...overrides,
    };
  }

  function createFinalizeDb(attempt: Record<string, unknown> | null) {
    const select = vi
      .fn()
      .mockReturnValueOnce({
        from: () => ({
          where: () => ({
            limit: async () => (attempt ? [attempt] : []),
          }),
        }),
      })
      .mockReturnValue({
        from: () => ({
          where: () => ({
            limit: async () => [],
          }),
        }),
      });
    const tx = {
      update: () => ({
        set: () => ({
          where: async () => undefined,
        }),
      }),
    };
    return {
      select,
      transaction: async (fn: (t: typeof tx) => Promise<void>) => fn(tx),
    };
  }

  function eventFromFetch(fetchMock: ReturnType<typeof vi.fn>): string {
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    return (JSON.parse(init.body as string) as { event: string }).event;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('emits remediation_cancelled when an interrupted attempt was cancelled', async () => {
    vi.mocked(getSecurityFindingById).mockResolvedValue(personalFinding);
    vi.mocked(getWorkerDb).mockReturnValue(
      createFinalizeDb(
        buildAttempt({ cancellation_requested_at: '2026-01-02T00:00:00.000Z' })
      ) as never
    );
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      finalizeRemediationCallbackFromEnv({
        env,
        attemptId: ATTEMPT_ID,
        attemptToken: ATTEMPT_TOKEN,
        payload: {
          sessionId: 'session-123',
          cloudAgentSessionId: 'agent-123',
          executionId: 'exec-123',
          status: 'interrupted',
        },
      })
    ).resolves.toEqual({ status: 'cancelled-finalized' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(eventFromFetch(fetchMock)).toBe('remediation_cancelled');
  });

  it('emits remediation_failed when an interrupted attempt was not cancelled', async () => {
    vi.mocked(getSecurityFindingById).mockResolvedValue(personalFinding);
    vi.mocked(getWorkerDb).mockReturnValue(createFinalizeDb(buildAttempt()) as never);
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      finalizeRemediationCallbackFromEnv({
        env,
        attemptId: ATTEMPT_ID,
        attemptToken: ATTEMPT_TOKEN,
        payload: {
          sessionId: 'session-123',
          cloudAgentSessionId: 'agent-123',
          executionId: 'exec-123',
          status: 'interrupted',
          errorMessage: 'Cloud Agent interrupted',
        },
      })
    ).resolves.toEqual({ status: 'failed-finalized' });

    expect(eventFromFetch(fetchMock)).toBe('remediation_failed');
  });

  it('emits remediation_failed when the callback reports a failed attempt', async () => {
    vi.mocked(getSecurityFindingById).mockResolvedValue(personalFinding);
    vi.mocked(getWorkerDb).mockReturnValue(createFinalizeDb(buildAttempt()) as never);
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      finalizeRemediationCallbackFromEnv({
        env,
        attemptId: ATTEMPT_ID,
        attemptToken: ATTEMPT_TOKEN,
        payload: {
          sessionId: 'session-123',
          cloudAgentSessionId: 'agent-123',
          executionId: 'exec-123',
          status: 'failed',
          errorMessage: 'Cloud Agent failed',
        },
      })
    ).resolves.toEqual({ status: 'failed-finalized' });

    expect(eventFromFetch(fetchMock)).toBe('remediation_failed');
  });

  it('emits remediation_failed when the completed result block is missing', async () => {
    vi.mocked(getSecurityFindingById).mockResolvedValue(personalFinding);
    vi.mocked(resolveAutoAnalysisActor).mockResolvedValue(null as never);
    vi.mocked(getWorkerDb).mockReturnValue(createFinalizeDb(buildAttempt()) as never);
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      finalizeRemediationCallbackFromEnv({
        env,
        attemptId: ATTEMPT_ID,
        attemptToken: ATTEMPT_TOKEN,
        payload: {
          sessionId: 'session-123',
          cloudAgentSessionId: 'agent-123',
          executionId: 'exec-123',
          status: 'completed',
        },
      })
    ).resolves.toEqual({ status: 'failed-finalized' });

    expect(eventFromFetch(fetchMock)).toBe('remediation_failed');
  });

  it('emits the terminal event for a parsed completed disposition', async () => {
    vi.mocked(getSecurityFindingById).mockResolvedValue(personalFinding);
    vi.mocked(getWorkerDb).mockReturnValue(createFinalizeDb(buildAttempt()) as never);
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      finalizeRemediationCallbackFromEnv({
        env,
        attemptId: ATTEMPT_ID,
        attemptToken: ATTEMPT_TOKEN,
        payload: {
          sessionId: 'session-123',
          cloudAgentSessionId: 'agent-123',
          executionId: 'exec-123',
          status: 'completed',
          lastAssistantMessageText:
            'SECURITY_REMEDIATION_RESULT\n{"status":"no_changes_needed"}\nEND_SECURITY_REMEDIATION_RESULT',
        },
      })
    ).resolves.toEqual({ status: 'no_changes_needed-finalized' });

    expect(eventFromFetch(fetchMock)).toBe('remediation_no_changes_needed');
  });

  it('does not emit for a missing attempt', async () => {
    vi.mocked(getWorkerDb).mockReturnValue(createFinalizeDb(null) as never);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      finalizeRemediationCallbackFromEnv({
        env,
        attemptId: ATTEMPT_ID,
        attemptToken: ATTEMPT_TOKEN,
        payload: {
          sessionId: 'session-123',
          cloudAgentSessionId: 'agent-123',
          executionId: 'exec-123',
          status: 'completed',
        },
      })
    ).resolves.toEqual({ status: 'missing' });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not emit for an already-terminal attempt', async () => {
    vi.mocked(getWorkerDb).mockReturnValue(
      createFinalizeDb(buildAttempt({ status: 'failed' })) as never
    );
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      finalizeRemediationCallbackFromEnv({
        env,
        attemptId: ATTEMPT_ID,
        attemptToken: ATTEMPT_TOKEN,
        payload: {
          sessionId: 'session-123',
          cloudAgentSessionId: 'agent-123',
          executionId: 'exec-123',
          status: 'completed',
        },
      })
    ).resolves.toEqual({ status: 'already-terminal' });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('remediation queued lifecycle emit sites', () => {
  const ATTEMPT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const REMEDIATION_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const FINDING_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const COMMAND_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

  const env = {
    HYPERDRIVE: { connectionString: 'postgres://worker' },
    REMEDIATION_ATTEMPT_QUEUE: { sendBatch: vi.fn().mockResolvedValue(undefined) },
    KILOCODE_BACKEND_BASE_URL: 'https://api.kilo.ai',
    INTERNAL_API_SECRET: { get: vi.fn().mockResolvedValue('internal-secret') },
  } as unknown as CloudflareEnv;

  const actor = {
    id: 'user-1',
    email: 'user@example.com',
    name: 'User',
    api_token_pepper: null,
    is_admin: false,
  } as never;

  function eligiblePersonalFinding() {
    return {
      id: FINDING_ID,
      owned_by_user_id: 'user-1',
      owned_by_organization_id: null,
      repo_full_name: 'kilo/repo',
      source: 'dependabot',
      source_id: '42',
      status: 'open',
      severity: 'high',
      package_name: 'lodash',
      package_ecosystem: 'npm',
      dependency_scope: 'runtime',
      cve_id: null,
      ghsa_id: null,
      cwe_ids: null,
      cvss_score: null,
      title: 'Command Injection in lodash',
      description: null,
      vulnerable_version_range: '< 4.17.21',
      patched_version: '4.17.21',
      manifest_path: 'package.json',
      raw_data: { updated_at: '2026-01-01T00:00:00.000Z' },
      last_synced_at: '2026-01-02T00:00:00.000Z',
      analysis_status: 'completed',
      analysis_completed_at: '2026-01-02T00:05:00.000Z',
      analysis: {
        analyzedAt: '2026-01-02T00:05:00.000Z',
        sandboxAnalysis: {
          isExploitable: true,
          suggestedAction: 'open_pr',
          suggestedFix: 'Upgrade lodash to 4.17.21',
          usageLocations: [],
          summary: 'Reachable vulnerable lodash usage',
          rawMarkdown: '',
          analysisAt: '2026-01-02T00:05:00.000Z',
        },
      },
    } as never;
  }

  function autoPolicyRuntimeConfig() {
    return {
      ...DEFAULT_SECURITY_AGENT_CONFIG,
      auto_remediation_enabled: true,
      auto_remediation_require_approval: false,
      auto_remediation_enabled_at: '2026-01-01T00:00:00.000Z',
      repository_selection_mode: 'all',
    };
  }

  function bulkExistingRuntimeConfig() {
    return {
      ...DEFAULT_SECURITY_AGENT_CONFIG,
      auto_remediation_enabled: true,
      auto_remediation_require_approval: false,
      auto_remediation_include_existing: true,
      repository_selection_mode: 'all',
    };
  }

  /** A thenable drizzle result that also supports `.limit()` and `.orderBy()`. */
  function thenable(rows: unknown[]) {
    return {
      then: (resolve: (value: unknown) => void) => resolve(rows),
      limit: () => Promise.resolve(rows),
      orderBy: () => thenable(rows),
    };
  }

  function admissionDb(options: {
    runtimeConfig?: unknown;
    attempts?: unknown[];
    candidateFindings?: unknown[];
    ledgerRows?: unknown[];
    userRows?: unknown[];
  }) {
    const rowsFor = (table: unknown): unknown[] => {
      if (table === agent_configs)
        return [{ config: options.runtimeConfig ?? {}, is_enabled: true }];
      if (table === platform_integrations)
        return [{ repositories: [{ id: 1, full_name: 'kilo/repo' }] }];
      if (table === security_remediation_attempts) return options.attempts ?? [];
      if (table === security_findings) return options.candidateFindings ?? [];
      if (table === operation_ledgers) return options.ledgerRows ?? [];
      if (table === kilocode_users) return options.userRows ?? [];
      return [];
    };
    const select = vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(() => thenable(rowsFor(table))),
      })),
    }));
    const tx = {
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          onConflictDoUpdate: vi.fn(() => ({
            returning: vi.fn(() => Promise.resolve([{ id: REMEDIATION_ID }])),
          })),
          returning: vi.fn(() =>
            Promise.resolve([
              {
                id: ATTEMPT_ID,
                remediation_id: REMEDIATION_ID,
                finding_id: FINDING_ID,
                origin: 'manual',
                requested_by_user_id: 'user-1',
                remediation_model_slug: 'model',
                branch_name: 'security-remediation/test-1',
                attempt_number: 1,
              },
            ])
          ),
        })),
      })),
      select: vi.fn(() => ({
        from: vi.fn((table: unknown) => ({
          where: vi.fn(() => thenable(rowsFor(table))),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => thenable([])),
        })),
      })),
    };
    const transaction = vi.fn(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx));
    const update = vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(() => Promise.resolve([])),
        })),
      })),
    }));
    return { select, transaction, update };
  }

  function queuedEventFromFetch(fetchMock: ReturnType<typeof vi.fn>) {
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    return JSON.parse(init.body as string) as { event: string; remediationId: string };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('emits remediation_queued from startManualRemediation', async () => {
    vi.mocked(getSecurityFindingById).mockResolvedValue(eligiblePersonalFinding());
    vi.mocked(getAnalysisActorById).mockResolvedValue(actor);
    vi.mocked(getWorkerDb).mockReturnValue(
      admissionDb({ runtimeConfig: autoPolicyRuntimeConfig() }) as never
    );
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await startManualRemediation({
      env,
      request: {
        schemaVersion: 1,
        findingId: FINDING_ID,
        owner: { userId: 'user-1' },
        actorUserId: 'user-1',
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(queuedEventFromFetch(fetchMock)).toMatchObject({
      event: 'remediation_queued',
      remediationId: REMEDIATION_ID,
    });
  });

  // Regression: the ledger admit must precede the queue hand-off. The queue
  // consumer can reach a terminal state (blocked, launch failure) in
  // milliseconds, and the terminal settle joins on `provider_ref = attemptId`,
  // so an admit that lands after it leaves the row admitted forever.
  it('admits the remediation ledger row before the queue hand-off', async () => {
    vi.mocked(getSecurityFindingById).mockResolvedValue(eligiblePersonalFinding());
    vi.mocked(getAnalysisActorById).mockResolvedValue(actor);
    vi.mocked(getWorkerDb).mockReturnValue(
      admissionDb({ runtimeConfig: autoPolicyRuntimeConfig() }) as never
    );
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })));

    const order: string[] = [];
    vi.mocked(admitOperation).mockImplementation(async () => {
      order.push('admit');
      return { admission: 'admitted', row: { id: 'ledger-row-1' } } as never;
    });
    vi.mocked(recordOperationAcceptance).mockImplementation(async () => {
      order.push('accept');
      return {} as never;
    });
    const sendBatch = vi.fn(async () => {
      order.push('enqueue');
    });
    const orderedEnv = {
      ...(env as unknown as Record<string, unknown>),
      REMEDIATION_ATTEMPT_QUEUE: { sendBatch },
    } as unknown as CloudflareEnv;

    await startManualRemediation({
      env: orderedEnv,
      request: {
        schemaVersion: 1,
        findingId: FINDING_ID,
        owner: { userId: 'user-1' },
        actorUserId: 'user-1',
      },
    });

    expect(order).toEqual(['admit', 'accept', 'enqueue']);
    expect(vi.mocked(admitOperation).mock.calls[0]?.[1]).toMatchObject({
      intent: 'apply_auto_remediation',
      operationKey: `remediation:${ATTEMPT_ID}`,
    });
    expect(vi.mocked(recordOperationAcceptance).mock.calls[0]?.[1]).toMatchObject({
      providerRef: ATTEMPT_ID,
    });
  });

  it('does not fail the manual start when the ledger admit throws', async () => {
    vi.mocked(getSecurityFindingById).mockResolvedValue(eligiblePersonalFinding());
    vi.mocked(getAnalysisActorById).mockResolvedValue(actor);
    vi.mocked(getWorkerDb).mockReturnValue(
      admissionDb({ runtimeConfig: autoPolicyRuntimeConfig() }) as never
    );
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(admitOperation).mockRejectedValue(new Error('database unavailable'));

    await expect(
      startManualRemediation({
        env,
        request: {
          schemaVersion: 1,
          findingId: FINDING_ID,
          owner: { userId: 'user-1' },
          actorUserId: 'user-1',
        },
      })
    ).resolves.toMatchObject({ admitted: true, attemptId: ATTEMPT_ID });
  });

  it('emits remediation_queued from applyAutoRemediationCommand', async () => {
    vi.mocked(getSecurityFindingById).mockResolvedValue(eligiblePersonalFinding());
    vi.mocked(getAnalysisActorById).mockResolvedValue(actor);
    vi.mocked(getWorkerDb).mockReturnValue(
      admissionDb({
        runtimeConfig: bulkExistingRuntimeConfig(),
        candidateFindings: [{ id: FINDING_ID }],
      }) as never
    );
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await applyAutoRemediationCommand({
      env,
      command: {
        schemaVersion: 1,
        commandId: COMMAND_ID,
        owner: { userId: 'user-1' },
        actorUserId: 'user-1',
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(queuedEventFromFetch(fetchMock)).toMatchObject({
      event: 'remediation_queued',
      remediationId: REMEDIATION_ID,
    });
  });

  it('emits remediation_queued from maybeAdmitAutoRemediationForCompletedAnalysis', async () => {
    vi.mocked(getSecurityFindingById).mockResolvedValue(eligiblePersonalFinding());
    vi.mocked(admitOperation).mockResolvedValue({
      admission: 'admitted',
      row: { id: 'ledger-row-1' },
    } as never);
    vi.mocked(recordOperationAcceptance).mockResolvedValue({} as never);
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await maybeAdmitAutoRemediationForCompletedAnalysis({
      db: admissionDb({ runtimeConfig: autoPolicyRuntimeConfig() }) as never,
      env,
      findingId: FINDING_ID,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(queuedEventFromFetch(fetchMock)).toMatchObject({
      event: 'remediation_queued',
      remediationId: REMEDIATION_ID,
    });
  });
});

describe('cancelRemediation queued-cancel lifecycle emit', () => {
  const ATTEMPT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const REMEDIATION_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const FINDING_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  const env = {
    HYPERDRIVE: { connectionString: 'postgres://worker' },
    KILOCODE_BACKEND_BASE_URL: 'https://api.kilo.ai',
    INTERNAL_API_SECRET: { get: vi.fn().mockResolvedValue('internal-secret') },
  } as unknown as CloudflareEnv;

  const personalFinding = {
    id: FINDING_ID,
    owned_by_user_id: 'user-1',
    owned_by_organization_id: null,
  } as never;

  function queuedAttempt() {
    return {
      id: ATTEMPT_ID,
      finding_id: FINDING_ID,
      remediation_id: REMEDIATION_ID,
      status: 'queued',
      owned_by_user_id: 'user-1',
      owned_by_organization_id: null,
      queued_at: '2026-01-01T00:00:00.000Z',
      origin: 'manual',
      requested_by_user_id: 'user-1',
      remediation_model_slug: 'model',
      branch_name: 'security-remediation/test-1',
    };
  }

  function cancelDb() {
    const rowsFor = (table: unknown): unknown[] => {
      if (table === security_remediation_attempts) return [queuedAttempt()];
      if (table === operation_ledgers) return [{ id: 'ledger-row-1' }];
      if (table === kilocode_users) return [{ email: 'owner@example.com' }];
      return [];
    };
    const select = vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve(rowsFor(table))),
        })),
      })),
    }));
    const tx = {
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => Promise.resolve()),
        })),
      })),
    };
    const transaction = vi.fn(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx));
    return { select, transaction };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('emits remediation_cancelled when a queued attempt is cancelled', async () => {
    vi.mocked(getSecurityFindingById).mockResolvedValue(personalFinding);
    vi.mocked(getAnalysisActorById).mockResolvedValue({
      id: 'user-1',
      email: 'user@example.com',
      name: 'User',
      api_token_pepper: null,
      is_admin: false,
    } as never);
    vi.mocked(settleOperation).mockResolvedValue({
      settled: true,
      row: { id: 'ledger-row-1' },
    } as never);
    vi.mocked(getWorkerDb).mockReturnValue(cancelDb() as never);
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await cancelRemediation({
      env,
      request: {
        schemaVersion: 1,
        attemptId: ATTEMPT_ID,
        owner: { userId: 'user-1' },
        actorUserId: 'user-1',
      },
    });

    expect(result).toEqual({ success: true, status: 'cancelled' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({
      event: 'remediation_cancelled',
      remediationId: REMEDIATION_ID,
    });
  });
});
