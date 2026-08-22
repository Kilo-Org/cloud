import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getWorkerDb } from '@kilocode/db/client';
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
import type * as QueriesModule from './db/queries.js';
import { getAnalysisActorById, getSecurityFindingById } from './db/queries.js';
import {
  admitSecurityRemediationLedgerRow,
  cancelRemediation,
  finalizeRemediationCallbackFromEnv,
  maybeAdmitAutoRemediationForCompletedAnalysis,
  processRemediationAttempt,
  settleSecurityRemediationLedgerRow,
  type SecurityRemediationCallbackPayload,
} from './remediation.js';
import { DEFAULT_SECURITY_AGENT_CONFIG } from './types.js';

vi.mock('@kilocode/db/operation-ledger', () => ({
  admitOperation: vi.fn(),
  recordOperationAcceptance: vi.fn(),
  settleOperation: vi.fn(),
}));

vi.mock('@kilocode/db/client', () => ({
  getWorkerDb: vi.fn(),
}));

vi.mock('./db/queries.js', async importOriginal => ({
  ...(await importOriginal<typeof QueriesModule>()),
  getSecurityFindingById: vi.fn(),
  getAnalysisActorById: vi.fn(),
}));

vi.mock('@kilocode/worker-utils/security-finding-audit', () => ({
  SECURITY_FINDING_AUDIT_SYSTEM_ACTOR: { type: 'system' },
  buildSecurityFindingAuditHumanActor: vi.fn(),
  deriveSecurityFindingAuditEventKey: vi.fn(() => 'security-remediation-event-key'),
  insertSecurityFindingAuditEvent: vi.fn(),
}));

const ATTEMPT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REMEDIATION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const FINDING_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const personalFinding = {
  id: FINDING_ID,
  owned_by_user_id: 'user-1',
  owned_by_organization_id: null,
} as never;

/** A fake db whose `select` resolves rows by the queried table. */
function fakeDbForLedger(ledgerRows: unknown[], userRows: unknown[] = []) {
  const select = vi.fn(() => ({
    from: vi.fn((table: unknown) => {
      const rows =
        table === operation_ledgers ? ledgerRows : table === kilocode_users ? userRows : [];
      return {
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve(rows)),
        })),
      };
    }),
  }));
  return { select } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('security remediation ledger admission', () => {
  it('admits the auto_policy operation with the right key and provider ref', async () => {
    vi.mocked(admitOperation).mockResolvedValue({
      admission: 'admitted',
      row: { id: 'ledger-row-1' },
    } as never);
    vi.mocked(recordOperationAcceptance).mockResolvedValue({} as never);

    await admitSecurityRemediationLedgerRow({
      db: fakeDbForLedger([]),
      finding: personalFinding,
      attemptId: ATTEMPT_ID,
      remediationId: REMEDIATION_ID,
      attemptNumber: 1,
    });

    expect(admitOperation).toHaveBeenCalledWith(expect.anything(), {
      userId: 'user-1',
      orgId: null,
      domain: 'security',
      intent: 'apply_auto_remediation',
      operationKey: `remediation:${ATTEMPT_ID}`,
      resourceKey: `security:apply_auto_remediation:user:user-1:${FINDING_ID}`,
      taxonomy: 'reconcile-first',
      leaseSeconds: 120,
    });
    expect(recordOperationAcceptance).toHaveBeenCalledWith(expect.anything(), {
      rowId: 'ledger-row-1',
      providerRef: ATTEMPT_ID,
      canonicalResult: {
        attemptId: ATTEMPT_ID,
        remediationId: REMEDIATION_ID,
        attemptNumber: 1,
      },
    });
  });
});

