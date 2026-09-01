import { describe, expect, it, spyOn } from 'bun:test';
import {
  CONTROL_LOG_MAX_BATCH_BYTES,
  CONTROL_LOG_MAX_BATCH_RECORDS,
  CONTROL_LOG_MAX_BUFFER_RECORDS,
  controlLogBatchSchema,
} from '../../../src/shared/control-diagnostics.js';
import { createControlDiagnostics } from './diagnostics';
import { buildWorktreeKiloEnvironment } from './worktree-runtime';

const uploadUrl = 'http://worker.test/sandbox-logs/sandbox/allocation/wrapper';
const uploadGrant = 'test-upload-only-grant';

function requestBody(init: RequestInit): string {
  if (typeof init.body !== 'string') throw new Error('Expected JSON body');
  return init.body;
}

function record(diagnostics: ReturnType<typeof createControlDiagnostics>, phase = 'started') {
  diagnostics.onDiagnostic('session.task', {
    phase,
    kind: 'execution',
    sessionId: 'workspace_test',
  });
}

describe('control diagnostics', () => {
  it('strips log upload secrets and configuration from both inherited and supplied child env', () => {
    const privateEnv = {
      CONTROL_LOG_UPLOAD_URL: uploadUrl,
      CONTROL_LOG_UPLOAD_GRANT: uploadGrant,
      CONTROL_WRAPPER_INSTANCE_ID: 'private-wrapper-identity',
    };
    const child = buildWorktreeKiloEnvironment(
      '/workspace/test',
      '/home/test',
      {
        scopeId: 'worktree_test',
        token: 'worktree-token',
        targets: {
          backendBaseUrl: 'https://backend.test',
          providerBaseUrl: 'https://provider.test',
          sessionIngestBaseUrl: 'https://ingest.test',
        },
      },
      privateEnv,
      privateEnv
    );
    for (const name of Object.keys(privateEnv)) expect(child[name]).toBeUndefined();
    expect(JSON.stringify(child)).not.toContain(uploadGrant);
  });

  it('retries a timed-out upload with the same immutable identity and ignores its late result', async () => {
    const late = Promise.withResolvers<Response>();
    const requests: string[] = [];
    const diagnostics = createControlDiagnostics({
      uploadUrl,
      uploadGrant,
      uploadTimeoutMs: 10,
      fetch: async url => {
        requests.push(url);
        return requests.length === 1 ? late.promise : new Response(null, { status: 204 });
      },
    });
    record(diagnostics);
    await diagnostics.flush();
    await diagnostics.flush();
    late.resolve(new Response(null, { status: 204 }));
    record(diagnostics, 'finished');
    await diagnostics.finalize();
    expect(requests).toHaveLength(3);
    expect(requests[0]).toBe(requests[1]);
    expect(requests[2]).not.toBe(requests[0]);
  });

  it('uploads startup immediately, then periodically, with structured records only', async () => {
    const uploads: string[] = [];
    const diagnostics = createControlDiagnostics({
      uploadUrl,
      uploadGrant,
      intervalMs: 5,
      fetch: async (_url, init) => {
        expect(new Headers(init.headers).get('Authorization')).toBe(`Bearer ${uploadGrant}`);
        expect(init.redirect).toBe('error');
        uploads.push(requestBody(init));
        return new Response(null, { status: 204 });
      },
    });
    diagnostics.onDiagnostic('wrapper.lifecycle', { phase: 'starting', error: 'secret' });
    diagnostics.start();
    await diagnostics.flush();
    expect(uploads).toHaveLength(1);
    record(diagnostics);
    diagnostics.onDiagnostic('control.heartbeat', { phase: 'sending', sequence: 1 });
    diagnostics.onDiagnostic('control.heartbeat', { phase: 'sent', sequence: 1 });
    await Bun.sleep(20);
    await diagnostics.finalize();
    expect(uploads).toHaveLength(2);
    const periodicBatch = controlLogBatchSchema.parse(JSON.parse(uploads[1]));
    expect(periodicBatch.records).toHaveLength(3);
    expect(periodicBatch.droppedRecords).toBe(0);
    expect(uploads.join('')).not.toContain('secret');
    expect(uploads.join('')).not.toContain(uploadGrant);
    expect(uploads.every(body => controlLogBatchSchema.safeParse(JSON.parse(body)).success)).toBe(
      true
    );
  });

  it('serializes uploads and retries the same immutable batch before newer records', async () => {
    const uploads: Array<{ url: string; body: string }> = [];
    const response = Promise.withResolvers<Response>();
    const diagnostics = createControlDiagnostics({
      uploadUrl,
      uploadGrant,
      fetch: async (url, init) => {
        uploads.push({ url, body: requestBody(init) });
        return uploads.length === 1 ? response.promise : new Response(null, { status: 204 });
      },
    });
    record(diagnostics);
    const first = diagnostics.flush();
    expect(diagnostics.flush()).toBe(first);
    record(diagnostics, 'finished');
    expect(uploads).toHaveLength(1);
    response.resolve(new Response('private-response-body', { status: 503 }));
    await first;
    await diagnostics.flush();
    await diagnostics.finalize();
    expect(uploads).toHaveLength(3);
    expect(uploads[1]).toEqual(uploads[0]);
    expect(uploads[2].url).not.toBe(uploads[0].url);
    const recovered = controlLogBatchSchema.parse(JSON.parse(uploads[2].body));
    expect(recovered.sequence).toBe(1);
    expect(recovered.records).toContainEqual(
      expect.objectContaining({
        event: 'control.upload',
        fields: expect.objectContaining({
          category: 'http_rejection',
          statusCode: 503,
          failureCount: 1,
        }),
      })
    );
    expect(uploads.map(upload => upload.body).join('')).not.toContain('private-response-body');
  });

  it.each([401, 403])('stops uploads after authentication is rejected with %s', async status => {
    let uploads = 0;
    const diagnostics = createControlDiagnostics({
      uploadUrl,
      uploadGrant,
      intervalMs: 5,
      fetch: async () => {
        uploads++;
        return new Response(null, { status });
      },
    });
    record(diagnostics);
    diagnostics.start();
    await diagnostics.flush();
    try {
      record(diagnostics, 'finished');
      await Bun.sleep(20);
      diagnostics.start();
      await diagnostics.flush();
    } finally {
      await diagnostics.finalize();
    }
    expect(uploads).toBe(1);
  });

  it('keeps failed-batch retries on the timer instead of retrying for every new record', async () => {
    let uploads = 0;
    const diagnostics = createControlDiagnostics({
      uploadUrl,
      uploadGrant,
      intervalMs: 60_000,
      fetch: async () => {
        uploads++;
        return new Response(null, { status: 503 });
      },
    });
    record(diagnostics);
    diagnostics.start();
    await diagnostics.flush();
    try {
      for (let i = 0; i < CONTROL_LOG_MAX_BATCH_RECORDS + 10; i++) {
        record(diagnostics);
        await Promise.resolve();
      }
      expect(uploads).toBe(1);
    } finally {
      await diagnostics.finalize();
    }
  });

  it('bounds queued records and batch bytes and reports dropped records', async () => {
    const bodies: string[] = [];
    const diagnostics = createControlDiagnostics({
      uploadUrl,
      uploadGrant,
      fetch: async (_url, init) => {
        bodies.push(requestBody(init));
        return new Response(null, { status: 204 });
      },
    });
    for (let i = 0; i < CONTROL_LOG_MAX_BUFFER_RECORDS + 50; i++) record(diagnostics);
    await diagnostics.finalize();
    const batches = bodies.map(body => controlLogBatchSchema.parse(JSON.parse(body)));
    expect(batches.flatMap(batch => batch.records)).toHaveLength(CONTROL_LOG_MAX_BUFFER_RECORDS);
    expect(batches[0].droppedRecords).toBe(50);
    expect(bodies.every(body => Buffer.byteLength(body) <= CONTROL_LOG_MAX_BATCH_BYTES)).toBe(true);
  });

  it.each(['ordinary', 'heartbeat'])(
    'retains startup, latest heartbeat and terminal evidence under %s buffer pressure',
    async distribution => {
      const bodies: string[] = [];
      const diagnostics = createControlDiagnostics({
        uploadUrl,
        uploadGrant,
        fetch: async (_url, init) => {
          bodies.push(requestBody(init));
          return new Response(null, { status: 204 });
        },
      });
      diagnostics.onDiagnostic('wrapper.lifecycle', { phase: 'starting' });
      for (let i = 0; i < CONTROL_LOG_MAX_BUFFER_RECORDS; i++) {
        if (distribution === 'heartbeat') {
          diagnostics.onDiagnostic('control.heartbeat', { phase: 'sent', sequence: i });
        } else {
          record(diagnostics);
        }
      }
      diagnostics.onDiagnostic('control.heartbeat', { phase: 'sent', sequence: 1 });
      diagnostics.onDiagnostic('control.heartbeat', { phase: 'sent', sequence: 2 });
      diagnostics.onDiagnostic('session.execution', {
        phase: 'outcome_sent',
        messageId: 'msg_terminal',
      });
      await diagnostics.finalize();
      const batches = bodies.map(body => controlLogBatchSchema.parse(JSON.parse(body)));
      const retained = batches.flatMap(batch => batch.records);
      expect(retained).toHaveLength(CONTROL_LOG_MAX_BUFFER_RECORDS);
      expect(retained.some(record => record.event === 'wrapper.lifecycle')).toBe(true);
      expect(
        retained
          .filter(record => record.event === 'control.heartbeat')
          .map(record => record.fields.sequence)
      ).toContain(2);
      expect(retained.some(record => record.fields.messageId === 'msg_terminal')).toBe(true);
      expect(batches[0].droppedRecords).toBe(4);
      expect(batches[0].droppedTerminalRecords).toBe(0);
    }
  );

  it('accounts explicitly for terminal loss when even priority records exceed the buffer bound', async () => {
    const bodies: string[] = [];
    const diagnostics = createControlDiagnostics({
      uploadUrl,
      uploadGrant,
      fetch: async (_url, init) => {
        bodies.push(requestBody(init));
        return new Response(null, { status: 204 });
      },
    });
    diagnostics.onDiagnostic('wrapper.lifecycle', { phase: 'starting' });
    diagnostics.onDiagnostic('control.heartbeat', { phase: 'sent', sequence: 1 });
    for (let i = 0; i < CONTROL_LOG_MAX_BUFFER_RECORDS; i++) {
      diagnostics.onDiagnostic('session.execution', {
        phase: 'outcome_sent',
        messageId: `msg_${i}`,
      });
    }
    await diagnostics.finalize();
    const batches = bodies.map(body => controlLogBatchSchema.parse(JSON.parse(body)));
    const retained = batches.flatMap(batch => batch.records);
    expect(retained).toHaveLength(CONTROL_LOG_MAX_BUFFER_RECORDS);
    expect(retained.some(record => record.event === 'wrapper.lifecycle')).toBe(true);
    expect(retained.some(record => record.event === 'control.heartbeat')).toBe(true);
    expect(
      retained.some(
        record => record.fields.messageId === `msg_${CONTROL_LOG_MAX_BUFFER_RECORDS - 1}`
      )
    ).toBe(true);
    expect(batches[0].droppedRecords).toBe(2);
    expect(batches[0].droppedTerminalRecords).toBe(2);
  });

  it('bounds finalization even when fetch ignores abort and makes finalization idempotent', async () => {
    let signal: AbortSignal | null | undefined;
    let uploads = 0;
    const diagnostics = createControlDiagnostics({
      uploadUrl,
      uploadGrant,
      fetch: async (_url, init) => {
        uploads++;
        signal = init.signal;
        return new Promise(() => {});
      },
    });
    record(diagnostics);
    void diagnostics.flush();
    const started = Date.now();
    const final = diagnostics.finalize(25);
    expect(diagnostics.finalize()).toBe(final);
    await final;
    expect(Date.now() - started).toBeLessThan(500);
    expect(signal?.aborted).toBe(true);
    await diagnostics.flush();
    expect(uploads).toBe(1);
  });

  it('flushes shutdown records after the active upload completes', async () => {
    const pending = Promise.withResolvers<Response>();
    const bodies: string[] = [];
    const diagnostics = createControlDiagnostics({
      uploadUrl,
      uploadGrant,
      fetch: async (_url, init) => {
        bodies.push(requestBody(init));
        return bodies.length === 1 ? pending.promise : new Response(null, { status: 204 });
      },
    });
    record(diagnostics);
    void diagnostics.flush();
    diagnostics.onDiagnostic('wrapper.lifecycle', { phase: 'stopping', exitCode: 1 });
    const final = diagnostics.finalize();
    pending.resolve(new Response(null, { status: 204 }));
    await final;
    expect(bodies).toHaveLength(2);
    const lastBatch = controlLogBatchSchema.parse(JSON.parse(bodies[1]));
    expect(lastBatch.sequence).toBe(1);
    expect(lastBatch.records).toHaveLength(1);
  });

  it('degrades without configuration and swallows upload errors', async () => {
    const disabled = createControlDiagnostics({});
    disabled.start();
    record(disabled);
    await disabled.finalize();
    const stderr = spyOn(console, 'error').mockImplementation(() => {
      throw new Error('stderr unavailable');
    });
    try {
      const diagnostics = createControlDiagnostics({
        uploadUrl,
        uploadGrant,
        fetch: async () => {
          throw new Error('Authorization: secret');
        },
      });
      record(diagnostics);
      await diagnostics.flush();
      await diagnostics.finalize();
    } finally {
      stderr.mockRestore();
    }
  });
});
