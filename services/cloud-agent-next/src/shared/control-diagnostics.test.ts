import { describe, expect, it } from 'vitest';
import { heartbeatReasonFrom } from './sandbox-control-protocol.js';
import {
  classifyRetirementCause,
  controlLogBatchSchema,
  controlUploadFailureStartsEpisode,
  createControlDiagnosticProjector,
  createControlDiagnosticRecord,
  diagnosticDetail,
  isProjectableControlDiagnostic,
  nativeConnectionPhases,
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
        toolOomKills: 3,
        serverOomKills: 0,
        toolCurrentBytes: 9_000,
        toolFileBytes: 3_500,
        toolShmemBytes: 1_200,
        serverCurrentBytes: 2_000,
        serverAnonBytes: 1_700,
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
      toolOomKills: 3,
      serverOomKills: 0,
      toolCurrentBytes: 9_000,
      toolFileBytes: 3_500,
      toolShmemBytes: 1_200,
      serverCurrentBytes: 2_000,
      serverAnonBytes: 1_700,
    });
    expect(JSON.stringify(records)).not.toContain('secret');
  });

  it('keeps memory protection and hold records whole and projects them to native logs', () => {
    const records = [
      createControlDiagnosticRecord(
        'control.workload',
        {
          phase: 'failed',
          workloadPhase: 'protection',
          workloadFailure: 'write_failed',
          scopeId: 'scope_1',
        },
        1
      ),
      createControlDiagnosticRecord(
        'control.workload',
        { phase: 'completed', workloadPhase: 'protection', serverMinBytes: 1_073_741_824 },
        2
      ),
      createControlDiagnosticRecord(
        'wrapper.lifecycle',
        {
          phase: 'kilo_memory_hold_started',
          currentBytes: 11_810_496_512,
          aggregateMaxBytes: 11_811_160_064,
          memoryMaxEvents: 42,
        },
        3
      ),
      createControlDiagnosticRecord(
        'wrapper.lifecycle',
        {
          phase: 'kilo_memory_hold_ended',
          memoryHoldOutcome: 'expired',
          elapsedMs: 600_000,
          currentBytes: 11_810_496_512,
          aggregateMaxBytes: 11_811_160_064,
          memoryMaxEvents: 90,
        },
        4
      ),
    ];
    expect(records.map(record => record?.fields)).toEqual([
      {
        phase: 'failed',
        workloadPhase: 'protection',
        workloadFailure: 'write_failed',
        scopeId: 'scope_1',
      },
      { phase: 'completed', workloadPhase: 'protection', serverMinBytes: 1_073_741_824 },
      {
        phase: 'kilo_memory_hold_started',
        currentBytes: 11_810_496_512,
        aggregateMaxBytes: 11_811_160_064,
        memoryMaxEvents: 42,
      },
      {
        phase: 'kilo_memory_hold_ended',
        memoryHoldOutcome: 'expired',
        elapsedMs: 600_000,
        currentBytes: 11_810_496_512,
        aggregateMaxBytes: 11_811_160_064,
        memoryMaxEvents: 90,
      },
    ]);
    expect(
      records.map(record => isProjectableControlDiagnostic(record!.event, record!.fields))
    ).toEqual([true, false, true, true]);
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

  it('accepts every shared native connection phase and rejects an unknown one', () => {
    for (const phase of nativeConnectionPhases) {
      expect(
        createControlDiagnosticRecord(
          'wrapper.status',
          { phase: 'status', nativeConnectionPhase: phase },
          1
        )
      ).toBeDefined();
    }
    expect(
      createControlDiagnosticRecord(
        'wrapper.status',
        { phase: 'status', nativeConnectionPhase: 'nonsense' },
        1
      )
    ).toBeUndefined();
  });

  it('accepts the periodic status and normal transition fields', () => {
    const record = createControlDiagnosticRecord(
      'wrapper.status',
      {
        phase: 'status',
        elapsedMs: 60_000,
        nativeConnectionPhase: 'connected',
        attempt: 2,
        outboxBytes: 12,
        sessionCount: 1,
        preparingCount: 1,
        activeTurnCount: 1,
        recentTerminalCount: 1,
        runtimeCount: 1,
        suspectedCount: 1,
        restartingCount: 1,
        unavailableCount: 1,
        allocationId: 'alloc-1',
        wrapperInstanceId: '11111111-1111-4111-8111-111111111111',
      },
      1
    );
    expect(record?.fields).toMatchObject({
      phase: 'status',
      nativeConnectionPhase: 'connected',
      sessionCount: 1,
      outboxBytes: 12,
    });
    expect(
      createControlDiagnosticRecord(
        'wrapper.lifecycle',
        {
          phase: 'session_outcome',
          status: 'failed',
          sessionId: 'ses_1',
          outcomeReason: 'no_progress',
        },
        1
      )?.fields
    ).toMatchObject({ phase: 'session_outcome', outcomeReason: 'no_progress' });
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

describe('native diagnostic projector', () => {
  function collect() {
    const lines: string[] = [];
    return {
      lines,
      projector: createControlDiagnosticProjector({
        enabled: true,
        write: line => lines.push(line),
        now: () => 1,
      }),
    };
  }

  it('no-ops unless the native gate is set', () => {
    const lines: string[] = [];
    const projector = createControlDiagnosticProjector({
      enabled: false,
      write: line => lines.push(line),
    });
    projector('wrapper.lifecycle', { phase: 'ready' });
    expect(lines).toHaveLength(0);
  });

  it('projects an allowlisted lifecycle line and drops detail and reason', () => {
    const { lines, projector } = collect();
    projector('wrapper.lifecycle', {
      phase: 'failed',
      retirementCause: 'process_exited',
      detail: 'private detail',
      reason: 'private reason',
    });
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0] ?? '{}') as { fields: Record<string, unknown> };
    expect(record.fields).toMatchObject({ phase: 'failed', retirementCause: 'process_exited' });
    expect(record.fields).not.toHaveProperty('detail');
    expect(record.fields).not.toHaveProperty('reason');
    expect(lines[0]).not.toContain('private');
  });

  it('does not project heartbeats, keepalive, or retry scheduling', () => {
    const { lines, projector } = collect();
    expect(isProjectableControlDiagnostic('control.heartbeat', { phase: 'sent' })).toBe(false);
    projector('control.heartbeat', { phase: 'sent' });
    projector('control.socket', { phase: 'keepalive_sent' });
    projector('control.socket', { phase: 'keepalive_failed' });
    projector('wrapper.lifecycle', { phase: 'retry_scheduled' });
    expect(lines).toHaveLength(0);
  });

  it('projects the owner lines and a failed upload', () => {
    const { lines, projector } = collect();
    projector('control.upload', { phase: 'failed', category: 'network_failure' });
    projector('wrapper.lifecycle', { phase: 'kilo_restarting', kiloRestartReason: 'hang' });
    projector('wrapper.lifecycle', {
      phase: 'prepare_failed',
      preparationStep: 'clone',
      subtype: 'git_clone_timeout',
    });
    projector('wrapper.lifecycle', { phase: 'failed', retirementCause: 'unhandled_rejection' });
    projector('control.socket', { phase: 'connect_attempt', ok: false });
    expect(lines).toHaveLength(5);
  });

  it('projects the normal transitions and the periodic status line and drops detail and reason', () => {
    const { lines, projector } = collect();
    projector('wrapper.lifecycle', { phase: 'session_ready', sessionId: 'ses_1' });
    projector('wrapper.lifecycle', {
      phase: 'session_outcome',
      status: 'failed',
      sessionId: 'ses_1',
      outcomeReason: 'no_progress',
    });
    projector('wrapper.status', {
      phase: 'status',
      elapsedMs: 60_000,
      nativeConnectionPhase: 'connecting',
      attempt: 1,
      outboxBytes: 0,
      sessionCount: 0,
      preparingCount: 0,
      activeTurnCount: 0,
      recentTerminalCount: 0,
      runtimeCount: 0,
      suspectedCount: 0,
      restartingCount: 0,
      unavailableCount: 0,
      detail: 'private detail',
      reason: 'private reason',
    });
    projector('control.workload', { phase: 'started', workloadPhase: 'applied' });
    expect(lines).toHaveLength(4);
    const status = JSON.parse(lines[2] ?? '{}') as { fields: Record<string, unknown> };
    expect(status.fields).toMatchObject({ phase: 'status', nativeConnectionPhase: 'connecting' });
    expect(status.fields).not.toHaveProperty('detail');
    expect(status.fields).not.toHaveProperty('reason');
    expect(lines[2]).not.toContain('private');
  });

  it('projects only the production workload apply and failure shapes', () => {
    const { lines, projector } = collect();
    // The actual `initializeControlWorkload` success shape.
    projector('control.workload', {
      phase: 'started',
      workloadPhase: 'applied',
      containerLimitBytes: 4_000,
      aggregateMaxBytes: 3_000,
      toolsMaxBytes: 1_500,
      reserveBytes: 1_000,
      appliedMaxBytes: 3_000,
      readbackMaxBytes: 3_000,
      cpuController: false,
      siblingProtection: false,
      workloadLimitSource: 'cgroup',
    });
    // A completed rollback is not a projectable workload event.
    projector('control.workload', { phase: 'completed', workloadPhase: 'rollback' });
    // Workload stats and OOM readings never become a line.
    projector('control.workload', {
      phase: 'completed',
      workloadPhase: 'stats',
      oomKills: 4,
      oomGroupKills: 2,
      currentBytes: 512,
      peakBytes: 1_024,
      pressureSomeTotal: 3,
      pressureFullTotal: 1,
    });
    // A status record without the status phase is not projectable.
    projector('wrapper.status', { nativeConnectionPhase: 'idle' });
    // The production failure shape does project.
    projector('control.workload', {
      phase: 'failed',
      workloadPhase: 'failed',
      workloadFailure: 'flag_off',
    });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('"workloadPhase":"applied"');
    expect(lines[0]).toContain('"toolsMaxBytes":1500');
    expect(lines[1]).toContain('"workloadFailure":"flag_off"');
    expect(lines.join('\n')).not.toContain('oomKills');
  });

  it('projects a socket close and hello rejection but not a successful connect attempt', () => {
    const { lines, projector } = collect();
    projector('control.socket', { phase: 'closed' });
    projector('control.socket', { phase: 'hello_rejected' });
    projector('control.socket', { phase: 'connect_attempt', ok: true });
    expect(lines).toHaveLength(2);
  });
});

describe('controlUploadFailureStartsEpisode', () => {
  it('starts on the first failure and on a category change, not on repeats', () => {
    expect(
      controlUploadFailureStartsEpisode(undefined, {
        category: 'http_rejection',
        statusCode: 500,
      })
    ).toBe(true);
    const server = { category: 'http_rejection' as const, statusCode: 500 };
    // 500 then 502 is the same episode.
    expect(
      controlUploadFailureStartsEpisode(server, { category: 'http_rejection', statusCode: 502 })
    ).toBe(false);
    expect(controlUploadFailureStartsEpisode(server, { category: 'timeout' })).toBe(true);
  });

  it('treats a later 401/403 as one transition episode', () => {
    const server = { category: 'http_rejection' as const, statusCode: 500 };
    expect(
      controlUploadFailureStartsEpisode(server, { category: 'http_rejection', statusCode: 403 })
    ).toBe(true);
    const auth = { category: 'http_rejection' as const, statusCode: 403 };
    expect(
      controlUploadFailureStartsEpisode(auth, { category: 'http_rejection', statusCode: 401 })
    ).toBe(false);
    expect(controlUploadFailureStartsEpisode(auth, { category: 'timeout' })).toBe(true);
  });
});
