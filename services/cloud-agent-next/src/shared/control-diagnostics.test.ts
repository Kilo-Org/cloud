import { describe, expect, it } from 'vitest';
import { heartbeatReasonFrom } from './sandbox-control-protocol.js';
import {
  classifyRetirementCause,
  createControlDiagnosticRecord,
  diagnosticDetail,
} from './control-diagnostics.js';

describe('classifyRetirementCause', () => {
  it('maps feed machine reasons that previously became unknown', () => {
    expect(classifyRetirementCause('feed_failed')).toBe('event_feed_unhealthy');
    expect(classifyRetirementCause('feed_stale')).toBe('event_feed_unhealthy');
    expect(classifyRetirementCause('feed_ended')).toBe('event_feed_unhealthy');
  });

  it('keeps process exit distinct from unknown', () => {
    expect(classifyRetirementCause('process_exited')).toBe('process_exited');
  });

  it('classifies session event delivery failures', () => {
    expect(classifyRetirementCause('Session event delivery failed')).toBe(
      'outcome_delivery_failed'
    );
    expect(classifyRetirementCause('Session event delivery unconfirmed')).toBe(
      'outcome_delivery_failed'
    );
  });

  it('falls back through later reasons', () => {
    expect(classifyRetirementCause('mystery', 'control_disconnected')).toBe('control_disconnected');
    expect(classifyRetirementCause('mystery')).toBe('unknown');
  });
});

describe('heartbeatReasonFrom', () => {
  it('passes feed and process codes through to the worker heartbeat', () => {
    expect(heartbeatReasonFrom('feed_failed')).toBe('feed_failed');
    expect(heartbeatReasonFrom('process_exited')).toBe('process_exited');
  });

  it('does not invent a machine code for human shutdown strings', () => {
    expect(heartbeatReasonFrom('Wrapper received SIGTERM')).toBe('shutdown');
  });
});

describe('diagnosticDetail', () => {
  it('keeps a bounded reason on lifecycle records', () => {
    expect(diagnosticDetail('feed_failed')).toBe('feed_failed');
    expect(diagnosticDetail(` ${'x'.repeat(200)} `)?.length).toBe(128);
    const record = createControlDiagnosticRecord(
      'wrapper.lifecycle',
      {
        phase: 'stopping',
        exitCode: 1,
        retirementCause: 'event_feed_unhealthy',
        detail: 'feed_failed',
      },
      1
    );
    expect(record?.fields).toMatchObject({
      phase: 'stopping',
      retirementCause: 'event_feed_unhealthy',
      detail: 'feed_failed',
    });
  });
});
