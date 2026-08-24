/**
 * @jest-environment node
 *
 * Security settled-outcome coverage for the two intents added in P1-A-07c:
 * `start_analysis` (admitted through `runSecurityLedgerSubmit`, settled by the
 * web observation settle) and `apply_auto_remediation`, whose row the Worker
 * admits before the queue hand-off — the web handler must NOT admit it, or a
 * web admit could land after the Worker's terminal settle and leave the row
 * unsettled forever. The ledger helpers are mocked; the observation settle
 * reads the real `operation_ledgers` table, so rows are inserted directly.
 */
import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { createSecurityAgentHandlers as createSecurityAgentHandlersType } from './router/shared-handlers';
import type * as manualAnalysisClientModule from './services/manual-analysis-client';
import type * as manualRemediationClientModule from './services/manual-remediation-client';
import { randomUUID } from 'crypto';
import { sql } from 'drizzle-orm';
import { db } from '@/lib/drizzle';
import { operation_ledgers, type OperationLedgerRow } from '@kilocode/db/schema';

const mockSubmitManualAnalysisStart = jest.fn() as jest.MockedFunction<
  typeof manualAnalysisClientModule.submitManualAnalysisStart
>;
const mockSubmitManualRemediationStart = jest.fn() as jest.MockedFunction<
  typeof manualRemediationClientModule.submitManualRemediationStart
>;
const mockGetSecurityFindingById = jest.fn<() => Promise<unknown>>();
const mockCanStartAnalysis = jest.fn<(owner: unknown) => Promise<unknown>>();
const mockGetSecurityAgentCommandStatus = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockTrackSecurityAgentRemediationAction = jest.fn();
const mockAdmitOperation = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockMarkReconcilePending = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockRecordOperationAcceptance = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockSettleOperation = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.mock('./services/manual-analysis-client', () => ({
  submitManualAnalysisStart: mockSubmitManualAnalysisStart,
}));
jest.mock('./services/manual-remediation-client', () => ({
  submitApplyAutoRemediation: jest.fn(),
  submitManualRemediationStart: mockSubmitManualRemediationStart,
  submitRemediationCancellation: jest.fn(),
}));
jest.mock('./services/manual-sync-client', () => ({ submitManualSecuritySync: jest.fn() }));
jest.mock('./services/manual-dismiss-client', () => ({ submitManualFindingDismissal: jest.fn() }));
jest.mock('@kilocode/db/operation-ledger', () => ({
  admitOperation: mockAdmitOperation,
  isTerminalOperationStatus: (status: string) =>
    ['completed', 'failed', 'no_op', 'interrupted', 'superseded'].includes(status),
  markReconcilePending: mockMarkReconcilePending,
  recordOperationAcceptance: mockRecordOperationAcceptance,
  settleOperation: mockSettleOperation,
}));
jest.mock('./github/permissions', () => ({
  hasSecurityReviewPermissions: () => true,
  getReauthorizeUrl: jest.fn(),
}));
jest.mock('./github/dependabot-api', () => ({
  checkDependabotAlertsAvailability: jest.fn(),
}));
jest.mock('./posthog-tracking', () => ({
  trackSecurityAgentEnabled: jest.fn(),
  trackSecurityAgentConfigSaved: jest.fn(),
  trackSecurityAgentSync: jest.fn(),
  trackSecurityAgentFindingDismissed: jest.fn(),
  trackSecurityAgentUiInteraction: jest.fn(),
  trackSecurityAgentRemediationAction: mockTrackSecurityAgentRemediationAction,
}));
jest.mock('./services/audit-log-service', () => ({
  createSecurityAuditLog: jest.fn(),
  logSecurityAudit: jest.fn(),
  SecurityAuditLogAction: {},
}));
jest.mock('./db/security-config', () => ({
  getSecurityAgentConfigWithStatus: jest.fn(),
  upsertSecurityAgentConfig: jest.fn(),
  saveSecurityAgentConfigWithRevision: jest.fn(),
  setSecurityAgentEnabled: jest.fn(),
}));
jest.mock('./db/security-findings', () => ({
  listSecurityFindings: jest.fn(),
  getSecurityFindingById: mockGetSecurityFindingById,
  getSecurityFindingsSummary: jest.fn(),
  getLastSyncTime: jest.fn(),
  getOrphanedRepositoriesWithFindingCounts: jest.fn(),
  deleteFindingsByRepository: jest.fn(),
}));
jest.mock('./db/security-remediation', () => ({
  decorateFindingWithRemediation: jest.fn(),
  decorateFindingsWithRemediation: jest.fn(),
  getRemediationAttemptHistory: jest.fn(),
}));
jest.mock('./db/security-commands', () => ({
  getSecurityAgentCommandStatus: mockGetSecurityAgentCommandStatus,
  getSecurityAgentCommandStatuses: jest.fn(),
  listActiveSecurityAgentCommands: jest.fn(),
}));
jest.mock('./db/dashboard-stats', () => ({ getDashboardStats: jest.fn() }));
jest.mock('./db/security-analysis', () => ({
  canStartAnalysis: mockCanStartAnalysis,
  enqueueBacklogFindings: jest.fn(),
}));
jest.mock('./services/auto-dismiss-service', () => ({
  autoDismissEligibleFindings: jest.fn(),
  countEligibleForAutoDismiss: jest.fn(),
}));
jest.mock('@/lib/integrations/db/platform-integrations', () => ({
  updateRepositoriesForIntegration: jest.fn(),
}));
jest.mock('@/lib/integrations/platforms/github/adapter', () => ({
  fetchGitHubRepositories: jest.fn(),
}));

