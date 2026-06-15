import { describe, expect, it, vi } from 'vitest';
import type { CloudAgentQueueReport } from '@kilocode/worker-utils/cloud-agent-queue-report';
import { emitRunStateReport } from './queue-reports.js';
import type { SessionMessageState } from '../session/session-message-state.js';
import type { WorkspaceFailureSubtype } from '../shared/wrapper-bootstrap.js';

const WORKSPACE_FAILURE_DIAGNOSTICS = [
  ['git_clone_timeout', 'Repository clone timed out'],
  ['git_checkout_timeout', 'Repository checkout timed out'],
  ['git_authentication_failed', 'Repository authentication failed'],
  ['git_network_failed', 'Repository network request failed'],
  ['git_pack_corrupt', 'Repository data is corrupt'],
  ['git_checkout_conflict', 'Repository checkout conflict'],
  ['git_branch_missing', 'Requested repository branch was not found'],
  ['sandbox_storage_full', 'Workspace setup failed: sandbox storage full'],
  ['kilo_import_timeout', 'Session import timed out'],
  ['kilo_import_failed', 'Session import failed'],
  ['setup_command_timeout', 'Setup command timed out'],
  ['setup_command_failed', 'Setup command failed'],
  ['workspace_setup_unknown', 'Workspace setup failed'],
] satisfies ReadonlyArray<readonly [WorkspaceFailureSubtype, string]>;

const state: SessionMessageState = {
  messageId: 'msg_018f1e2d3c4bReportMsgAbCdEF',
  status: 'failed',
  prompt: 'never report this prompt',
  createdAt: 1,
  queuedAt: 2,
  acceptedAt: 3,
  dispatchAcceptanceKind: 'observed',
  agentActivityObservedAt: 4,
  terminalAt: 5,
  wrapperRunId: 'wr_report_state',
  completionSource: 'wrapper_failure',
  failureStage: 'agent_activity',
  failureCode: 'wrapper_error_after_activity',
  error: 'never report this error',
  attempts: 2,
  callbackRequired: false,
  admissionSnapshot: {
    turn: { type: 'prompt', messageId: 'msg_018f1e2d3c4bReportMsgAbCdEF', prompt: 'secret' },
    agent: { mode: 'code', model: 'model/test' },
  },
};