describe('security remediation ledger settlement', () => {
  it('settles the terminal callback row once by row id', async () => {
    vi.mocked(settleOperation).mockResolvedValue({
      settled: true,
      row: { id: 'ledger-row-1' },
    } as never);

    await settleSecurityRemediationLedgerRow({
      db: fakeDbForLedger([{ id: 'ledger-row-1' }], [{ email: 'owner@example.com' }]),
      finding: personalFinding,
      attempt: {
        id: ATTEMPT_ID,
        queued_at: '2026-01-01T00:00:00.000Z',
        owned_by_user_id: 'user-1',
        owned_by_organization_id: null,
      },
      terminalStatus: 'pr_opened',
    });

    expect(settleOperation).toHaveBeenCalledTimes(1);
    expect(settleOperation).toHaveBeenCalledWith(expect.anything(), {
      rowId: 'ledger-row-1',
      status: 'completed',
      outboxEvent: {
        eventName: 'security_command_settled',
        distinctId: 'owner@example.com',
        properties: {
          source: 'server',
          surface: 'security',
          phase: 'terminal',
          intent: 'apply_auto_remediation',
          outcome: 'completed',
          duration_ms: expect.any(Number),
        },
      },
    });
  });

  it('targets the same row id on a second settle and tolerates the no-op', async () => {
    vi.mocked(settleOperation)
      .mockResolvedValueOnce({ settled: true, row: { id: 'ledger-row-1' } } as never)
      .mockResolvedValueOnce({ settled: false, row: { id: 'ledger-row-1' } } as never);

    const db = fakeDbForLedger([{ id: 'ledger-row-1' }]);
    const attempt = {
      id: ATTEMPT_ID,
      queued_at: '2026-01-01T00:00:00.000Z',
      owned_by_user_id: 'user-1',
      owned_by_organization_id: null,
    };

    await settleSecurityRemediationLedgerRow({
      db,
      finding: personalFinding,
      attempt,
      terminalStatus: 'pr_opened',
    });
    await settleSecurityRemediationLedgerRow({
      db,
      finding: personalFinding,
      attempt,
      terminalStatus: 'pr_opened',
    });

    expect(settleOperation).toHaveBeenCalledTimes(2);
    expect(settleOperation).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({ rowId: 'ledger-row-1' })
    );
    expect(settleOperation).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({ rowId: 'ledger-row-1' })
    );
  });

  it('skips without throwing when the admit row is missing', async () => {
    await expect(
      settleSecurityRemediationLedgerRow({
        db: fakeDbForLedger([]),
        finding: personalFinding,
        attempt: {
          id: ATTEMPT_ID,
          queued_at: '2026-01-01T00:00:00.000Z',
          owned_by_user_id: 'user-1',
          owned_by_organization_id: null,
        },
        terminalStatus: 'failed',
      })
    ).resolves.toBeUndefined();

    expect(settleOperation).not.toHaveBeenCalled();
  });

  it('maps terminal attempt statuses to analytics outcomes', async () => {
    vi.mocked(settleOperation).mockResolvedValue({
      settled: true,
      row: { id: 'ledger-row-1' },
    } as never);

    const db = fakeDbForLedger([{ id: 'ledger-row-1' }]);
    const attempt = {
      id: ATTEMPT_ID,
      queued_at: '2026-01-01T00:00:00.000Z',
      owned_by_user_id: 'user-1',
      owned_by_organization_id: null,
    };
    const cases = [
      ['pr_opened', 'completed'],
      ['failed', 'failed'],
      ['no_changes_needed', 'no_op'],
      ['cancelled', 'interrupted'],
      ['blocked', 'superseded'],
    ] as const;

    for (const [terminalStatus, outcome] of cases) {
      await settleSecurityRemediationLedgerRow({
        db,
        finding: personalFinding,
        attempt,
        terminalStatus,
      });
      expect(settleOperation).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({
          status: outcome,
          outboxEvent: expect.objectContaining({
            properties: expect.objectContaining({ outcome }),
          }),
        })
      );
    }
  });

  it('emits only the contract keys in the outbox payload', async () => {
    vi.mocked(settleOperation).mockResolvedValue({
      settled: true,
      row: { id: 'ledger-row-1' },
    } as never);

    await settleSecurityRemediationLedgerRow({
      db: fakeDbForLedger([{ id: 'ledger-row-1' }], [{ email: 'owner@example.com' }]),
      finding: personalFinding,
      attempt: {
        id: ATTEMPT_ID,
        queued_at: '2026-01-01T00:00:00.000Z',
        owned_by_user_id: 'user-1',
        owned_by_organization_id: null,
      },
      terminalStatus: 'pr_opened',
    });

    const outboxEvent = vi.mocked(settleOperation).mock.calls[0][1].outboxEvent;
    expect(outboxEvent).toBeDefined();
    expect(Object.keys(outboxEvent!.properties).sort()).toEqual(
      ['duration_ms', 'intent', 'outcome', 'phase', 'source', 'surface'].sort()
    );
    // No free text: every value is an enum member or a metric number.
    expect(outboxEvent!.properties).toEqual({
      source: 'server',
      surface: 'security',
      phase: 'terminal',
      intent: 'apply_auto_remediation',
      outcome: 'completed',
      duration_ms: expect.any(Number),
    });
  });
});

// ----- callback settle wiring -------------------------------------------------

const ATTEMPT_TOKEN = 'attempt-token';
const CLOUD_SESSION_ID = 'cloud-session-1';