let createSecurityAgentHandlers: typeof createSecurityAgentHandlersType;

beforeAll(async () => {
  ({ createSecurityAgentHandlers } = await import('./router/shared-handlers'));
});

const ORG_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FINDING_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const COMMAND_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

const context = {
  user: {
    id: 'user-123',
    google_user_email: 'owner@example.com',
    google_user_name: 'Owner Example',
    is_admin: false,
  },
} as never;

function createPersonalHandlers() {
  return createSecurityAgentHandlers({
    resolveOwner: () => ({ type: 'user', id: 'user-123', userId: 'user-123' }),
    resolveSecurityOwner: () => ({ userId: 'user-123' }),
    resolveResourceId: () => 'user-123',
    verifyFindingOwnership: () => true,
    getIntegration: async () => ({ integration_status: 'active' }) as never,
    trackingExtras: () => ({}),
  });
}

function createOrgHandlers() {
  return createSecurityAgentHandlers({
    resolveOwner: () => ({ type: 'org', id: ORG_ID, userId: 'user-123' }),
    resolveSecurityOwner: () => ({ organizationId: ORG_ID }),
    resolveResourceId: () => ORG_ID,
    verifyFindingOwnership: () => true,
    getIntegration: async () => ({ integration_status: 'active' }) as never,
    trackingExtras: () => ({}),
  });
}

function ledgerRow(overrides: Partial<OperationLedgerRow> = {}): OperationLedgerRow {
  return {
    id: 'ledger-row-id',
    operation_key: 'analysis-key',
    domain: 'security',
    intent: 'start_analysis',
    kilo_user_id: 'user-123',
    organization_id: ORG_ID,
    resource_key: `security:start_analysis:org:${ORG_ID}:${FINDING_ID}`,
    provider_ref: null,
    taxonomy: 'reconcile-first',
    status: 'admitted',
    outcome_code: null,
    canonical_result: null,
    admitted_at: '2026-06-17T10:00:00.000Z',
    settled_at: null,
    lease_expires_at: '2026-06-17T10:02:00.000Z',
    expires_at: '2026-07-17T10:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRecordOperationAcceptance.mockResolvedValue({ status: 'admitted' });
  mockMarkReconcilePending.mockResolvedValue({ status: 'reconcile_pending' });
  mockSettleOperation.mockResolvedValue({ settled: true });
});

