import { afterEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  CONTROL_LOG_ARCHIVE_NAME,
  CONTROL_LOG_MAX_ARCHIVE_BYTES,
} from '../../../src/shared/control-diagnostics.js';
import { directoryHome } from '../control-plane/workspace-home.js';
import { createControlPlaneSessionHost } from '../control-plane/main.js';
import type { KiloEventFeedSource } from '../control-plane/kilo-event-feed.js';
import type { KiloFeedCallbacks } from '../control-plane/kilo-runtime.js';
import { createKilo2Harness } from '../control-plane/kilo2-harness.js';
import { createKilo2Lifecycle } from '../control-plane/kilo2-lifecycle.js';
import { CONTROL_PLANE_TIMERS } from '../../../src/shared/control-plane-timers.js';
import type { ControlPlaneWrapperFrame } from '../../../src/shared/control-plane-protocol.js';
import { buildWorktreeKiloEnvironment } from './worktree-runtime.js';
import { createControlFileLogUploader, type ControlFileLogUploader } from './file-log-uploader.js';

const directories: string[] = [];
const uploaders: ControlFileLogUploader[] = [];

afterEach(async () => {
  for (const uploader of uploaders.splice(0)) uploader.stop();
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp('/tmp/kilo2/control-file-logs-');
  directories.push(root);
  const homeRoot = path.join(root, 'homes');
  const directory = path.join(root, 'workspace');
  const env = buildWorktreeKiloEnvironment(directory, directoryHome(directory, homeRoot), {
    scopeId: 'scope_test',
    token: 'synthetic-runtime-token',
    targets: {
      backendBaseUrl: 'https://backend.example',
      providerBaseUrl: 'https://provider.example',
      sessionIngestBaseUrl: 'https://ingest.example',
    },
  });
  const nativeLogDir = path.join(env.XDG_DATA_HOME, 'kilo2', 'log');
  await mkdir(nativeLogDir, { recursive: true });
  const wrapperLogPath = path.join(root, 'kilocode-control-wrapper.log');
  await writeFile(wrapperLogPath, 'control-plane session started\n');
  return { root, homeRoot, nativeLogDir, wrapperLogPath, env };
}

async function extract(body: Buffer, root: string) {
  const destination = path.join(root, `extracted-${randomBytes(4).toString('hex')}`);
  await mkdir(destination);
  execFileSync('tar', ['xzf', '-', '-C', destination], { input: body });
  const entries = await readdir(destination, { recursive: true, withFileTypes: true });
  const files = new Map<string, Buffer>();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const filePath = path.join(entry.parentPath, entry.name);
    files.set(path.relative(destination, filePath), await readFile(filePath));
  }
  return files;
}