async function sha256Hex(token: string): Promise<string> {
  const encoded = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Extracts `{ column, value }` pairs from a drizzle `and(eq(...), ...)` SQL. */
function extractEqPredicates(node: unknown): Array<{ column: string; value: string }> {
  const out: Array<{ column: string; value: string }> = [];
  const walk = (n: unknown) => {
    if (!n || typeof n !== 'object') return;
    const chunks = (n as { queryChunks?: unknown[] }).queryChunks;
    if (Array.isArray(chunks)) {
      const column = chunks.find(
        c => c && typeof c === 'object' && typeof (c as { name?: unknown }).name === 'string'
      ) as { name: string } | undefined;
      const valueChunk = chunks.find(
        c =>
          c &&
          typeof c === 'object' &&
          typeof (c as { value?: unknown }).value === 'string' &&
          !('name' in (c as object))
      ) as { value: string } | undefined;
      if (column && valueChunk) out.push({ column: column.name, value: valueChunk.value });
      for (const c of chunks) walk(c);
    }
  };
  walk(node);
  return out;
}

function callbackDb(params: { attempts: unknown[]; ledgerRows?: unknown[]; userRows?: unknown[] }) {
  const rowsFor = (table: unknown) =>
    table === security_remediation_attempts
      ? params.attempts
      : table === operation_ledgers
        ? (params.ledgerRows ?? [])
        : table === kilocode_users
          ? (params.userRows ?? [])
          : [];
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
  return { select, transaction } as never;
}

async function callbackAttempt(overrides: Record<string, unknown> = {}) {
  return {
    id: ATTEMPT_ID,
    status: 'running',
    callback_attempt_token_hash: await sha256Hex(ATTEMPT_TOKEN),
    cloud_agent_session_id: CLOUD_SESSION_ID,
    finding_id: FINDING_ID,
    owned_by_organization_id: null,
    owned_by_user_id: 'user-1',
    queued_at: '2026-01-01T00:00:00.000Z',
    requested_by_user_id: 'user-1',
    cancellation_requested_at: null,
    remediation_id: REMEDIATION_ID,
    branch_name: 'security-remediation/test-1',
    repo_full_name: 'kilo/repo',
    remediation_model_slug: 'model',
    origin: 'auto_policy',
    ...overrides,
  };
}

function callbackEnv(getTokenForRepo: ReturnType<typeof vi.fn> = vi.fn()): CloudflareEnv {
  return {
    HYPERDRIVE: { connectionString: 'postgres://worker' },
    GIT_TOKEN_SERVICE: { getTokenForRepo },
  } as unknown as CloudflareEnv;
}

function callbackPayload(
  overrides: Partial<SecurityRemediationCallbackPayload> = {}
): SecurityRemediationCallbackPayload {
  return {
    sessionId: 'session-1',
    cloudAgentSessionId: CLOUD_SESSION_ID,
    executionId: 'execution-1',
    status: 'completed',
    ...overrides,
  };
}

function settleCallMatcher(outcome: string) {
  return expect.objectContaining({
    rowId: 'ledger-row-1',
    status: outcome,
    outboxEvent: expect.objectContaining({
      properties: expect.objectContaining({ outcome }),
    }),
  });
}

describe('security remediation callback settle wiring', () => {
  it('settles the admitted row as completed on a successful pr_opened callback', async () => {
    vi.mocked(getSecurityFindingById).mockResolvedValue(personalFinding as never);
    vi.mocked(getAnalysisActorById).mockResolvedValue({ id: 'user-1' } as never);
    vi.mocked(settleOperation).mockResolvedValue({
      settled: true,
      row: { id: 'ledger-row-1' },
    } as never);

    const getTokenForRepo = vi.fn().mockResolvedValue({
      success: true,
      token: 'gh-token',
    } as never);
    const env = callbackEnv(getTokenForRepo);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              number: 123,
              html_url: 'https://github.com/kilo/repo/pull/123',
              draft: false,
              base: { ref: 'main' },
              head: { ref: 'security-remediation/test-1', repo: { full_name: 'kilo/repo' } },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
      )
    );

    vi.mocked(getWorkerDb).mockReturnValue(
      callbackDb({
        attempts: [await callbackAttempt()],
        ledgerRows: [{ id: 'ledger-row-1' }],
        userRows: [{ email: 'owner@example.com' }],
      })
    );

    const result = await finalizeRemediationCallbackFromEnv({
      env,
      attemptId: ATTEMPT_ID,
      attemptToken: ATTEMPT_TOKEN,
      payload: callbackPayload({
        status: 'completed',
        lastAssistantMessageText: [
          'SECURITY_REMEDIATION_RESULT',
          JSON.stringify({
            status: 'pr_opened',
            prUrl: 'https://github.com/kilo/repo/pull/123',
            prNumber: 123,
            draft: false,
            headBranch: 'security-remediation/test-1',
            baseBranch: 'main',
            summary: 'Opened PR',
            validation: [],
            riskNotes: null,
            draftReason: null,
            errorReason: null,
          }),
          'END_SECURITY_REMEDIATION_RESULT',
        ].join('\n'),
      }),
    });

    expect(result).toEqual({ status: 'pr_opened-finalized' });
    expect(settleOperation).toHaveBeenCalledWith(expect.anything(), settleCallMatcher('completed'));
  });

  it('settles the admitted row as failed on a failed callback', async () => {
    vi.mocked(getSecurityFindingById).mockResolvedValue(personalFinding as never);
    vi.mocked(settleOperation).mockResolvedValue({
      settled: true,
      row: { id: 'ledger-row-1' },
    } as never);

    vi.mocked(getWorkerDb).mockReturnValue(
      callbackDb({
        attempts: [await callbackAttempt()],
        ledgerRows: [{ id: 'ledger-row-1' }],
        userRows: [{ email: 'owner@example.com' }],
      })
    );

    const result = await finalizeRemediationCallbackFromEnv({
      env: callbackEnv(),
      attemptId: ATTEMPT_ID,
      attemptToken: ATTEMPT_TOKEN,
      payload: callbackPayload({ status: 'failed', errorMessage: 'Cloud Agent failed' }),
    });

    expect(result).toEqual({ status: 'failed-finalized' });
    expect(settleOperation).toHaveBeenCalledWith(expect.anything(), settleCallMatcher('failed'));
  });

  it('settles the admitted row as interrupted on an interrupted callback with a cancellation request', async () => {
    vi.mocked(getSecurityFindingById).mockResolvedValue(personalFinding as never);
    vi.mocked(settleOperation).mockResolvedValue({
      settled: true,
      row: { id: 'ledger-row-1' },
    } as never);

    vi.mocked(getWorkerDb).mockReturnValue(
      callbackDb({
        attempts: [
          await callbackAttempt({ cancellation_requested_at: '2026-01-01T00:01:00.000Z' }),
        ],
        ledgerRows: [{ id: 'ledger-row-1' }],
        userRows: [{ email: 'owner@example.com' }],
      })
    );

    const result = await finalizeRemediationCallbackFromEnv({
      env: callbackEnv(),
      attemptId: ATTEMPT_ID,
      attemptToken: ATTEMPT_TOKEN,
      payload: callbackPayload({ status: 'interrupted' }),
    });

    expect(result).toEqual({ status: 'cancelled-finalized' });
    expect(settleOperation).toHaveBeenCalledWith(
      expect.anything(),
      settleCallMatcher('interrupted')
    );
  });

  it('does not settle when the attempt is already terminal', async () => {
    vi.mocked(getWorkerDb).mockReturnValue(
      callbackDb({ attempts: [await callbackAttempt({ status: 'pr_opened' })] })
    );

    const result = await finalizeRemediationCallbackFromEnv({
      env: callbackEnv(),
      attemptId: ATTEMPT_ID,
      attemptToken: ATTEMPT_TOKEN,
      payload: callbackPayload({ status: 'completed' }),
    });

    expect(result).toEqual({ status: 'already-terminal' });
    expect(settleOperation).not.toHaveBeenCalled();
  });
});