describe('Cloud Agent report emitter', () => {
  it('sends safe persisted observed run facts without raw state content', async () => {
    const reports: CloudAgentQueueReport[] = [];
    await emitRunStateReport({
      queue: { send: async report => void reports.push(report) },
      cloudAgentSessionId: 'agent_report',
      state,
      occurredAt: 6,
    });

    expect(reports).toEqual([
      {
        version: 1,
        type: 'run.state',
        occurredAt: new Date(6).toISOString(),
        session: { cloudAgentSessionId: 'agent_report' },
        run: {
          messageId: state.messageId,
          status: 'failed',
          wrapperRunId: 'wr_report_state',
          queuedAt: new Date(2).toISOString(),
          dispatchAcceptedAt: new Date(3).toISOString(),
          agentActivityObservedAt: new Date(4).toISOString(),
          terminalAt: new Date(5).toISOString(),
          failureStage: 'agent_activity',
          failureCode: 'wrapper_error_after_activity',
          diagnostic: {
            errorMessageRedacted: 'Wrapper failed after agent activity',
            errorExpiresAt: new Date(5 + 30 * 24 * 60 * 60 * 1000).toISOString(),
          },
        },
      },
    ]);
    expect(JSON.stringify(reports)).not.toContain('never report');
    expect(JSON.stringify(reports)).not.toContain('model/test');
  });

  it.each([
    ['agent_activity', 'payment_required', 'assistant_error'],
    ['agent_activity', 'model_missing', 'assistant_error'],
    ['post_dispatch_no_activity', 'payment_required', 'wrapper_error_before_activity'],
    ['post_dispatch_no_activity', 'model_missing', 'wrapper_error_before_activity'],
  ] as const)(
    'maps %s/%s to persisted failure code %s',
    async (failureStage, failureCode, expectedFailureCode) => {
      const reports: CloudAgentQueueReport[] = [];
      await emitRunStateReport({
        queue: { send: async report => void reports.push(report) },
        cloudAgentSessionId: 'agent_report',
        state: { ...state, failureStage, failureCode },
      });

      expect(reports[0]?.run).toMatchObject({
        failureStage,
        failureCode: expectedFailureCode,
      });
    }
  );

  it.each(WORKSPACE_FAILURE_DIAGNOSTICS)(
    'emits the allowlisted diagnostic for workspace subtype %s',
    async (failureSubtype, expectedDiagnostic) => {
      const reports: CloudAgentQueueReport[] = [];
      await emitRunStateReport({
        queue: { send: async report => void reports.push(report) },
        cloudAgentSessionId: 'agent_report',
        state: {
          ...state,
          acceptedAt: undefined,
          dispatchAcceptanceKind: undefined,
          agentActivityObservedAt: undefined,
          wrapperRunId: undefined,
          failureStage: 'pre_dispatch',
          failureCode: 'workspace_setup_failed',
          failureSubtype,
          error: 'raw error with credential password=hunter2 and process output',
          safeFailureMessage: 'bounded but secret-bearing token=super-secret',
        },
      });

      expect(reports[0]?.run.diagnostic).toEqual({
        errorMessageRedacted: expectedDiagnostic,
        errorExpiresAt: new Date(5 + 30 * 24 * 60 * 60 * 1000).toISOString(),
      });
      expect(JSON.stringify(reports)).not.toContain('hunter2');
      expect(JSON.stringify(reports)).not.toContain('super-secret');
      expect(JSON.stringify(reports)).not.toContain('process output');
    }
  );

  it.each([
    ['absent', undefined],
    ['unknown', 'future_workspace_subtype'],
  ])('falls back for an %s workspace subtype', async (_name, failureSubtype) => {
    const reports: CloudAgentQueueReport[] = [];
    await emitRunStateReport({
      queue: { send: async report => void reports.push(report) },
      cloudAgentSessionId: 'agent_report',
      state: {
        ...state,
        failureStage: 'pre_dispatch',
        failureCode: 'workspace_setup_failed',
        failureSubtype: failureSubtype as WorkspaceFailureSubtype | undefined,
        error: 'credential=raw-secret',
        safeFailureMessage: 'provider body with token=safe-message-secret',
      },
    });

    expect(reports[0]?.run.diagnostic?.errorMessageRedacted).toBe('Workspace setup failed');
    expect(JSON.stringify(reports)).not.toContain('raw-secret');
    expect(JSON.stringify(reports)).not.toContain('safe-message-secret');
  });

  it('classifies storage-full from subtype independently of raw error text', async () => {
    const reports: CloudAgentQueueReport[] = [];
    await emitRunStateReport({
      queue: { send: async report => void reports.push(report) },
      cloudAgentSessionId: 'agent_report',
      state: {
        ...state,
        failureStage: 'pre_dispatch',
        failureCode: 'workspace_setup_failed',
        failureSubtype: 'sandbox_storage_full',
        error: 'unrelated secret-bearing failure text',
      },
    });

    expect(reports[0]?.run.diagnostic?.errorMessageRedacted).toBe(
      'Workspace setup failed: sandbox storage full'
    );
    expect(JSON.stringify(reports)).not.toContain('unrelated secret-bearing failure text');
  });

  it('emits a safe insufficient-credit diagnostic for the wrapper terminal text', async () => {
    const reports: CloudAgentQueueReport[] = [];
    await emitRunStateReport({
      queue: { send: async report => void reports.push(report) },
      cloudAgentSessionId: 'agent_report',
      state: { ...state, error: 'Insufficient credits' },
    });

    expect(reports[0]?.run.diagnostic).toEqual({
      errorMessageRedacted: 'Model request failed: insufficient credits',
      errorExpiresAt: new Date(5 + 30 * 24 * 60 * 60 * 1000).toISOString(),
    });
    expect(JSON.stringify(reports)).not.toContain('Insufficient credits');
  });

  it.each(['Payment Required', 'pAyMeNt ReQuIrEd'])(
    'emits an insufficient-credit diagnostic before activity for known terminal text %s',
    async error => {
      const reports: CloudAgentQueueReport[] = [];
      await emitRunStateReport({
        queue: { send: async report => void reports.push(report) },
        cloudAgentSessionId: 'agent_report',
        state: {
          ...state,
          agentActivityObservedAt: undefined,
          failureStage: 'post_dispatch_no_activity',
          failureCode: 'wrapper_error_before_activity',
          error,
        },
      });

      expect(reports[0]?.run.diagnostic?.errorMessageRedacted).toBe(
        'Model request failed: insufficient credits'
      );
      expect(JSON.stringify(reports)).not.toContain(error);
    }
  );

  it('emits an insufficient-credit diagnostic for a recognized assistant failure', async () => {
    const reports: CloudAgentQueueReport[] = [];
    await emitRunStateReport({
      queue: { send: async report => void reports.push(report) },
      cloudAgentSessionId: 'agent_report',
      state: { ...state, failureCode: 'assistant_error', error: 'usage_limit_exceeded' },
    });

    expect(reports[0]?.run.diagnostic?.errorMessageRedacted).toBe(
      'Model request failed: insufficient credits'
    );
    expect(JSON.stringify(reports)).not.toContain('usage_limit_exceeded');
  });

  it('uses a phase-neutral diagnostic for unknown delivery outcomes', async () => {
    const reports: CloudAgentQueueReport[] = [];
    await emitRunStateReport({
      queue: { send: async report => void reports.push(report) },
      cloudAgentSessionId: 'agent_report',
      state: {
        ...state,
        acceptedAt: undefined,
        dispatchAcceptanceKind: undefined,
        agentActivityObservedAt: undefined,
        wrapperRunId: undefined,
        failureStage: 'pre_dispatch',
        failureCode: 'delivery_failure_unknown',
        error: 'Failed to execute wrapper bootstrap: dispatch outcome is secret and unknown',
      },
    });

    expect(reports[0]?.run.diagnostic?.errorMessageRedacted).toBe(
      'Message delivery outcome is unknown'
    );
    expect(JSON.stringify(reports)).not.toContain('dispatch outcome is secret');
    expect(JSON.stringify(reports)).not.toContain('before dispatch');
  });

  it('does not infer insufficient credits from arbitrary payment-like error content', async () => {
    const reports: CloudAgentQueueReport[] = [];
    await emitRunStateReport({
      queue: { send: async report => void reports.push(report) },
      cloudAgentSessionId: 'agent_report',
      state: { ...state, error: 'Low Credit Warning: balance=private-balance-value' },
    });

    expect(reports[0]?.run.diagnostic?.errorMessageRedacted).toBe(
      'Wrapper failed after agent activity'
    );
    expect(JSON.stringify(reports)).not.toContain('private-balance-value');
  });

  it('does not emit diagnostics for completed reports', async () => {
    const reports: CloudAgentQueueReport[] = [];
    await emitRunStateReport({
      queue: { send: async report => void reports.push(report) },
      cloudAgentSessionId: 'agent_report',
      state: {
        ...state,
        status: 'completed',
        completionSource: 'assistant_message_event',
        failureStage: undefined,
        failureCode: undefined,
        error: 'Insufficient credits',
      },
    });

    expect(reports[0]?.run).not.toHaveProperty('diagnostic');
  });

  it('omits dispatch timestamps that were inferred internally', async () => {
    const reports: CloudAgentQueueReport[] = [];
    await emitRunStateReport({
      queue: { send: async report => void reports.push(report) },
      cloudAgentSessionId: 'agent_report',
      state: {
        ...state,
        agentActivityObservedAt: undefined,
        dispatchAcceptanceKind: 'inferred_from_terminal',
      },
    });
    expect(reports[0]?.run).not.toHaveProperty('dispatchAcceptedAt');
  });

  it('does not enqueue an invalid report or reject when validation fails', async () => {
    const send = vi.fn();
    await expect(
      emitRunStateReport({
        queue: { send },
        cloudAgentSessionId: 'agent_report',
        state: { ...state, status: 'failed', terminalAt: undefined },
      })
    ).resolves.toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });

  it('remains pending until report delivery finishes', async () => {
    let releaseDelivery: (() => void) | undefined;
    const delivery = emitRunStateReport({
      queue: {
        send: () =>
          new Promise<void>(resolve => {
            releaseDelivery = resolve;
          }),
      },
      cloudAgentSessionId: 'agent_report',
      state,
    });
    let settled = false;
    void Promise.resolve(delivery).then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    expect(releaseDelivery).toBeTypeOf('function');

    releaseDelivery?.();
    await Promise.resolve(delivery);
    expect(settled).toBe(true);
  });

  it('does not reject the caller when queue delivery rejects', async () => {
    await expect(
      emitRunStateReport({
        queue: { send: async () => Promise.reject(new Error('queue unavailable')) },
        cloudAgentSessionId: 'agent_report',
        state,
      })
    ).resolves.toBeUndefined();
  });
});
