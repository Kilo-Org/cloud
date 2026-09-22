import { describe, expect, it } from 'vitest';
import { heartbeatReasonFrom } from './sandbox-control-protocol.js';
import {
  classifyRetirementCause,
  controlLogBatchSchema,
  createControlDiagnosticRecord,
  diagnosticDetail,
} from './control-diagnostics.js';

describe('control diagnostic schema compatibility', () => {
  it('accepts records written before publication diagnostics were extended', () => {
    expect(
      controlLogBatchSchema.parse({
        version: 1,
        sequence: 7,
        droppedRecords: 0,
        records: [
          {
            timestamp: 1,
            event: 'control.event',
            fields: { phase: 'sent', category: 'session_event', sequence: 1 },
          },
        ],
      }).records
    ).toHaveLength(1);
  });

  it('preserves publication correlation fields through the accepted batch schema', () => {
    const record = createControlDiagnosticRecord(
      'control.event',
      {
        phase: 'publication_failed',
        category: 'session_event',
        wrapperInstanceId: '11111111-1111-4111-8111-111111111111',
        nativeRuntimeId: '22222222-2222-4222-8222-222222222222',
        rootKiloSessionId: 'ses_root',
        receiptId: '33333333-3333-4333-8333-333333333333',
        requestId: '44444444-4444-4444-8444-444444444444',
        sequence: 4,
        eventType: 'message.part.updated',
        failureReason: 'socket_overflow',
        pendingCount: 2,
        pendingBytes: 512,
        socketBufferedBytes: 1024,
      },
      1
    );
    const [accepted] = controlLogBatchSchema.parse({
      version: 1,
      sequence: 1,
      droppedRecords: 0,
      records: [record],
    }).records;
    expect(accepted?.fields).toMatchObject({
      wrapperInstanceId: '11111111-1111-4111-8111-111111111111',
      nativeRuntimeId: '22222222-2222-4222-8222-222222222222',
      rootKiloSessionId: 'ses_root',
      receiptId: '33333333-3333-4333-8333-333333333333',
      requestId: '44444444-4444-4444-8444-444444444444',
      eventType: 'message.part.updated',
      failureReason: 'socket_overflow',
      pendingCount: 2,
      pendingBytes: 512,
      socketBufferedBytes: 1024,
    });
  });
});

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