describe('security remediation ledger settle lookup', () => {
  it('filters the settle lookup by domain, kilo_user_id, intent, and provider_ref', async () => {
    vi.mocked(settleOperation).mockResolvedValue({
      settled: true,
      row: { id: 'ledger-row-1' },
    } as never);

    let capturedWhere: unknown;
    const select = vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn((whereArg: unknown) => {
          if (table === operation_ledgers) capturedWhere = whereArg;
          return {
            limit: vi.fn(() =>
              Promise.resolve(table === operation_ledgers ? [{ id: 'ledger-row-1' }] : [])
            ),
          };
        }),
      })),
    }));

    await settleSecurityRemediationLedgerRow({
      db: { select } as never,
      finding: personalFinding,
      attempt: {
        id: ATTEMPT_ID,
        queued_at: '2026-01-01T00:00:00.000Z',
        owned_by_user_id: 'user-1',
        owned_by_organization_id: null,
      },
      terminalStatus: 'failed',
    });

    expect(extractEqPredicates(capturedWhere)).toEqual([
      { column: 'domain', value: 'security' },
      { column: 'kilo_user_id', value: 'user-1' },
      { column: 'intent', value: 'apply_auto_remediation' },
      { column: 'provider_ref', value: ATTEMPT_ID },
    ]);
  });
});

// ----- repaired terminal-path settle wiring ----------------------------------

const QUEUED_AT = '2026-01-01T00:00:00.000Z';

/** A thenable drizzle result that also supports `.limit()` and `.orderBy()`. */
function selectResult(rows: unknown[]) {
  return {
    then: (resolve: (value: unknown) => void) => resolve(rows),
    limit: () => Promise.resolve(rows),
    orderBy: () => selectResult(rows),
  };
}

function eligibleAutoPolicyFinding() {
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
    title: 'Test finding',
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

describe('maybeAdmitAutoRemediationForCompletedAnalysis enqueue-failure settle', () => {
  it('settles the admitted row as failed after the queue admission failure', async () => {
    const finding = eligibleAutoPolicyFinding();
    vi.mocked(getSecurityFindingById).mockResolvedValue(finding);
    vi.mocked(admitOperation).mockResolvedValue({
      admission: 'admitted',
      row: { id: 'ledger-row-1' },
    } as never);
    vi.mocked(recordOperationAcceptance).mockResolvedValue({} as never);
    vi.mocked(settleOperation).mockResolvedValue({
      settled: true,
      row: { id: 'ledger-row-1' },
    } as never);

    const attemptRow = {
      id: ATTEMPT_ID,
      finding_id: FINDING_ID,
      remediation_id: REMEDIATION_ID,
      queued_at: QUEUED_AT,
      attempt_number: 1,
    };
    const remediationRow = { id: REMEDIATION_ID };

    const outerRowsFor = (table: unknown) => {
      if (table === agent_configs) return [{ config: autoPolicyRuntimeConfig(), is_enabled: true }];
      if (table === platform_integrations)
        return [{ repositories: [{ id: 1, full_name: 'kilo/repo' }] }];
      if (table === security_remediation_attempts)
        return [{ id: ATTEMPT_ID, queued_at: QUEUED_AT }];
      if (table === operation_ledgers) return [{ id: 'ledger-row-1' }];
      if (table === kilocode_users) return [{ email: 'owner@example.com' }];
      if (table === security_findings) return [finding];
      return [];
    };

    const db = {
      select: vi.fn(() => ({
        from: vi.fn((table: unknown) => ({
          where: vi.fn(() => selectResult(outerRowsFor(table))),
        })),
      })),
      transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          insert: vi.fn(() => ({
            values: vi.fn(() => ({
              onConflictDoUpdate: vi.fn(() => ({
                returning: vi.fn(() => Promise.resolve([remediationRow])),
              })),
              returning: vi.fn(() => Promise.resolve([attemptRow])),
            })),
          })),
          select: vi.fn(() => ({
            from: vi.fn((table: unknown) => ({
              where: vi.fn(() => selectResult(table === security_findings ? [finding] : [])),
            })),
          })),
          update: vi.fn(() => ({
            set: vi.fn(() => ({
              where: vi.fn(() => ({
                then: (resolve: (value: unknown) => void) => resolve([]),
                returning: vi.fn(() => Promise.resolve([attemptRow])),
              })),
            })),
          })),
        };
        return cb(tx);
      }),
    };

    const sendBatch = vi.fn().mockRejectedValue(new Error('queue down'));

    await expect(
      maybeAdmitAutoRemediationForCompletedAnalysis({
        db: db as never,
        env: { REMEDIATION_ATTEMPT_QUEUE: { sendBatch } } as unknown as CloudflareEnv,
        findingId: FINDING_ID,
      })
    ).rejects.toThrow('queue down');

    expect(settleOperation).toHaveBeenCalledWith(expect.anything(), settleCallMatcher('failed'));
  });
});

