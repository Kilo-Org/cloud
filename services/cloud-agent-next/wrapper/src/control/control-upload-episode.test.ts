import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createControlDiagnosticProjector } from '../../../src/shared/control-diagnostics.js';
import { createControlDiagnostics } from './diagnostics.js';
import { createControlFileLogUploader } from './file-log-uploader.js';

const UPLOAD_URL = 'https://control.example/sandbox-logs/a/b/c';
const UPLOAD_GRANT = 'grant';

function collectLines(enabled = true) {
  const lines: string[] = [];
  return {
    lines,
    projector: createControlDiagnosticProjector({
      enabled,
      write: line => lines.push(line),
      now: () => 1,
    }),
  };
}

function bufferHeartbeat(diagnostics: ReturnType<typeof createControlDiagnostics>): void {
  diagnostics.onDiagnostic('control.heartbeat', { phase: 'sent' });
}

describe('native upload episode projection', () => {
  it('keeps archive and diagnostic episodes independent, resets on success, and projects after 403', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'control-upload-'));
    const wrapperLogPath = join(dir, 'wrapper.log');
    try {
      await writeFile(wrapperLogPath, 'wrapper log bytes');
      const { lines, projector } = collectLines();
      const putBodies: string[] = [];
      const archiveStatuses = [500, 500, 204, 500, 401, 403];
      const diagnostics = createControlDiagnostics({
        uploadUrl: UPLOAD_URL,
        uploadGrant: UPLOAD_GRANT,
        fetch: (_url, init) => {
          putBodies.push(typeof init.body === 'string' ? init.body : '');
          return Promise.resolve(new Response(null, { status: 403 }));
        },
        projector,
        now: () => 1,
      });
      const fileLogs = createControlFileLogUploader({
        uploadUrl: UPLOAD_URL,
        uploadGrant: UPLOAD_GRANT,
        wrapperLogPath,
        homeRoot: dir,
        fetch: () =>
          Promise.resolve(new Response(null, { status: archiveStatuses.shift() ?? 204 })),
        onDiagnostic: diagnostics.onDiagnostic,
        projector,
      });

      await fileLogs.uploadNow();
      await fileLogs.uploadNow();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('"category":"http_rejection"');
      expect(lines[0]).toContain('"statusCode":500');

      await diagnostics.flush();
      expect(lines).toHaveLength(2);
      expect(lines[1]).toContain('"statusCode":403');
      const body = JSON.parse(putBodies[0] ?? '{}') as {
        records: Array<{ event: string; fields: Record<string, unknown> }>;
      };
      expect(
        body.records.filter(
          record =>
            record.event === 'control.upload' &&
            record.fields.phase === 'failed' &&
            record.fields.statusCode === 500
        )
      ).toHaveLength(2);

      diagnostics.onDiagnostic('wrapper.lifecycle', { phase: 'ready' });
      expect(lines).toHaveLength(3);
      expect(lines[2]).toContain('"phase":"ready"');

      await fileLogs.uploadNow();
      expect(lines).toHaveLength(3);
      await fileLogs.uploadNow();
      expect(lines).toHaveLength(4);
      expect(lines[3]).toContain('"statusCode":500');
      await fileLogs.uploadNow();
      expect(lines).toHaveLength(5);
      expect(lines[4]).toContain('"statusCode":401');
      await fileLogs.uploadNow();
      expect(lines).toHaveLength(5);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('bounds diagnostic repeats, projects network and timeout transitions, and resets on 204', async () => {
    const { lines, projector } = collectLines();
    const outcomes: Array<number | 'reject' | 'hang'> = [500, 500, 502, 'reject', 'hang', 204, 500];
    const diagnostics = createControlDiagnostics({
      uploadUrl: UPLOAD_URL,
      uploadGrant: UPLOAD_GRANT,
      projector,
      uploadTimeoutMs: 5,
      fetch: () => {
        const next = outcomes.shift();
        if (next === 'reject') return Promise.reject(new Error('network down'));
        if (next === 'hang') return new Promise<Response>(() => {});
        return Promise.resolve(new Response(null, { status: next ?? 204 }));
      },
      now: () => 1,
    });
    for (const expectedLines of [1, 1, 1, 2, 3, 3, 4]) {
      bufferHeartbeat(diagnostics);
      await diagnostics.flush();
      expect(lines).toHaveLength(expectedLines);
    }
    expect(lines[0]).toContain('"statusCode":500');
    expect(lines[1]).toContain('"category":"network_failure"');
    expect(lines[2]).toContain('"category":"timeout"');
    expect(lines[3]).toContain('"statusCode":500');
  });

  it('drops detail from stderr but keeps it in the uploaded diagnostic record', async () => {
    const { lines, projector } = collectLines();
    let putBody = '';
    const diagnostics = createControlDiagnostics({
      uploadUrl: UPLOAD_URL,
      uploadGrant: UPLOAD_GRANT,
      projector,
      fetch: (_url, init) => {
        putBody = typeof init.body === 'string' ? init.body : '';
        return Promise.resolve(new Response(null, { status: 204 }));
      },
      now: () => 1,
    });
    diagnostics.onDiagnostic('wrapper.lifecycle', { phase: 'stopping', detail: 'secret-detail' });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('secret-detail');
    expect(lines[0]).not.toContain('"detail"');
    await diagnostics.flush();
    expect(putBody).toContain('secret-detail');
  });

  it('keeps the per-attempt console line when the gate is unset', async () => {
    const { lines, projector } = collectLines(false);
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args.map(String).join(' '));
    try {
      const diagnostics = createControlDiagnostics({
        uploadUrl: UPLOAD_URL,
        uploadGrant: UPLOAD_GRANT,
        projector,
        fetch: () => Promise.resolve(new Response(null, { status: 500 })),
        now: () => 1,
      });
      for (let attempt = 0; attempt < 2; attempt += 1) {
        bufferHeartbeat(diagnostics);
        await diagnostics.flush();
      }
      expect(lines).toHaveLength(0);
      expect(errors.filter(line => line.includes('"event":"control.upload"'))).toHaveLength(2);
    } finally {
      console.error = original;
    }
  });
});
