import { describe, expect, it } from 'vitest';
import {
  CloudAgentQueueReportSchema,
  CloudAgentRunFailureClassifications,
  CloudAgentRunStatuses,
} from './cloud-agent-queue-report.js';

const occurredAt = '2026-05-26T08:00:00.000Z';
const terminalAt = '2026-05-26T08:04:00.000Z';
const session = { cloudAgentSessionId: 'agent_reporting_session' };

function reportWithRun(run: Record<string, unknown>) {
  return {
    version: 1,
    type: 'run.state',
    occurredAt,
    session,
    run: { messageId: 'msg_reporting_run', queuedAt: '2026-05-26T08:01:00.000Z', ...run },
  };
}

describe('CloudAgentQueueReportSchema', () => {
  it('accepts observed milestone and reduced diagnostic fields on failed runs', () => {
    expect(
      CloudAgentQueueReportSchema.safeParse(
        reportWithRun({
          status: 'failed',
          wrapperRunId: 'wr_018f1e2d3c4bReportRunAbCdEF',
          dispatchAcceptedAt: '2026-05-26T08:02:00.000Z',
          agentActivityObservedAt: '2026-05-26T08:03:00.000Z',
          terminalAt,
          failureStage: 'agent_activity',
          failureCode: 'assistant_error',
          diagnostic: {
            errorMessageRedacted: 'Wrapper stopped unexpectedly',
            errorExpiresAt: '2026-06-25T08:04:00.000Z',
          },
        })
      ).success
    ).toBe(true);
  });

  it('supports retained statuses and typed failure classifications', () => {
    const reportsByStatus = {
      queued: reportWithRun({ status: 'queued' }),
      accepted: reportWithRun({
        status: 'accepted',
        dispatchAcceptedAt: '2026-05-26T08:02:00.000Z',
      }),
      completed: reportWithRun({ status: 'completed', terminalAt }),
      failed: reportWithRun({
        status: 'failed',
        terminalAt,
        failureStage: 'unknown',
        failureCode: 'unclassified',
      }),
      interrupted: reportWithRun({
        status: 'interrupted',
        terminalAt,
        failureStage: 'interruption',
        failureCode: 'user_interrupt',
      }),
    };
    for (const status of CloudAgentRunStatuses) {
      expect(CloudAgentQueueReportSchema.safeParse(reportsByStatus[status]).success).toBe(true);
    }
    for (const classification of CloudAgentRunFailureClassifications) {
      expect(
        CloudAgentQueueReportSchema.safeParse(
          reportWithRun({
            status: classification.failureStage === 'interruption' ? 'interrupted' : 'failed',
            terminalAt,
            ...classification,
          })
        ).success
      ).toBe(true);
    }
  });

  it('rejects removed lifecycle fields and unsafe transport content', () => {
    const removedOrUnsafeFields = [
      ['isInitialMessage', true],
      ['mode', 'code'],
      ['model', 'model/private'],
      ['dispatchAcceptanceKind', 'observed'],
      ['completionSource', 'wrapper_failure'],
      ['deliveryAttempts', 1],
      ['callbackRequired', true],
      ['prompt', 'summarize private code'],
      ['repository', 'private/repository'],
      ['stderr', 'private output'],
    ] as const;
    for (const [key, value] of removedOrUnsafeFields) {
      expect(
        CloudAgentQueueReportSchema.safeParse(reportWithRun({ status: 'queued', [key]: value }))
          .success
      ).toBe(false);
    }
    expect(
      CloudAgentQueueReportSchema.safeParse({
        version: 1,
        type: 'session.runtime',
        occurredAt,
        session: { cloudAgentSessionId: 'agent_reporting_session' },
      }).success
    ).toBe(false);
  });

  it('requires coherent terminal, dispatch, failure, and diagnostic facts', () => {
    const diagnostic = {
      errorMessageRedacted: 'm'.repeat(4096),
      errorExpiresAt: '2026-06-25T08:04:00.000Z',
    };
    expect(
      CloudAgentQueueReportSchema.safeParse(
        reportWithRun({
          status: 'failed',
          terminalAt,
          failureStage: 'pre_dispatch',
          failureCode: 'workspace_setup_failed',
          diagnostic,
        })
      ).success
    ).toBe(true);
    expect(
      CloudAgentQueueReportSchema.safeParse(reportWithRun({ status: 'accepted' })).success
    ).toBe(false);
    expect(
      CloudAgentQueueReportSchema.safeParse(
        reportWithRun({ status: 'queued', dispatchAcceptedAt: occurredAt })
      ).success
    ).toBe(false);
    expect(
      CloudAgentQueueReportSchema.safeParse(
        reportWithRun({
          status: 'failed',
          terminalAt,
          failureStage: 'pre_dispatch',
          failureCode: 'workspace_setup_failed',
          diagnostic: { ...diagnostic, errorMessageRedacted: 'm'.repeat(4097) },
        })
      ).success
    ).toBe(false);
    expect(
      CloudAgentQueueReportSchema.safeParse(
        reportWithRun({ status: 'completed', terminalAt, diagnostic })
      ).success
    ).toBe(false);
  });

  it('requires strict ISO timestamps at the queue boundary', () => {
    expect(
      CloudAgentQueueReportSchema.safeParse(
        reportWithRun({ status: 'completed', terminalAt: '2026/05/26 08:04:00' })
      ).success
    ).toBe(false);
  });
});