describe('cancelRemediation queued-attempt settle', () => {
  it('settles the admitted row as interrupted when a queued attempt is cancelled', async () => {
    vi.mocked(getSecurityFindingById).mockResolvedValue(personalFinding as never);
    vi.mocked(getAnalysisActorById).mockResolvedValue({
      id: 'user-1',
      email: 'user@example.com',
      name: 'User',
      is_admin: false,
    } as never);
    vi.mocked(settleOperation).mockResolvedValue({
      settled: true,
      row: { id: 'ledger-row-1' },
    } as never);

    vi.mocked(getWorkerDb).mockReturnValue(
      callbackDb({
        attempts: [await callbackAttempt({ status: 'queued' })],
        ledgerRows: [{ id: 'ledger-row-1' }],
        userRows: [{ email: 'owner@example.com' }],
      })
    );

    const result = await cancelRemediation({
      env: { HYPERDRIVE: { connectionString: 'postgres://worker' } } as unknown as CloudflareEnv,
      request: {
        schemaVersion: 1,
        attemptId: ATTEMPT_ID,
        owner: { userId: 'user-1' },
        actorUserId: 'user-1',
      },
    });

    expect(result).toEqual({ success: true, status: 'cancelled' });
    expect(settleOperation).toHaveBeenCalledWith(
      expect.anything(),
      settleCallMatcher('interrupted')
    );
  });
});

describe('processRemediationAttempt blocked-path settle', () => {
  it('settles the admitted row as superseded when the attempt is blocked before launch', async () => {
    vi.mocked(getSecurityFindingById).mockResolvedValue({
      id: FINDING_ID,
      owned_by_user_id: 'user-1',
      owned_by_organization_id: null,
      status: 'open',
    } as never);
    vi.mocked(settleOperation).mockResolvedValue({
      settled: true,
      row: { id: 'ledger-row-1' },
    } as never);

    const attempt = {
      id: ATTEMPT_ID,
      finding_id: FINDING_ID,
      owned_by_organization_id: null,
      owned_by_user_id: 'user-1',
      remediation_id: REMEDIATION_ID,
      origin: 'auto_policy',
      analysis_fingerprint: 'fingerprint',
      requested_by_user_id: null,
      repo_full_name: 'kilo/repo',
      remediation_model_slug: 'model',
      branch_name: 'security-remediation/test-1',
      status: 'launching',
      queued_at: QUEUED_AT,
      claim_token: 'claim-token',
      claimed_at: QUEUED_AT,
      claimed_by_job_id: 'job-1',
      launch_attempt_count: 1,
      next_retry_at: null,
      attempt_number: 1,
      priority: 50,
    };

    const rowsFor = (table: unknown) => {
      if (table === agent_configs) return [{ config: {}, is_enabled: false }];
      if (table === operation_ledgers) return [{ id: 'ledger-row-1' }];
      if (table === kilocode_users) return [{ email: 'owner@example.com' }];
      return [];
    };

    const db = {
      execute: vi.fn(async () => ({ rows: [attempt] })),
      select: vi.fn(() => ({
        from: vi.fn((table: unknown) => ({
          where: vi.fn(() => selectResult(rowsFor(table))),
        })),
      })),
      transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          update: vi.fn(() => ({
            set: vi.fn(() => ({
              where: vi.fn(() => ({
                then: (resolve: (value: unknown) => void) => resolve([]),
              })),
            })),
          })),
        };
        return cb(tx);
      }),
    };

    vi.mocked(getWorkerDb).mockReturnValue(db as never);

    const result = await processRemediationAttempt({
      env: { HYPERDRIVE: { connectionString: 'postgres://worker' } } as unknown as CloudflareEnv,
      attemptId: ATTEMPT_ID,
      dispatchId: 'dispatch-1',
    });

    expect(result).toBe('skipped');
    expect(settleOperation).toHaveBeenCalledWith(
      expect.anything(),
      settleCallMatcher('superseded')
    );
  });
});

// ----- finding-missing and launch-path settle wiring ------------------------

