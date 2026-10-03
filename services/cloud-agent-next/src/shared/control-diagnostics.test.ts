import { describe, expect, it } from 'vitest';
import { heartbeatReasonFrom } from './sandbox-control-protocol.js';
import {
  classifyRetirementCause,
  controlLogBatchSchema,
  createControlDiagnosticRecord,
  diagnosticDetail,
} from './control-diagnostics.js';

describe('control diagnostic schema compatibility', () => {
  it('retains no-progress tool and workload counters without accepting tool content', () => {
    const deadline = createControlDiagnosticRecord(
      'session.execution',
      {
        phase: 'deadline_expired',
        reason: 'no_progress',
        rootKiloSessionId: 'ses_root',
        kiloSessionId: 'ses_child',
        eventType: 'message.part.updated',
        partId: 'part_1',
        toolStatus: 'running',
        toolObservedAt: 10,
        outputBytes: 0,
        command: 'secret',
      },
      20
    );
    const workload = createControlDiagnosticRecord(
      'control.workload',
      {
        phase: 'completed',
        workloadPhase: 'stats',
        scopeId: 'scope_1',
        memoryMaxEvents: 4,
        cpuUsageUsec: 900,
        cpuThrottledUsec: 75,
        ioReadBytes: 130,
        toolCpuUsageUsec: 800,
        serverCpuUsageUsec: 100,
        toolIoReadBytes: 120,
      },
      21
    );
    const records = controlLogBatchSchema.parse({
      version: 1,
      sequence: 1,
      droppedRecords: 0,
      records: [deadline, workload],
    }).records;
    expect(records[0]?.fields).toMatchObject({ partId: 'part_1', toolStatus: 'running' });
    expect(records[1]?.fields).toMatchObject({
      cpuUsageUsec: 900,
      memoryMaxEvents: 4,
      toolCpuUsageUsec: 800,
      serverCpuUsageUsec: 100,
      toolIoReadBytes: 120,
    });
    expect(JSON.stringify(records)).not.toContain('secret');
  });

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
  it('preserves terminal control socket decision fields through the accepted batch schema', () => {
    const record = createControlDiagnosticRecord(
      'control.socket',
      {
        phase: 'reconnect_exhausted',
        attempt: 7,
        elapsedMs: 90_000,
        deadlineAt: 1_700_000_090_000,
        reason: 'reconnect_budget_exhausted',
        wrapperInstanceId: '11111111-1111-4111-8111-111111111111',
        connectionId: 'connection_1',
      },
      1
    );
    expect(record).toBeDefined();
    expect(record?.fields).toMatchObject({
      phase: 'reconnect_exhausted',
      attempt: 7,
      elapsedMs: 90_000,
      deadlineAt: 1_700_000_090_000,
      reason: 'reconnect_budget_exhausted',
      wrapperInstanceId: '11111111-1111-4111-8111-111111111111',
      connectionId: 'connection_1',
    });
    expect(
      controlLogBatchSchema.safeParse({
        version: 1,
        sequence: 1,
        droppedRecords: 0,
        records: [record],
      }).success
    ).toBe(true);
  });

  it('drops free-text prompts and unknown secret fields from a diagnostic record', () => {
    const prompt = 'Summarize the private customer contract';
    const record = createControlDiagnosticRecord(
      'control.socket',
      {
        phase: 'hello_rejected',
        reason: 'permanent_hello_rejection',
        prompt,
        authorization: 'Bearer super-secret-token',
      },
      1
    );
    expect(record?.fields).not.toHaveProperty('prompt');
    expect(record?.fields).not.toHaveProperty('authorization');
    expect(JSON.stringify(record)).not.toContain(prompt);
    expect(JSON.stringify(record)).not.toContain('super-secret-token');
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
