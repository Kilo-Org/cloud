import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createControlDiagnosticProjector } from '../../../src/shared/control-diagnostics.js';
import { createControlDiagnostics } from './diagnostics.js';
import { createControlFileLogUploader } from './file-log-uploader.js';

const UPLOAD_URL = 'https://control.example/sandbox-logs/a/b/c';
const UPLOAD_GRANT = 'grant';

type Harness = {
  dir: string;
  wrapperLogPath: string;
  cleanup: () => Promise<void>;
};

async function createHarness(): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'control-upload-'));
  const wrapperLogPath = join(dir, 'wrapper.log');
  await writeFile(wrapperLogPath, 'wrapper log bytes');
  return { dir, wrapperLogPath, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function collectLines() {
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

/** A record the projector excludes, for buffering without adding stderr lines. */
function bufferHeartbeat(diagnostics: ReturnType<typeof createControlDiagnostics>): void {
  diagnostics.onDiagnostic('control.heartbeat', { phase: 'sent' });
}

describe('native upload episode projection', () => {
  it('projects archive and diagnostic episodes independently and keeps non-upload lines after 403', async () => {
    const harness = await createHarness();
    try {
      const { lines, projector } = collectLines();
      const putBodies: string[] = [];
      const archiveStatuses = [500, 500, 401, 403];
      const archiveFetch = (): Promise<Response> =>
        Promise.resolve(new Response(null, { status: archiveStatuses.shift() ?? 204 }));
      const diagnosticStatuses = [403];
      const diagnosticFetch = (_url: string, init: RequestInit): Promise<Response> => {
        putBodies.push(typeof init.body === 'string' ? init.body : '');
        return Promise.resolve(new Response(null, { status: diagnosticStatuses.shift() ?? 204 }));
      };

      const diagnostics = createControlDiagnostics({
        uploadUrl: UPLOAD_URL,
        uploadGrant: UPLOAD_GRANT,
        fetch: diagnosticFetch,
        projector,
        now: () => 1,
      });
      const fileLogs = createControlFileLogUploader({
        uploadUrl: UPLOAD_URL,
        uploadGrant: UPLOAD_GRANT,
        wrapperLogPath: harness.wrapperLogPath,
        homeRoot: harness.dir,
        fetch: archiveFetch,
        onDiagnostic: diagnostics.onDiagnostic,
        projector,
      });

      // Two same-category archive failures: one stderr line, two buffered records.
      await fileLogs.uploadNow();
      await fileLogs.uploadNow();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('"category":"http_rejection"');
      expect(lines[0]).toContain('"statusCode":500');

      // The diagnostic 403 transitions and writes exactly one more line, and the
      // flush body carries both buffered per-attempt archive failures.
      await diagnostics.flush();
      expect(lines).toHaveLength(2);
      expect(lines[1]).toContain('"statusCode":403');
      const body = JSON.parse(putBodies[0] ?? '{}') as {
        records: Array<{ event: string; fields: Record<string, unknown> }>;
      };
      const buffered = body.records.filter(
        record =>
          record.event === 'control.upload' &&
          record.fields.phase === 'failed' &&
          record.fields.statusCode === 500
      );
      expect(buffered).toHaveLength(2);

      // The diagnostic buffer is no longer accepting; a non-upload line still projects.
      diagnostics.onDiagnostic('wrapper.lifecycle', { phase: 'ready' });
      expect(lines).toHaveLength(3);
      expect(lines[2]).toContain('"phase":"ready"');

      // The archive projector still writes its own transition episode (500 -> 401).
      await fileLogs.uploadNow();
      expect(lines).toHaveLength(4);
      expect(lines[3]).toContain('"statusCode":401');

      // A later 401/403 does not project again.
      await fileLogs.uploadNow();
      expect(lines).toHaveLength(4);
    } finally {
      await harness.cleanup();
    }
  });

  it('bounds repeated identical diagnostic failures and projects a category change on the same uploader', async () => {
    const harness = await createHarness();
    try {
      const { lines, projector } = collectLines();
      const outcomes: Array<number | 'reject'> = [500, 500, 500, 'reject'];
      const diagnostics = createControlDiagnostics({
        uploadUrl: UPLOAD_URL,
        uploadGrant: UPLOAD_GRANT,
        projector,
        fetch: () => {
          const next = outcomes.shift();
          return next === 'reject'
            ? Promise.reject(new Error('network down'))
            : Promise.resolve(new Response(null, { status: next ?? 204 }));
        },
        now: () => 1,
      });

      for (let attempt = 0; attempt < 3; attempt += 1) {
        bufferHeartbeat(diagnostics);
        await diagnostics.flush();
      }
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('"statusCode":500');

      // A network failure is a new category on the same owner, so one more line.
      bufferHeartbeat(diagnostics);
      await diagnostics.flush();
      expect(lines).toHaveLength(2);
      expect(lines[1]).toContain('"category":"network_failure"');
    } finally {
      await harness.cleanup();
    }
  });

  it('projects a same-owner diagnostic timeout category and resets on 204', async () => {
    const harness = await createHarness();
    try {
      const { lines, projector } = collectLines();
      let mode: 'reject500' | 'hang' | 'accept204' = 'reject500';
      const diagnostics = createControlDiagnostics({
        uploadUrl: UPLOAD_URL,
        uploadGrant: UPLOAD_GRANT,
        projector,
        uploadTimeoutMs: 5,
        fetch: () => {
          if (mode === 'hang') return new Promise<Response>(() => {});
          return Promise.resolve(new Response(null, { status: mode === 'accept204' ? 204 : 500 }));
        },
        now: () => 1,
      });

      bufferHeartbeat(diagnostics);
      await diagnostics.flush();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('"statusCode":500');

      // The same uploader and pending batch: a timeout is a new category.
      mode = 'hang';
      bufferHeartbeat(diagnostics);
      await diagnostics.flush();
      expect(lines).toHaveLength(2);
      expect(lines[1]).toContain('"category":"timeout"');

      // A 204 accepts and clears the episode latch without a line.
      mode = 'accept204';
      bufferHeartbeat(diagnostics);
      await diagnostics.flush();
      expect(lines).toHaveLength(2);

      // The next failure is a new episode.
      mode = 'reject500';
      bufferHeartbeat(diagnostics);
      await diagnostics.flush();
      expect(lines).toHaveLength(3);
      expect(lines[2]).toContain('"statusCode":500');
    } finally {
      await harness.cleanup();
    }
  });

  it('resets the archive latch after a 204 so the next failure is a new episode', async () => {
    const harness = await createHarness();
    try {
      const { lines, projector } = collectLines();
      const statuses = [500, 204, 500];
      const fileLogs = createControlFileLogUploader({
        uploadUrl: UPLOAD_URL,
        uploadGrant: UPLOAD_GRANT,
        wrapperLogPath: harness.wrapperLogPath,
        homeRoot: harness.dir,
        fetch: () => Promise.resolve(new Response(null, { status: statuses.shift() ?? 204 })),
        onDiagnostic: () => undefined,
        projector,
      });

      await fileLogs.uploadNow();
      expect(lines).toHaveLength(1);

      await fileLogs.uploadNow();
      expect(lines).toHaveLength(1);

      await fileLogs.uploadNow();
      expect(lines).toHaveLength(2);
      expect(lines[1]).toContain('"statusCode":500');
    } finally {
      await harness.cleanup();
    }
  });

  it('drops detail from stderr but keeps it in the uploaded diagnostic record', async () => {
    const harness = await createHarness();
    try {
      const { lines, projector } = collectLines();
      let putBody = '';
      const diagnostics = createControlDiagnostics({
        uploadUrl: UPLOAD_URL,
        uploadGrant: UPLOAD_GRANT,
        projector,
        fetch: (_url: string, init: RequestInit): Promise<Response> => {
          putBody = typeof init.body === 'string' ? init.body : '';
          return Promise.resolve(new Response(null, { status: 204 }));
        },
        now: () => 1,
      });

      diagnostics.onDiagnostic('wrapper.lifecycle', {
        phase: 'stopping',
        detail: 'secret-detail',
      });
      expect(lines).toHaveLength(1);
      expect(lines[0]).not.toContain('secret-detail');
      expect(lines[0]).not.toContain('"detail"');

      await diagnostics.flush();
      expect(putBody).toContain('secret-detail');
    } finally {
      await harness.cleanup();
    }
  });

  it('does not buffer the status and normal-transition lines and still projects status after a 403', async () => {
    const harness = await createHarness();
    try {
      const { lines, projector } = collectLines();
      let putBody = '';
      const diagnostics = createControlDiagnostics({
        uploadUrl: UPLOAD_URL,
        uploadGrant: UPLOAD_GRANT,
        projector,
        fetch: (_url: string, init: RequestInit): Promise<Response> => {
          putBody = typeof init.body === 'string' ? init.body : '';
          return Promise.resolve(new Response(null, { status: 403 }));
        },
        now: () => 1,
      });

      const status = (elapsedMs: number, phase: string): void => {
        projector('wrapper.status', {
          phase: 'status',
          elapsedMs,
          nativeConnectionPhase: phase,
          attempt: 0,
          outboxBytes: 0,
          sessionCount: 0,
          preparingCount: 0,
          activeTurnCount: 0,
          recentTerminalCount: 0,
          runtimeCount: 0,
          suspectedCount: 0,
          restartingCount: 0,
          unavailableCount: 0,
        });
      };

      // The owners project these directly; none enters the diagnostic buffer.
      status(1, 'idle');
      projector('wrapper.lifecycle', { phase: 'session_ready', sessionId: 'ses_1' });
      projector('wrapper.lifecycle', {
        phase: 'session_outcome',
        status: 'completed',
        sessionId: 'ses_1',
      });
      expect(lines).toHaveLength(3);

      // The diagnostic 403 closes the upload gate; the projector is independent.
      diagnostics.onDiagnostic('control.heartbeat', { phase: 'sent' });
      await diagnostics.flush();
      const body = JSON.parse(putBody || '{}') as {
        records: Array<{ event: string; fields: Record<string, unknown> }>;
      };
      expect(body.records).toHaveLength(1);
      expect(body.records.some(record => record.event === 'wrapper.status')).toBe(false);
      expect(body.records.some(record => record.fields.phase === 'session_ready')).toBe(false);
      expect(body.records.some(record => record.fields.phase === 'session_outcome')).toBe(false);

      // The uploader stopped, but a later status line still reaches stderr.
      status(2, 'closed');
      expect(lines).toHaveLength(5);
      expect(lines[4]).toContain('"nativeConnectionPhase":"closed"');
    } finally {
      await harness.cleanup();
    }
  });

  it('keeps the per-attempt console line when the gate is unset', async () => {
    const harness = await createHarness();
    try {
      const lines: string[] = [];
      const projector = createControlDiagnosticProjector({
        enabled: false,
        write: line => lines.push(line),
      });
      const errors: string[] = [];
      const original = console.error;
      console.error = (...args: unknown[]) => {
        errors.push(args.map(String).join(' '));
      };
      try {
        const statuses = [500, 500];
        const diagnostics = createControlDiagnostics({
          uploadUrl: UPLOAD_URL,
          uploadGrant: UPLOAD_GRANT,
          projector,
          fetch: () => Promise.resolve(new Response(null, { status: statuses.shift() ?? 204 })),
          now: () => 1,
        });
        bufferHeartbeat(diagnostics);
        await diagnostics.flush();
        bufferHeartbeat(diagnostics);
        await diagnostics.flush();
        expect(lines).toHaveLength(0);
        expect(errors.filter(line => line.includes('"event":"control.upload"'))).toHaveLength(2);
      } finally {
        console.error = original;
      }
    } finally {
      await harness.cleanup();
    }
  });
});