/** A db that records the operation_ledgers settle lookup where clause. */
function ledgerCapturingDb(params: {
  attempt: unknown;
  attempts?: unknown[];
  ledgerRows?: unknown[];
  userRows?: unknown[];
  agentConfigs?: unknown[];
  integrations?: unknown[];
}) {
  let capturedLedgerWhere: unknown;
  const rowsFor = (table: unknown): unknown[] => {
    if (table === security_remediation_attempts) return params.attempts ?? [];
    if (table === operation_ledgers) return params.ledgerRows ?? [];
    if (table === kilocode_users) return params.userRows ?? [];
    if (table === agent_configs) return params.agentConfigs ?? [];
    if (table === platform_integrations) return params.integrations ?? [];
    return [];
  };
  const chain = (table: unknown): unknown => ({
    then: (resolve: (value: unknown) => void) => resolve(rowsFor(table)),
    limit: () => Promise.resolve(rowsFor(table)),
    orderBy: () => chain(table),
    innerJoin: () => chain(null),
    where: (whereArg?: unknown) => {
      if (table === operation_ledgers) capturedLedgerWhere = whereArg;
      return chain(table);
    },
  });
  const select = vi.fn(() => ({
    from: vi.fn((table: unknown) => chain(table)),
  }));
  const tx = {
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve()),
      })),
    })),
  };
  const transaction = vi.fn(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx));
  const execute = vi.fn(async () => ({ rows: [params.attempt] }));
  const insert = vi.fn(() => ({
    values: vi.fn(() => Promise.resolve()),
  }));
  return {
    select,
    transaction,
    execute,
    insert,
    getCapturedLedgerWhere: () => capturedLedgerWhere,
  };
}

function launchingAttempt(overrides: Record<string, unknown> = {}) {
  return {
    id: ATTEMPT_ID,
    finding_id: FINDING_ID,
    owned_by_organization_id: null,
    owned_by_user_id: 'user-1',
    remediation_id: REMEDIATION_ID,
    origin: 'auto_policy',
    analysis_fingerprint: 'fingerprint',
    requested_by_user_id: 'user-1',
    repo_full_name: 'kilo/repo',
    remediation_model_slug: 'model',
    branch_name: 'security-remediation/test-1',
    status: 'launching',
    queued_at: QUEUED_AT,
    claim_token: 'claim-token',
    claimed_at: QUEUED_AT,
    claimed_by_job_id: 'job-1',
    launch_attempt_count: 1,
    next_retry_at: null,
    attempt_number: 1,
    priority: 50,
    ...overrides,
  };
}

describe('security remediation ledger settle with a missing finding', () => {
  it('looks up the settle row by the attempt-derived user id', async () => {
    vi.mocked(settleOperation).mockResolvedValue({
      settled: true,
      row: { id: 'ledger-row-1' },
    } as never);

    const db = ledgerCapturingDb({
      attempt: {},
      ledgerRows: [{ id: 'ledger-row-1' }],
      userRows: [{ email: 'owner@example.com' }],
    });

    await settleSecurityRemediationLedgerRow({
      db: db as never,
      finding: null,
      attempt: {
        id: ATTEMPT_ID,
        queued_at: '2026-01-01T00:00:00.000Z',
        owned_by_user_id: 'attempt-user-1',
        owned_by_organization_id: null,
      },
      terminalStatus: 'cancelled',
    });

    expect(extractEqPredicates(db.getCapturedLedgerWhere())).toEqual([
      { column: 'domain', value: 'security' },
      { column: 'kilo_user_id', value: 'attempt-user-1' },
      { column: 'intent', value: 'apply_auto_remediation' },
      { column: 'provider_ref', value: ATTEMPT_ID },
    ]);
    expect(settleOperation).toHaveBeenCalledWith(
      expect.anything(),
      settleCallMatcher('interrupted')
    );
  });
});

describe('cancelRemediation missing-finding settle', () => {
  it('settles the admitted row as interrupted when the queued attempt finding is gone', async () => {
    vi.mocked(getSecurityFindingById).mockResolvedValue(null as never);
    vi.mocked(getAnalysisActorById).mockResolvedValue({
      id: 'attempt-user-1',
      email: 'user@example.com',
      name: 'User',
      is_admin: false,
    } as never);
    vi.mocked(settleOperation).mockResolvedValue({
      settled: true,
      row: { id: 'ledger-row-1' },
    } as never);

    const attempt = await callbackAttempt({
      status: 'queued',
      owned_by_user_id: 'attempt-user-1',
    });
    const db = ledgerCapturingDb({
      attempt,
      attempts: [attempt],
      ledgerRows: [{ id: 'ledger-row-1' }],
      userRows: [{ email: 'owner@example.com' }],
    });
    vi.mocked(getWorkerDb).mockReturnValue(db as never);

    const result = await cancelRemediation({
      env: { HYPERDRIVE: { connectionString: 'postgres://worker' } } as unknown as CloudflareEnv,
      request: {
        schemaVersion: 1,
        attemptId: ATTEMPT_ID,
        owner: { userId: 'attempt-user-1' },
        actorUserId: 'attempt-user-1',
      },
    });

    expect(result).toEqual({ success: true, status: 'cancelled' });
    expect(settleOperation).toHaveBeenCalledWith(
      expect.anything(),
      settleCallMatcher('interrupted')
    );
    expect(extractEqPredicates(db.getCapturedLedgerWhere())).toEqual([
      { column: 'domain', value: 'security' },
      { column: 'kilo_user_id', value: 'attempt-user-1' },
      { column: 'intent', value: 'apply_auto_remediation' },
      { column: 'provider_ref', value: ATTEMPT_ID },
    ]);
  });
});