describe('control-plane file log archive', () => {
  it.each(['completed', 'completion_unconfirmed'] as const)(
    'retains the native log after a control-plane session run with outcome %s',
    async result => {
      const files = await fixture();
      const frames: ControlPlaneWrapperFrame[] = [];
      let body = Buffer.alloc(0);
      let feed: { source: KiloEventFeedSource; callbacks: KiloFeedCallbacks } | undefined;
      const outcome = Promise.withResolvers<void>();
      const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        async fetch(request) {
          const url = new URL(request.url);
          if (request.method === 'PUT' && url.pathname === `/logs/${CONTROL_LOG_ARCHIVE_NAME}`) {
            body = Buffer.from(await request.arrayBuffer());
            return new Response(null, { status: 204 });
          }
          if (url.pathname.endsWith('/prompt_async')) {
            await writeFile(
              path.join(files.nativeLogDir, 'opencode.log'),
              `${'older native log\n'.repeat(80_000)}Authorization: Bearer synthetic-session-secret\nsession=ses_test native hold released\n`
            );
            queueMicrotask(() => {
              for (const type of ['session.turn.open', 'session.turn.close']) {
                feed?.callbacks.onEvent({
                  type,
                  properties: { sessionID: 'ses_test', reason: 'completed' },
                  directory: feed.source.directory,
                  nativeRuntimeId: feed.source.nativeRuntimeId,
                });
              }
            });
            return new Response(null, { status: 204 });
          }
          if (url.pathname.endsWith('/drain')) {
            if (result === 'completion_unconfirmed') return Response.json({ output: false });
            const body = (await request.json()) as { input: { sessionID: string; token: string } };
            feed?.callbacks.onEvent({
              type: 'session.drained',
              properties: body.input,
              directory: feed.source.directory,
              nativeRuntimeId: feed.source.nativeRuntimeId,
            });
            return Response.json({ output: true });
          }
          return new Response(null, { status: 404 });
        },
      });
      const host = createControlPlaneSessionHost({
        runtime: {
          timers: CONTROL_PLANE_TIMERS,
          pidfileDirectory: path.join(files.root, 'pids'),
          prepareFilesystem: async () => undefined,
          readProcessStartTime: () => undefined,
          readSnapshot: async () => [],
          spawnKilo: async () => ({
            pid: 10_000,
            url: server.url.toString(),
            authorization: 'Basic synthetic-auth',
            exited: new Promise<void>(() => {}),
            stop: async () => true,
          }),
          openFeed(source, callbacks) {
            feed = { source, callbacks };
            return {
              async open() {
                callbacks.onEvent({
                  type: 'server.connected',
                  properties: {},
                  nativeRuntimeId: source.nativeRuntimeId,
                });
              },
              close() {},
            };
          },
        },
        turn: {
          emit(frame) {
            frames.push(frame);
            if (frame.type === 'session.outcome') outcome.resolve();
          },
        },
        isPreparing: () => false,
      });
      const uploader = createControlFileLogUploader({
        uploadUrl: new URL('/logs', server.url).toString(),
        uploadGrant: 'synthetic-grant',
        wrapperLogPath: files.wrapperLogPath,
        homeRoots: [files.homeRoot],
      });
      uploaders.push(uploader);
      try {
        await host.runtimes.ensure({
          key: files.env.PWD,
          directory: files.env.PWD,
          env: files.env,
        });
        const runtime = host.runtimes.get(files.env.PWD);
        if (!runtime || !feed) throw new Error('Runtime did not start');
        runtime.client.drainSession = createKilo2Harness({
          server: feed.source.server,
          directory: files.env.PWD,
          lifecycle: createKilo2Lifecycle(),
        }).drainSession;
        host.turns.registerRoute({
          sessionId: 'workspace_test',
          kiloSessionId: 'ses_test',
          directory: files.env.PWD,
          attemptId: 'attempt_test',
        });
        host.turns.submit('workspace_test', {
          messageId: 'message_test',
          turn: { type: 'prompt', prompt: 'synthetic prompt' },
          agent: { mode: 'code', model: 'test/model' },
        });
        await Promise.race([
          outcome.promise,
          Bun.sleep(2_000).then(() => {
            throw new Error('Session outcome timed out');
          }),
        ]);
        expect(frames.filter(frame => frame.type === 'session.outcome')).toMatchObject([
          result === 'completed' ? { status: 'completed' } : { status: 'failed', reason: result },
        ]);
        await uploader.finalize();
        const archive = await extract(body, files.root);
        const native = archive.get(
          path.relative(files.homeRoot, path.join(files.nativeLogDir, 'opencode.log'))
        );
        expect(native).toBeDefined();
        expect(native?.toString()).toContain('session=ses_test native hold released');
        expect(native?.toString()).toContain('[TRUNCATED');
        expect(native?.byteLength).toBeLessThanOrEqual(1024 * 1024);
        expect(gunzipSync(body).includes('synthetic-session-secret')).toBe(false);
        expect(body.byteLength).toBeLessThanOrEqual(CONTROL_LOG_MAX_ARCHIVE_BYTES);
      } finally {
        host.turns.shutdown();
        await host.runtimes.shutdown();
        await server.stop(true);
      }
    }
  );

  it('uploads the session native log with wrapper logs, redaction, and truncation on finalization', async () => {
    const files = await fixture();
    const secrets = [
      'synthetic-bearer',
      'synthetic-cookie',
      'synthetic-password',
      'synthetic-api-key',
      'synthetic-signature',
      'synthetic-query-token',
    ];
    const diagnostic = 'session=ses_test drain pending hold=background-child\n';
    const sensitive = [
      `Authorization: Bearer ${secrets[0]}`,
      `Cookie: session=${secrets[1]}`,
      `https://user:${secrets[2]}@example.com/repo`,
      JSON.stringify({ apiKey: secrets[3], authorization: `Bearer ${secrets[0]}` }),
      `https://logs.example/artifact?X-Amz-Signature=${secrets[4]}&X-Amz-Credential=synthetic-credential`,
      `https://logs.example/artifact?token=${secrets[5]}`,
    ].join('\n');
    const log = `${'older runtime log\n'.repeat(80_000)}${sensitive}\n${diagnostic}`;
    await writeFile(path.join(files.nativeLogDir, 'opencode.log'), log);
    const requests: Array<{ url: string; init: RequestInit; body: Buffer }> = [];
    const uploader = createControlFileLogUploader({
      uploadUrl: 'https://control.example/sandbox-logs/sandbox/allocation/wrapper',
      uploadGrant: 'synthetic-upload-grant',
      homeRoots: [files.homeRoot],
      wrapperLogPath: files.wrapperLogPath,
      fetch: async (url, init) => {
        requests.push({
          url,
          init,
          body: Buffer.from(await new Response(init.body).arrayBuffer()),
        });
        return new Response(null, { status: 204 });
      },
    });
    uploaders.push(uploader);

    uploader.start(60_000);
    await uploader.finalize();

    const request = requests.at(-1);
    expect(request).toBeDefined();
    if (!request) throw new Error('Expected a retained archive');
    expect(request.url).toEndWith(`/${CONTROL_LOG_ARCHIVE_NAME}`);
    expect(request.init.method).toBe('PUT');
    expect(request.init.redirect).toBe('error');
    expect(request.body.byteLength).toBeLessThanOrEqual(CONTROL_LOG_MAX_ARCHIVE_BYTES);
    const archive = await extract(request.body, files.root);
    const nativeName = path.relative(files.homeRoot, path.join(files.nativeLogDir, 'opencode.log'));
    const native = archive.get(nativeName);
    expect(native).toBeDefined();
    expect(native?.byteLength).toBeLessThanOrEqual(1024 * 1024);
    expect(native?.toString()).toContain(diagnostic);
    expect(native?.toString()).toContain('[TRUNCATED');
    expect(archive.get('kilocode-control-wrapper.log')?.toString()).toBe(
      'control-plane session started\n'
    );
    for (const secret of [...secrets, 'synthetic-credential']) {
      expect(gunzipSync(request.body).includes(secret)).toBe(false);
    }
    expect(await readFile(path.join(files.nativeLogDir, 'opencode.log'), 'utf8')).toBe(log);
  });

  it('bounds total retained bytes and marks omitted logs without losing the wrapper or latest native log', async () => {
    const files = await fixture();
    const line = `${randomBytes(120).toString('hex')}\n`;
    for (let index = 0; index < 10; index++) {
      await writeFile(path.join(files.nativeLogDir, `${index}.log`), line.repeat(5_000));
    }
    await writeFile(path.join(files.nativeLogDir, 'latest.log'), 'latest native drain evidence\n');
    const newest = new Date('2030-01-01T00:00:00Z');
    await utimes(path.join(files.nativeLogDir, 'latest.log'), newest, newest);
    let body = Buffer.alloc(0);
    const uploader = createControlFileLogUploader({
      uploadUrl: 'https://control.example/logs',
      uploadGrant: 'synthetic-grant',
      wrapperLogPath: files.wrapperLogPath,
      homeRoots: [files.homeRoot],
      fetch: async (_url, init) => {
        body = Buffer.from(await new Response(init.body).arrayBuffer());
        return new Response(null, { status: 204 });
      },
    });
    uploaders.push(uploader);
    await uploader.uploadNow();

    expect(body.byteLength).toBeGreaterThan(0);
    expect(body.byteLength).toBeLessThanOrEqual(CONTROL_LOG_MAX_ARCHIVE_BYTES);
    expect(gunzipSync(body).byteLength).toBeLessThan(CONTROL_LOG_MAX_ARCHIVE_BYTES);
    const archive = await extract(body, files.root);
    expect(archive.get('kilocode-control-wrapper.log')?.toString()).toContain('session started');
    expect(
      [...archive.values()].some(value => value.includes('latest native drain evidence'))
    ).toBe(true);
    expect([...archive.values()].some(value => value.includes('[TRUNCATED'))).toBe(true);
    expect(
      [...archive.values()].reduce((sum, value) => sum + value.byteLength, 0)
    ).toBeLessThanOrEqual(4 * 1024 * 1024);
    for (const value of archive.values()) expect(value.byteLength).toBeLessThanOrEqual(1024 * 1024);
  });

  it('keeps v1 logs and ignores missing paths, symlinks, and files outside log directories', async () => {
    const files = await fixture();
    const v1 = path.join(files.env.XDG_DATA_HOME, 'kilo', 'log');
    await mkdir(v1, { recursive: true });
    await writeFile(path.join(v1, 'kilo.log'), 'v1 runtime log\n');
    await writeFile(path.join(files.nativeLogDir, '..', 'auth.json'), 'never archive auth');
    await symlink(
      path.join(files.nativeLogDir, '..', 'auth.json'),
      path.join(files.nativeLogDir, 'link.log')
    );
    let body = Buffer.alloc(0);
    const uploader = createControlFileLogUploader({
      uploadUrl: 'https://control.example/logs',
      uploadGrant: 'synthetic-grant',
      wrapperLogPath: files.wrapperLogPath,
      homeRoots: [path.join(files.root, 'absent'), files.homeRoot],
      fetch: async (_url, init) => {
        body = Buffer.from(await new Response(init.body).arrayBuffer());
        return new Response(null, { status: 204 });
      },
    });
    uploaders.push(uploader);
    await uploader.uploadNow();
    const archive = await extract(body, files.root);
    expect([...archive.keys()].some(name => name.endsWith('/kilo/log/kilo.log'))).toBe(true);
    expect(gunzipSync(body).includes('never archive auth')).toBe(false);
  });

  it('redacts known launch secrets before truncation and drops oversized partial lines', async () => {
    const files = await fixture();
    const environment: Record<string, string> = {
      CONTROL_LOG_UPLOAD_GRANT: 'synthetic-opaque-secret',
    };
    const largeLine = `${'x'.repeat(2 * 1024 * 1024)}partial-sensitive-suffix\n`;
    await writeFile(
      path.join(files.nativeLogDir, 'opencode.log'),
      `${largeLine}safe native line\n`
    );
    await writeFile(files.wrapperLogPath, 'unlabeled synthetic-opaque-secret\n');
    let body = Buffer.alloc(0);
    const uploader = createControlFileLogUploader({
      uploadUrl: 'https://control.example/logs',
      uploadGrant: environment.CONTROL_LOG_UPLOAD_GRANT,
      environment,
      wrapperLogPath: files.wrapperLogPath,
      homeRoots: [files.homeRoot],
      fetch: async (_url, init) => {
        body = Buffer.from(await new Response(init.body).arrayBuffer());
        return new Response(null, { status: 204 });
      },
    });
    uploaders.push(uploader);
    delete environment.CONTROL_LOG_UPLOAD_GRANT;
    await uploader.uploadNow();
    const archive = await extract(body, files.root);
    expect(archive.get('kilocode-control-wrapper.log')?.toString()).toBe('unlabeled [REDACTED]\n');
    const native = archive.get(
      path.relative(files.homeRoot, path.join(files.nativeLogDir, 'opencode.log'))
    );
    expect(native?.toString()).toContain('safe native line');
    expect(native?.toString()).toContain('[TRUNCATED');
    expect(gunzipSync(body).includes('partial-sensitive-suffix')).toBe(false);
  });

  it('bounds file count and still captures an oversized wrapper log', async () => {
    const files = await fixture();
    await writeFile(
      files.wrapperLogPath,
      `${'wrapper history\n'.repeat(80_000)}latest wrapper evidence\n`
    );
    for (let index = 0; index < 70; index++) {
      await writeFile(path.join(files.nativeLogDir, `${index}.log`), 'native evidence\n');
    }
    let body = Buffer.alloc(0);
    const uploader = createControlFileLogUploader({
      uploadUrl: 'https://control.example/logs',
      uploadGrant: 'synthetic-grant',
      wrapperLogPath: files.wrapperLogPath,
      homeRoots: [files.homeRoot],
      fetch: async (_url, init) => {
        body = Buffer.from(await new Response(init.body).arrayBuffer());
        return new Response(null, { status: 204 });
      },
    });
    uploaders.push(uploader);
    await uploader.uploadNow();
    const archive = await extract(body, files.root);
    expect(archive.size).toBe(65);
    expect(archive.get('TRUNCATED.txt')?.toString()).toContain('[TRUNCATED');
    const wrapper = archive.get('kilocode-control-wrapper.log');
    expect(wrapper?.toString()).toContain('latest wrapper evidence');
    expect(wrapper?.byteLength).toBeLessThanOrEqual(1024 * 1024);
    expect(body.byteLength).toBeLessThanOrEqual(CONTROL_LOG_MAX_ARCHIVE_BYTES);
  });

  it.each(['stop', 'finalize'] as const)(
    'keeps %s bounded when an upload ignores abort',
    async action => {
      const files = await fixture();
      const started = Promise.withResolvers<AbortSignal>();
      let requests = 0;
      const uploader = createControlFileLogUploader({
        uploadUrl: 'https://control.example/logs',
        uploadGrant: 'synthetic-grant',
        wrapperLogPath: files.wrapperLogPath,
        homeRoots: [files.homeRoot],
        fetch: async (_url, init) => {
          requests++;
          if (!init.signal) throw new Error('Missing abort signal');
          started.resolve(init.signal);
          return new Promise<Response>(() => {});
        },
      });
      uploaders.push(uploader);
      const upload = uploader.uploadNow();
      const signal = await started.promise;
      if (action === 'stop') uploader.stop();
      else await uploader.finalize(10);
      await upload;
      expect(signal.aborted).toBe(true);
      expect(requests).toBe(1);
      await uploader.uploadNow();
      expect(requests).toBe(1);
    }
  );
});
