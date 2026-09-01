import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createLogArchiveId, createLogUploader, type LogUploader } from './log-uploader';

const originalFetch = globalThis.fetch;
const originalLogPath = process.env.WRAPPER_LOG_PATH;
const temporaryDirectories: string[] = [];
const uploaders: LogUploader[] = [];

async function createFixture() {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'log-uploader-test-'));
  temporaryDirectories.push(directory);
  const cliLogDir = path.join(directory, 'cli-logs');
  const wrapperLogPath = path.join(directory, 'wrapper.log');
  await fsp.mkdir(cliLogDir);
  await fsp.writeFile(path.join(cliLogDir, 'kilo.log'), 'kilo log');
  await fsp.writeFile(wrapperLogPath, 'wrapper log\n');
  process.env.WRAPPER_LOG_PATH = wrapperLogPath;
  return { cliLogDir, wrapperLogPath };
}

function createUploader(
  files: { cliLogDir: string; wrapperLogPath: string },
  archiveId = createLogArchiveId('run_1')
): LogUploader {
  const uploader = createLogUploader({
    archiveId,
    context: {
      workerBaseUrl: 'https://worker.example.com',
      kiloSessionId: 'kilo-session',
      workerAuthToken: 'kka1.opaque',
    },
    sessionId: 'agent-session',
    userId: 'user',
    ...files,
  });
  uploaders.push(uploader);
  return uploader;
}

function mockFetch(handler: (url: URL, init: RequestInit) => Promise<Response>): void {
  globalThis.fetch = Object.assign(
    (input: string | URL | Request, init?: RequestInit) =>
      handler(new URL(input instanceof Request ? input.url : input.toString()), init ?? {}),
    { preconnect: originalFetch.preconnect }
  );
}

async function readArchive(init: RequestInit): Promise<string> {
  const bytes = await new Response(init.body).arrayBuffer();
  return gunzipSync(bytes).toString();
}

afterEach(async () => {
  for (const uploader of uploaders.splice(0)) uploader.stop();
  globalThis.fetch = originalFetch;
  if (originalLogPath === undefined) delete process.env.WRAPPER_LOG_PATH;
  else process.env.WRAPPER_LOG_PATH = originalLogPath;
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(directory => fsp.rm(directory, { recursive: true, force: true }))
  );
});