describe('processRemediationAttempt finding-unavailable settle', () => {
  it('settles the admitted row as superseded when the finding is gone before launch', async () => {
    vi.mocked(getSecurityFindingById).mockResolvedValue(null as never);
    vi.mocked(settleOperation).mockResolvedValue({
      settled: true,
      row: { id: 'ledger-row-1' },
    } as never);

    const attempt = launchingAttempt({ owned_by_user_id: 'attempt-user-1' });
    const db = ledgerCapturingDb({
      attempt,
      ledgerRows: [{ id: 'ledger-row-1' }],
      userRows: [{ email: 'owner@example.com' }],
    });
    vi.mocked(getWorkerDb).mockReturnValue(db as never);

    const result = await processRemediationAttempt({
      env: { HYPERDRIVE: { connectionString: 'postgres://worker' } } as unknown as CloudflareEnv,
      attemptId: ATTEMPT_ID,
      dispatchId: 'dispatch-1',
    });

    expect(result).toBe('failed');
    expect(settleOperation).toHaveBeenCalledWith(
      expect.anything(),
      settleCallMatcher('superseded')
    );
    expect(extractEqPredicates(db.getCapturedLedgerWhere())).toEqual([
      { column: 'domain', value: 'security' },
      { column: 'kilo_user_id', value: 'attempt-user-1' },
      { column: 'intent', value: 'apply_auto_remediation' },
      { column: 'provider_ref', value: ATTEMPT_ID },
    ]);
  });
});

describe('processRemediationAttempt terminal launch-failure settle', () => {
  it('settles the admitted row as failed when launch fails terminally', async () => {
    vi.mocked(getSecurityFindingById).mockResolvedValue(eligibleAutoPolicyFinding());
    vi.mocked(getAnalysisActorById).mockResolvedValue(null);
    vi.mocked(settleOperation).mockResolvedValue({
      settled: true,
      row: { id: 'ledger-row-1' },
    } as never);

    const db = ledgerCapturingDb({
      attempt: launchingAttempt(),
      ledgerRows: [{ id: 'ledger-row-1' }],
      userRows: [{ email: 'owner@example.com' }],
      agentConfigs: [{ config: autoPolicyRuntimeConfig(), is_enabled: true }],
      integrations: [{ repositories: [{ id: 1, full_name: 'kilo/repo' }] }],
    });
    vi.mocked(getWorkerDb).mockReturnValue(db as never);

    const result = await processRemediationAttempt({
      env: { HYPERDRIVE: { connectionString: 'postgres://worker' } } as unknown as CloudflareEnv,
      attemptId: ATTEMPT_ID,
      dispatchId: 'dispatch-1',
    });

    expect(result).toBe('failed');
    expect(settleOperation).toHaveBeenCalledWith(expect.anything(), settleCallMatcher('failed'));
  });
});

describe('processRemediationAttempt pre-initiation cancellation settle', () => {
  it('settles the admitted row as interrupted when cancellation is requested before initiation', async () => {
    vi.mocked(getSecurityFindingById).mockResolvedValue(eligibleAutoPolicyFinding());
    vi.mocked(getAnalysisActorById).mockResolvedValue({
      id: 'user-1',
      api_token_pepper: null,
    } as never);
    vi.mocked(settleOperation).mockResolvedValue({
      settled: true,
      row: { id: 'ledger-row-1' },
    } as never);

    const cloudAgentFetch = vi.fn(async () =>
      Response.json({
        result: { data: { cloudAgentSessionId: 'agent-session', kiloSessionId: 'ses-123' } },
      })
    );

    const db = ledgerCapturingDb({
      attempt: launchingAttempt(),
      attempts: [
        {
          id: ATTEMPT_ID,
          status: 'launching',
          analysisFingerprint: null,
          cancellationRequestedAt: '2026-01-01T00:01:00.000Z',
        },
      ],
      ledgerRows: [{ id: 'ledger-row-1' }],
      userRows: [{ email: 'owner@example.com' }],
      agentConfigs: [{ config: autoPolicyRuntimeConfig(), is_enabled: true }],
      integrations: [{ repositories: [{ id: 1, full_name: 'kilo/repo' }] }],
    });
    vi.mocked(getWorkerDb).mockReturnValue(db as never);

    const result = await processRemediationAttempt({
      env: {
        HYPERDRIVE: { connectionString: 'postgres://worker' },
        NEXTAUTH_SECRET: { get: async () => 'next-auth-secret' },
        INTERNAL_API_SECRET: { get: async () => 'internal-api-secret' },
        CALLBACK_TOKEN_SECRET: { get: async () => 'callback-token-secret' },
        ENVIRONMENT: 'development',
        SECURITY_ANALYSIS_CALLBACK_ROUTING_MODE: 'web',
        SECURITY_ANALYSIS_CALLBACK_WEB_BASE_URL: 'https://app.kilo.ai',
        CLOUD_AGENT_NEXT: { fetch: cloudAgentFetch },
      } as unknown as CloudflareEnv,
      attemptId: ATTEMPT_ID,
      dispatchId: 'dispatch-1',
    });

    expect(result).toBe('launched');
    expect(settleOperation).toHaveBeenCalledWith(
      expect.anything(),
      settleCallMatcher('interrupted')
    );
  });
});

// ----- processRemediationAttempt lifecycle emit wiring ----------------------

const lifecycleEnv = {
  HYPERDRIVE: { connectionString: 'postgres://worker' },
  KILOCODE_BACKEND_BASE_URL: 'https://api.kilo.ai',
  INTERNAL_API_SECRET: { get: async () => 'internal-secret' },
} as unknown as CloudflareEnv;

function postedLifecycleEvents(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls
    .map(call => {
      const init = call[1] as RequestInit | undefined;
      if (!init?.body) return null;
      try {
        return (JSON.parse(init.body as string) as { event?: string }).event ?? null;
      } catch {
        return null;
      }
    })
    .filter((event): event is string => event !== null);
}

