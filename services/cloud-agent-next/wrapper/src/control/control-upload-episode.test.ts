import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createControlDiagnosticProjector } from '../../../src/shared/control-diagnostics.js';
import { createControlDiagnostics } from './diagnostics.js';
import { createControlFileLogUploader } from './file-log-uploader.js';
import { createControlLogUploadAuth } from './log-upload-auth.js';

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

describe('control log upload credential rotation', () => {
  it.each([true, false])(
    'bounds both final uploads while credential renewal replies %s',
    async replies => {
      const dir = await mkdtemp(join(tmpdir(), 'control-final-renewal-'));
      const headers: string[] = [];
      const auth = createControlLogUploadAuth({ initialGrant: 'old-token', send() {} });
      auth.connected();
      void auth.rejected('old-token');
      expect(auth.current()).toBeUndefined();
      const fetch = async (_url: string, init: RequestInit) => {
        headers.push(new Headers(init.headers).get('Authorization') ?? '');
        return new Response(null, { status: 204 });
      };
      const diagnostics = createControlDiagnostics({ uploadUrl: UPLOAD_URL, auth, fetch });
      const wrapperLogPath = join(dir, 'wrapper.log');
      await writeFile(wrapperLogPath, 'final log');
      const files = createControlFileLogUploader({
        uploadUrl: UPLOAD_URL,
        auth,
        fetch,
        wrapperLogPath,
        homeRoots: [],
      });
      try {
        bufferHeartbeat(diagnostics);
        const started = performance.now();
        const finished = Promise.all([
          diagnostics.finalize(replies ? 1000 : 20),
          files.finalize(replies ? 1000 : 20),
        ]);
        if (replies) {
          await new Promise(resolve => setTimeout(resolve, 20));
          expect(headers).toEqual([]);
          auth.receive({
            type: 'logs.credentials',
            grant: 'new-token',
            expiresAt: Date.now() + 4 * 60 * 60_000,
          });
        }
        await finished;
        expect(performance.now() - started).toBeLessThan(replies ? 1500 : 500);
        expect(headers).toEqual(replies ? ['Bearer new-token', 'Bearer new-token'] : []);
      } finally {
        auth.stop();
        files.stop();
        await rm(dir, { recursive: true, force: true });
      }
    }
  );

  it('finalizes within its bound when rotating credentials are temporarily unavailable', async () => {
    let attempts = 0;
    const diagnostics = createControlDiagnostics({
      uploadUrl: 'https://worker.example/control/logs',
      auth: { current: () => undefined, rejected: async () => false },
      fetch: async () => {
        attempts++;
        return new Response(null, { status: 204 });
      },
    });
    bufferHeartbeat(diagnostics);
    const started = performance.now();
    await diagnostics.finalize(10);
    expect(performance.now() - started).toBeLessThan(500);
    expect(attempts).toBe(0);
  });

  it.each(['diagnostics', 'files'] as const)(
    'permanently stops %s uploads on a scope-forbidden response without refreshing',
    async kind => {
      let attempts = 0;
      let refreshes = 0;
      const auth = {
        current: () => ({ token: 'grant', expiresAt: Date.now() + 60_000 }),
        rejected: async () => {
          refreshes++;
          return false;
        },
      };
      const upload = async () => {
        attempts++;
        return new Response(null, { status: 403 });
      };
      if (kind === 'diagnostics') {
        const diagnostics = createControlDiagnostics({
          uploadUrl: 'https://worker.example/control/logs',
          auth,
          fetch: upload,
        });
        bufferHeartbeat(diagnostics);
        await diagnostics.flush();
        bufferHeartbeat(diagnostics);
        await diagnostics.flush();
        await diagnostics.finalize(10);
      } else {
        const root = await mkdtemp(join(tmpdir(), 'control-forbidden-'));
        try {
          const wrapperLogPath = join(root, 'wrapper.log');
          await writeFile(wrapperLogPath, 'log');
          const uploader = createControlFileLogUploader({
            uploadUrl: 'https://worker.example/control/logs',
            auth,
            wrapperLogPath,
            homeRoots: [],
            fetch: upload,
          });
          await uploader.uploadNow();
          await uploader.uploadNow();
          uploader.stop();
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }
      expect(attempts).toBe(1);
      expect(refreshes).toBe(0);
    }
  );

  it('does not extend finalize behind a hanging renewal', async () => {
    const auth = {
      current: () => ({ token: 'old-token', expiresAt: Number.POSITIVE_INFINITY }),
      rejected: () => new Promise<boolean>(() => {}),
    };
    const diagnostics = createControlDiagnostics({
      uploadUrl: UPLOAD_URL,
      auth,
      fetch: () => Promise.resolve(new Response(null, { status: 401 })),
      now: () => 1,
    });
    bufferHeartbeat(diagnostics);
    const started = Date.now();
    await diagnostics.finalize(50);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('reads the newest token when a queued archive actually uploads', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'control-upload-queued-'));
    const wrapperLogPath = join(dir, 'wrapper.log');
    let token = 'old-token';
    let releaseFirst: (response: Response) => void = () => undefined;
    let markFirstStarted: () => void = () => undefined;
    const firstStarted = new Promise<void>(resolve => {
      markFirstStarted = resolve;
    });
    const headers: string[] = [];
    try {
      await writeFile(wrapperLogPath, 'wrapper log bytes');
      const auth = {
        current: () => ({ token, expiresAt: Number.POSITIVE_INFINITY }),
        rejected: async () => false,
      };
      const fileLogs = createControlFileLogUploader({
        uploadUrl: UPLOAD_URL,
        auth,
        wrapperLogPath,
        homeRoots: [dir],
        fetch: (_url, init) => {
          headers.push(new Headers(init.headers).get('Authorization') ?? '');
          if (headers.length === 1) {
            markFirstStarted();
            return new Promise<Response>(resolve => {
              releaseFirst = resolve;
            });
          }
          return Promise.resolve(new Response(null, { status: 204 }));
        },
      });

      const first = fileLogs.uploadNow();
      await firstStarted;
      const second = fileLogs.uploadNow();
      token = 'new-token';
      releaseFirst(new Response(null, { status: 204 }));
      await Promise.all([first, second]);
      expect(headers).toEqual(['Bearer old-token', 'Bearer new-token']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps the pending diagnostic batch and rotates the archive uploader with the shared owner', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'control-upload-rotation-'));
    const wrapperLogPath = join(dir, 'wrapper.log');
    try {
      await writeFile(wrapperLogPath, 'wrapper log bytes');
      let token = 'old-token';
      const rejected: string[] = [];
      const auth = {
        current: () => ({ token, expiresAt: Number.POSITIVE_INFINITY }),
        rejected: async (used: string) => {
          rejected.push(used);
          return false;
        },
      };
      const diagnosticHeaders: string[] = [];
      const archiveHeaders: string[] = [];
      const diagnostics = createControlDiagnostics({
        uploadUrl: UPLOAD_URL,
        auth,
        fetch: (_url, init) => {
          const header = new Headers(init.headers).get('Authorization') ?? '';
          diagnosticHeaders.push(header);
          return Promise.resolve(
            new Response(null, { status: header === 'Bearer new-token' ? 204 : 401 })
          );
        },
        now: () => 1,
      });
      const fileLogs = createControlFileLogUploader({
        uploadUrl: UPLOAD_URL,
        auth,
        wrapperLogPath,
        homeRoots: [dir],
        fetch: (_url, init) => {
          const header = new Headers(init.headers).get('Authorization') ?? '';
          archiveHeaders.push(header);
          return Promise.resolve(
            new Response(null, { status: header === 'Bearer new-token' ? 204 : 401 })
          );
        },
      });

      bufferHeartbeat(diagnostics);
      await diagnostics.flush();
      await fileLogs.uploadNow();
      expect(rejected).toEqual(['old-token', 'old-token']);
      // A rejected batch is retained rather than dropped.
      expect(diagnosticHeaders).toEqual(['Bearer old-token']);
      expect(archiveHeaders).toEqual(['Bearer old-token']);

      token = 'new-token';
      await diagnostics.flush();
      await fileLogs.uploadNow();
      expect(diagnosticHeaders).toEqual(['Bearer old-token', 'Bearer new-token']);
      expect(archiveHeaders).toEqual(['Bearer old-token', 'Bearer new-token']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

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
        homeRoots: [dir],
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