describe('createLogUploader', () => {
  it('settles an active upload when stopped even if fetch ignores abort', async () => {
    const files = await createFixture();
    const requestStarted = Promise.withResolvers<AbortSignal>();
    mockFetch(async (_url, init) => {
      if (!init.signal) throw new Error('Expected upload signal');
      requestStarted.resolve(init.signal);
      return new Promise<Response>(() => {});
    });
    const uploader = createUploader(files);

    const upload = uploader.uploadNow();
    const requestSignal = await requestStarted.promise;
    uploader.stop();
    const settled = await Promise.race([upload.then(() => true), Bun.sleep(100).then(() => false)]);

    expect(requestSignal.aborted).toBe(true);
    expect(settled).toBe(true);
  });

  it('preserves the upload route, filename, Kilo session query and opaque credential', async () => {
    const files = await createFixture();
    let capturedUrl: URL | undefined;
    let capturedInit: RequestInit | undefined;
    let capturedArchive: string | undefined;
    mockFetch(async (url, init) => {
      capturedUrl = url;
      capturedInit = init;
      capturedArchive = await readArchive(init);
      return new Response(null, { status: 204 });
    });
    const uploader = createLogUploader({
      archiveId: 'run_1--nonce',
      context: {
        workerBaseUrl: 'https://worker.example.com',
        kiloSessionId: 'kilo/session?one',
        workerAuthToken: 'kka1.opaque',
      },
      sessionId: 'agent/session',
      userId: 'user@example.com',
      ...files,
    });
    uploaders.push(uploader);

    await uploader.uploadNow();

    expect(capturedUrl?.pathname).toBe(
      '/sessions/user%40example.com/agent%2Fsession/logs/run_1--nonce/logs.tar.gz'
    );
    expect(capturedUrl?.searchParams.get('kiloSessionId')).toBe('kilo/session?one');
    expect(new Headers(capturedInit?.headers).get('Authorization')).toBe('Bearer kka1.opaque');
    expect(capturedInit?.body).toBeInstanceOf(ReadableStream);
    expect(capturedArchive).toContain('wrapper log');
    expect(fs.existsSync(files.wrapperLogPath)).toBe(true);
  });

  it('retains an earlier archive when a later wrapper uses the same run and session IDs', async () => {
    const files = await createFixture();
    const archives = new Map<string, string>();
    mockFetch(async (url, init) => {
      archives.set(url.pathname, await readArchive(init));
      return new Response(null, { status: 204 });
    });
    const first = createUploader(files);
    await fsp.appendFile(files.wrapperLogPath, 'original failed bootstrap\n');
    await first.finalize();
    const firstPath = `/sessions/user/agent-session/logs/${first.archiveId}/logs.tar.gz`;
    const firstArchive = archives.get(firstPath);

    await fsp.writeFile(files.wrapperLogPath, 'later successful bootstrap\n');
    const second = createUploader(files);
    await second.uploadNow();
    await second.uploadNow();

    expect(second.archiveId).not.toBe(first.archiveId);
    expect(archives.size).toBe(2);
    expect(archives.get(firstPath)).toBe(firstArchive);
    expect(firstArchive).toContain('original failed bootstrap');
    expect(firstArchive).not.toContain('later successful bootstrap');
    expect(
      archives.get(`/sessions/user/agent-session/logs/${second.archiveId}/logs.tar.gz`)
    ).toContain('later successful bootstrap');
  });

  it('refreshes the complete upload context without changing the archive', async () => {
    const files = await createFixture();
    const captured: Array<{ url: URL; authorization: string | null }> = [];
    mockFetch(async (url, init) => {
      captured.push({ url, authorization: new Headers(init.headers).get('Authorization') });
      await readArchive(init);
      return new Response(null, { status: 204 });
    });
    const uploader = createUploader(files);
    await uploader.uploadNow();
    uploader.updateContext({
      workerBaseUrl: 'https://refreshed.example.com',
      kiloSessionId: 'kilo-session-refreshed',
      workerAuthToken: 'kka1.refreshed-ticket',
    });
    await uploader.uploadNow();

    expect(captured).toHaveLength(2);
    expect(captured[1]?.url.pathname).toBe(captured[0]?.url.pathname);
    expect(captured[1]?.url.origin).toBe('https://refreshed.example.com');
    expect(captured[1]?.url.searchParams.get('kiloSessionId')).toBe('kilo-session-refreshed');
    expect(captured.map(upload => upload.authorization)).toEqual([
      'Bearer kka1.opaque',
      'Bearer kka1.refreshed-ticket',
    ]);
  });

  it.each(['uploadNow', 'finalize'] as const)(
    '%s waits for a periodic upload and then uploads a fresh final snapshot',
    async method => {
      const files = await createFixture();
      const periodicStarted = Promise.withResolvers<AbortSignal>();
      const releasePeriodic = Promise.withResolvers<void>();
      const captured: Array<{ url: URL; authorization: string | null; archive: string }> = [];
      mockFetch(async (url, init) => {
        const archive = await readArchive(init);
        captured.push({
          url,
          authorization: new Headers(init.headers).get('Authorization'),
          archive,
        });
        if (captured.length === 1) {
          if (!init.signal) throw new Error('Expected upload signal');
          periodicStarted.resolve(init.signal);
          await releasePeriodic.promise;
        }
        return new Response(null, { status: 204 });
      });
      const uploader = createUploader(files);
      uploader.start(5);
      const periodicSignal = await periodicStarted.promise;
      await fsp.appendFile(files.wrapperLogPath, 'final failure evidence\n');
      uploader.updateContext({
        workerBaseUrl: 'https://refreshed.example.com',
        kiloSessionId: 'kilo-session-refreshed',
        workerAuthToken: 'kka1.refreshed-ticket',
      });
      let settled = false;
      const finalUpload = uploader[method]().then(() => {
        settled = true;
        uploader.stop();
      });
      uploader.updateContext({
        workerBaseUrl: 'https://later.example.com',
        kiloSessionId: 'kilo-session-later',
        workerAuthToken: 'kka1.later-ticket',
      });
      await Bun.sleep(20);
      expect(settled).toBe(false);
      expect(periodicSignal.aborted).toBe(false);
      expect(captured).toHaveLength(1);

      releasePeriodic.resolve();
      await finalUpload;
      await Bun.sleep(20);

      expect(captured).toHaveLength(2);
      expect(captured[0]?.archive).not.toContain('final failure evidence');
      expect(captured[1]?.archive).toContain('final failure evidence');
      expect(captured[1]?.url.pathname).toBe(captured[0]?.url.pathname);
      expect(captured[0]?.url.searchParams.get('kiloSessionId')).toBe('kilo-session');
      expect(captured[0]?.authorization).toBe('Bearer kka1.opaque');
      expect(captured[1]?.url.origin).toBe('https://refreshed.example.com');
      expect(captured[1]?.url.searchParams.get('kiloSessionId')).toBe('kilo-session-refreshed');
      expect(captured[1]?.authorization).toBe('Bearer kka1.refreshed-ticket');
    }
  );

  it('bounds finalization and cancels queued work when a periodic upload never settles', async () => {
    const files = await createFixture();
    const requestStarted = Promise.withResolvers<AbortSignal>();
    let fetchCalls = 0;
    mockFetch(async (_url, init) => {
      fetchCalls++;
      if (!init.signal) throw new Error('Expected upload signal');
      requestStarted.resolve(init.signal);
      return new Promise<Response>(() => {});
    });
    const uploader = createUploader(files);
    uploader.start(5);
    const requestSignal = await requestStarted.promise;
    const finalUpload = uploader.finalize(25);
    expect(uploader.finalize()).toBe(finalUpload);
    const settled = await Promise.race([
      finalUpload.then(() => true),
      Bun.sleep(250).then(() => false),
    ]);
    await Bun.sleep(20);

    expect(settled).toBe(true);
    expect(requestSignal.aborted).toBe(true);
    expect(fetchCalls).toBe(1);
  });

  it('swallows HTTP and fetch failures without logging credentials or getting stuck', async () => {
    const files = await createFixture();
    const secret = 'kka1.do-not-log-this-ticket';
    let fetchCalls = 0;
    mockFetch(async (_url, init) => {
      await readArchive(init);
      fetchCalls++;
      if (fetchCalls === 1) return new Response(null, { status: 403, statusText: secret });
      if (fetchCalls === 2) throw new Error(`Authorization: Bearer ${secret}`);
      return new Response(null, { status: 204 });
    });
    const uploader = createUploader(files);
    uploader.updateContext({
      workerBaseUrl: 'https://worker.example.com',
      kiloSessionId: 'kilo-session',
      workerAuthToken: secret,
    });

    expect(await uploader.uploadNow()).toBeUndefined();
    expect(await uploader.uploadNow()).toBeUndefined();
    expect(await uploader.finalize()).toBeUndefined();
    const logs = await fsp.readFile(files.wrapperLogPath, 'utf8');

    expect(fetchCalls).toBe(3);
    expect(logs).toContain('Log upload failed: 403');
    expect(logs).toContain('Log upload did not complete');
    expect(logs).not.toContain(secret);
    expect(logs).not.toContain('Authorization');
  });

  it('swallows setup failures and permits subsequent uploads', async () => {
    const files = await createFixture();
    let fetchCalls = 0;
    mockFetch(async (_url, init) => {
      fetchCalls++;
      await readArchive(init);
      return new Response(null, { status: 204 });
    });
    const uploader = createUploader(files);
    uploader.updateContext({
      workerBaseUrl: 'invalid URL kka1.secret',
      kiloSessionId: 'kilo-session',
      workerAuthToken: 'kka1.secret',
    });
    expect(await uploader.uploadNow()).toBeUndefined();
    uploader.updateContext({
      workerBaseUrl: 'https://worker.example.com',
      kiloSessionId: 'kilo-session',
      workerAuthToken: 'kka1.refreshed-ticket',
    });
    await uploader.uploadNow();

    expect(fetchCalls).toBe(1);
    expect(await fsp.readFile(files.wrapperLogPath, 'utf8')).not.toContain('kka1.secret');
  });
});
