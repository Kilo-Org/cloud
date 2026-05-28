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
  it('sends only persisted observed run facts without state content', async () => {
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
        },
      },
    ]);
    expect(JSON.stringify(reports)).not.toContain('never report');
    expect(JSON.stringify(reports)).not.toContain('model/test');
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
