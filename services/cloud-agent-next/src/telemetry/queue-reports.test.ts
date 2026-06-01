import { describe, expect, it, vi } from 'vitest';
import type { CloudAgentQueueReport } from '@kilocode/worker-utils/cloud-agent-queue-report';
import { emitRunStateReport } from './queue-reports.js';
import type { SessionMessageState } from '../session/session-message-state.js';

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

  it('emits a safe disk-full diagnostic for a workspace setup failure', async () => {
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
        error: 'Git clone failed: No space left on device while checking out secret-repository',
      },
    });

    expect(reports[0]?.run.diagnostic).toEqual({
      errorMessageRedacted: 'Workspace setup failed: sandbox storage full',
      errorExpiresAt: new Date(5 + 30 * 24 * 60 * 60 * 1000).toISOString(),
    });
    expect(JSON.stringify(reports)).not.toContain('secret-repository');
    expect(JSON.stringify(reports)).not.toContain('No space left on device');
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