describe('analysis start ledger admission', () => {
  beforeEach(() => {
    mockGetSecurityFindingById.mockResolvedValue({ id: FINDING_ID });
    mockCanStartAnalysis.mockResolvedValue({ allowed: true, currentCount: 0, limit: 3 });
    mockSubmitManualAnalysisStart.mockResolvedValue({ queued: true, commandId: COMMAND_ID });
    mockAdmitOperation.mockResolvedValue({
      admission: 'admitted',
      row: ledgerRow({ resource_key: `security:start_analysis:org:${ORG_ID}:${FINDING_ID}` }),
    });
  });

  it('admits with intent start_analysis and a fresh UUID operation key', async () => {
    await expect(
      createOrgHandlers().startAnalysis.handler({
        ctx: context,
        input: { findingId: FINDING_ID },
      })
    ).resolves.toEqual({ success: true, queued: true, commandId: COMMAND_ID });

    const admitInput = mockAdmitOperation.mock.calls[0]?.[1] as {
      intent: string;
      operationKey: string;
      resourceKey: string;
    };
    expect(admitInput).toMatchObject({
      intent: 'start_analysis',
      resourceKey: `security:start_analysis:org:${ORG_ID}:${FINDING_ID}`,
    });
    expect(admitInput.operationKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    expect(admitInput.operationKey).not.toBe(FINDING_ID);

    // Analysis has no queue run, so the acceptance records only the commandId.
    expect(mockRecordOperationAcceptance.mock.calls[0]?.[1]).toEqual({
      rowId: 'ledger-row-id',
      providerRef: COMMAND_ID,
      canonicalResult: { commandId: COMMAND_ID },
    });
  });
});

describe('analysis web observation settle', () => {
  async function insertAnalysisLedgerRow() {
    const [row] = await db
      .insert(operation_ledgers)
      .values({
        operation_key: `analysis-${randomUUID()}`,
        domain: 'security',
        intent: 'start_analysis',
        kilo_user_id: 'user-123',
        taxonomy: 'reconcile-first',
        status: 'admitted',
        provider_ref: COMMAND_ID,
        admitted_at: '2026-06-17T10:00:00.000Z',
        lease_expires_at: '2026-06-17T10:02:00.000Z',
        expires_at: '2026-07-17T10:00:00.000Z',
      })
      .returning();
    return row!;
  }

  beforeEach(async () => {
    await db.delete(operation_ledgers).where(sql`true`);
    mockGetSecurityAgentCommandStatus.mockResolvedValue({
      id: COMMAND_ID,
      commandType: 'start_analysis',
      origin: 'dashboard_refresh',
      findingId: FINDING_ID,
      repoFullName: null,
      status: 'succeeded',
      resultCode: 'ANALYSIS_COMPLETED',
      resultMetadata: null,
      lastErrorRedacted: null,
      acceptedAt: '2026-06-17T10:00:00.000Z',
      startedAt: '2026-06-17T10:00:01.000Z',
      completedAt: '2026-06-17T10:00:09.000Z',
      updatedAt: '2026-06-17T10:00:09.000Z',
    });
  });

  afterAll(async () => {
    await db.delete(operation_ledgers).where(sql`true`);
  });

  it('settles an admitted start_analysis row with the start_analysis intent', async () => {
    await insertAnalysisLedgerRow();

    await expect(
      createOrgHandlers().getCommandStatus.handler({
        ctx: context,
        input: { commandId: COMMAND_ID },
      })
    ).resolves.toMatchObject({ id: COMMAND_ID, status: 'succeeded' });

    expect(mockSettleOperation).toHaveBeenCalledTimes(1);
    const settleInput = mockSettleOperation.mock.calls[0]?.[1] as {
      status: string;
      outboxEvent: { eventName: string; properties: Record<string, unknown> };
    };
    expect(settleInput.status).toBe('completed');
    expect(settleInput.outboxEvent.eventName).toBe('security_command_settled');
    expect(settleInput.outboxEvent.properties).toMatchObject({
      intent: 'start_analysis',
      outcome: 'completed',
    });
  });

  it('emits only the contract keys for the security_command_settled payload', async () => {
    await insertAnalysisLedgerRow();
    await createOrgHandlers().getCommandStatus.handler({
      ctx: context,
      input: { commandId: COMMAND_ID },
    });

    const settleInput = mockSettleOperation.mock.calls[0]?.[1] as {
      outboxEvent: { properties: Record<string, unknown> };
    };
    expect(Object.keys(settleInput.outboxEvent.properties).sort()).toEqual([
      'duration_ms',
      'intent',
      'outcome',
      'phase',
      'source',
      'surface',
    ]);
  });

  it('skips without throwing when no ledger row exists for the command', async () => {
    await expect(
      createOrgHandlers().getCommandStatus.handler({
        ctx: context,
        input: { commandId: COMMAND_ID },
      })
    ).resolves.toMatchObject({ id: COMMAND_ID });

    expect(mockSettleOperation).not.toHaveBeenCalled();
  });
});

describe('remediation manual submit', () => {
  const ATTEMPT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const REMEDIATION_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

  beforeEach(() => {
    mockGetSecurityFindingById.mockResolvedValue({ id: FINDING_ID });
    mockSubmitManualRemediationStart.mockResolvedValue({
      queued: true,
      remediationId: REMEDIATION_ID,
      attemptId: ATTEMPT_ID,
      attemptNumber: 1,
    });
  });

  // The Worker admits the `apply_auto_remediation` ledger row before the queue
  // hand-off (see `startManualRemediation`), so the web handler must not admit
  // it a second time: a web admit racing the Worker's terminal settle would
  // leave the row admitted forever.
  it('returns the queued attempt without admitting a ledger row', async () => {
    await expect(
      createPersonalHandlers().startRemediation.handler({
        ctx: context,
        input: { findingId: FINDING_ID },
      })
    ).resolves.toEqual({
      success: true,
      queued: true,
      remediationId: REMEDIATION_ID,
      attemptId: ATTEMPT_ID,
      attemptNumber: 1,
    });

    expect(mockAdmitOperation).not.toHaveBeenCalled();
    expect(mockRecordOperationAcceptance).not.toHaveBeenCalled();
  });

  it('does not admit a ledger row on retry either', async () => {
    await expect(
      createPersonalHandlers().retryRemediation.handler({
        ctx: context,
        input: { findingId: FINDING_ID },
      })
    ).resolves.toMatchObject({ success: true, attemptId: ATTEMPT_ID });

    expect(mockAdmitOperation).not.toHaveBeenCalled();
  });
});
