import { describe, expect, it, vi } from 'vitest';
import {
  buildScheduledJobFailureEvent,
  buildScheduledJobSuccessEvent,
  createScheduledJobRun,
  createScheduledJobRunContext,
  emitScheduledJobEvent,
  type ScheduledJobLogger,
} from './scheduled-job-observability.js';

describe('scheduled job observability', () => {
  it('builds a successful terminal event with deterministic duration and scalar metadata', () => {
    const event = buildScheduledJobSuccessEvent({
      context: createScheduledJobRunContext({ runId: 'run-123', startedAt: 1_000 }),
      jobName: 'web.cleanup_api_request_log',
      environment: 'production',
      metadata: {
        deleted_count: 0,
        has_more: false,
        ignored: undefined,
      },
      now: 1_421,
    });

    expect(event).toEqual({
      event_name: 'scheduled_job.completed',
      event_version: 1,
      job_name: 'web.cleanup_api_request_log',
      run_id: 'run-123',
      outcome: 'succeeded',
      duration_ms: 421,
      environment: 'production',
      deleted_count: 0,
      has_more: false,
    });
  });

  it('uses a supplied run ID and generates a UUID when one is not supplied', () => {
    expect(createScheduledJobRunContext({ runId: 'security-sync-run', startedAt: 100 })).toEqual({
      runId: 'security-sync-run',
      startedAt: 100,
    });

    expect(createScheduledJobRunContext({ startedAt: 100 }).runId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  it('builds events from a scheduled boundary run', () => {
    const run = createScheduledJobRun({
      jobName: 'web.cleanup_device_auth',
      environment: 'production',
      runId: 'boundary-run',
      startedAt: 100,
    });

    expect(buildScheduledJobSuccessEvent(run, { deleted_count: 0, has_more: false })).toMatchObject(
      {
        job_name: 'web.cleanup_device_auth',
        run_id: 'boundary-run',
        environment: 'production',
        deleted_count: 0,
        has_more: false,
      }
    );
    expect(buildScheduledJobFailureEvent(run, new Error('raw exception content'))).toMatchObject({
      job_name: 'web.cleanup_device_auth',
      run_id: 'boundary-run',
      exception_name: 'Error',
    });
  });

  it('sanitizes bounded exception names without including raw exception content', () => {
    const error = new Error('database password: secret-value');
    error.name = 'Database Error: secret-value';

    expect(
      buildScheduledJobFailureEvent({
        context: { runId: 'run-456', startedAt: 100 },
        jobName: 'security_sync.dispatch',
        error,
        now: 303,
      })
    ).toEqual({
      event_name: 'scheduled_job.completed',
      event_version: 1,
      job_name: 'security_sync.dispatch',
      run_id: 'run-456',
      outcome: 'failed',
      duration_ms: 203,
      exception_name: 'Error',
    });
  });

  it('emits one JSON object at info or error severity without exception messages', () => {
    const info = vi.fn();
    const error = vi.fn();
    const logger: ScheduledJobLogger = {
      info,
      error,
    };
    const success = buildScheduledJobSuccessEvent({
      context: { runId: 'success-run', startedAt: 0 },
      jobName: 'web.sync_model_stats',
      now: 1,
    });
    const failure = buildScheduledJobFailureEvent({
      context: { runId: 'failure-run', startedAt: 0 },
      jobName: 'web.sync_model_stats',
      error: new Error('raw exception content'),
      now: 1,
    });

    emitScheduledJobEvent(success, logger);
    emitScheduledJobEvent(failure, logger);

    expect(info).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledOnce();
    expect(JSON.parse(info.mock.calls[0][0])).toEqual(success);
    expect(JSON.parse(error.mock.calls[0][0])).toEqual(failure);
    expect(error.mock.calls[0][0]).not.toContain('raw exception content');
  });

  it('swallows logger failures', () => {
    const logger: ScheduledJobLogger = {
      info: () => {
        throw new Error('logging unavailable');
      },
      error: vi.fn(),
    };

    expect(() =>
      emitScheduledJobEvent(
        buildScheduledJobSuccessEvent({
          context: { runId: 'run-789', startedAt: 0 },
          jobName: 'web.cleanup_device_auth',
          now: 1,
        }),
        logger
      )
    ).not.toThrow();
  });
});