describe('processRemediationAttempt lifecycle emit wiring', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 200 }))
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('emits remediation_blocked when the attempt is blocked before launch', async () => {
    vi.mocked(getSecurityFindingById).mockResolvedValue(eligibleAutoPolicyFinding());
    vi.mocked(settleOperation).mockResolvedValue({
      settled: true,
      row: { id: 'ledger-row-1' },
    } as never);

    const db = ledgerCapturingDb({
      attempt: launchingAttempt(),
      ledgerRows: [{ id: 'ledger-row-1' }],
      userRows: [{ email: 'owner@example.com' }],
      agentConfigs: [{ config: autoPolicyRuntimeConfig(), is_enabled: false }],
      integrations: [{ repositories: [{ id: 1, full_name: 'kilo/repo' }] }],
    });
    vi.mocked(getWorkerDb).mockReturnValue(db as never);

    const result = await processRemediationAttempt({
      env: lifecycleEnv,
      attemptId: ATTEMPT_ID,
      dispatchId: 'dispatch-1',
    });

    expect(result).toBe('skipped');
    expect(postedLifecycleEvents(vi.mocked(fetch))).toEqual(['remediation_blocked']);
  });

  it('emits remediation_failed when launch fails terminally', async () => {
    vi.mocked(getSecurityFindingById).mockResolvedValue(eligibleAutoPolicyFinding());
    vi.mocked(getAnalysisActorById).mockResolvedValue(null);
    vi.mocked(settleOperation).mockResolvedValue({
      settled: true,
      row: { id: 'ledger-row-1' },
    } as never);

    const db = ledgerCapturingDb({
      attempt: launchingAttempt(),
      ledgerRows: [{ id: 'ledger-row-1' }],
      userRows: [{ email: 'owner@example.com' }],
      agentConfigs: [{ config: autoPolicyRuntimeConfig(), is_enabled: true }],
      integrations: [{ repositories: [{ id: 1, full_name: 'kilo/repo' }] }],
    });
    vi.mocked(getWorkerDb).mockReturnValue(db as never);

    const result = await processRemediationAttempt({
      env: lifecycleEnv,
      attemptId: ATTEMPT_ID,
      dispatchId: 'dispatch-1',
    });

    expect(result).toBe('failed');
    expect(postedLifecycleEvents(vi.mocked(fetch))).toEqual(['remediation_failed']);
  });

  it('does not emit when a retryable launch failure re-queues the attempt', async () => {
    vi.mocked(getSecurityFindingById).mockResolvedValue(eligibleAutoPolicyFinding());
    vi.mocked(getAnalysisActorById).mockResolvedValue({
      id: 'user-1',
      api_token_pepper: null,
    } as never);
    vi.mocked(settleOperation).mockResolvedValue({
      settled: true,
      row: { id: 'ledger-row-1' },
    } as never);

    const db = ledgerCapturingDb({
      attempt: launchingAttempt({ launch_attempt_count: 1 }),
      ledgerRows: [{ id: 'ledger-row-1' }],
      userRows: [{ email: 'owner@example.com' }],
      agentConfigs: [{ config: autoPolicyRuntimeConfig(), is_enabled: true }],
      integrations: [{ repositories: [{ id: 1, full_name: 'kilo/repo' }] }],
    });
    vi.mocked(getWorkerDb).mockReturnValue(db as never);

    const result = await processRemediationAttempt({
      env: {
        ...lifecycleEnv,
        CLOUD_AGENT_NEXT: {
          fetch: vi.fn(async () => {
            throw new Error('upstream 5xx');
          }),
        },
      } as unknown as CloudflareEnv,
      attemptId: ATTEMPT_ID,
      dispatchId: 'dispatch-1',
    });

    expect(result).toBe('failed');
    expect(postedLifecycleEvents(vi.mocked(fetch))).toEqual([]);
  });

  it('emits remediation_failed when a retryable launch failure exhausts its attempts', async () => {
    vi.mocked(getSecurityFindingById).mockResolvedValue(eligibleAutoPolicyFinding());
    vi.mocked(getAnalysisActorById).mockResolvedValue({
      id: 'user-1',
      api_token_pepper: null,
    } as never);
    vi.mocked(settleOperation).mockResolvedValue({
      settled: true,
      row: { id: 'ledger-row-1' },
    } as never);

    const db = ledgerCapturingDb({
      attempt: launchingAttempt({ launch_attempt_count: 3 }),
      ledgerRows: [{ id: 'ledger-row-1' }],
      userRows: [{ email: 'owner@example.com' }],
      agentConfigs: [{ config: autoPolicyRuntimeConfig(), is_enabled: true }],
      integrations: [{ repositories: [{ id: 1, full_name: 'kilo/repo' }] }],
    });
    vi.mocked(getWorkerDb).mockReturnValue(db as never);

    const result = await processRemediationAttempt({
      env: {
        ...lifecycleEnv,
        CLOUD_AGENT_NEXT: {
          fetch: vi.fn(async () => {
            throw new Error('upstream 5xx');
          }),
        },
      } as unknown as CloudflareEnv,
      attemptId: ATTEMPT_ID,
      dispatchId: 'dispatch-1',
    });

    expect(result).toBe('failed');
    expect(postedLifecycleEvents(vi.mocked(fetch))).toEqual(['remediation_failed']);
  });
});
