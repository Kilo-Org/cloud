import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLogUploader } from './log-uploader';

const originalFetch = globalThis.fetch;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(directory => fsp.rm(directory, { recursive: true, force: true }))
  );
});

describe('createLogUploader', () => {
  it('aborts an active upload when stopped', async () => {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'log-uploader-stop-test-'));
    temporaryDirectories.push(directory);
    const wrapperLogPath = path.join(directory, 'wrapper.log');
    await fsp.writeFile(wrapperLogPath, 'wrapper log');

    let requestSignal: AbortSignal | undefined;
    globalThis.fetch = Object.assign(
      async (_input: string | URL | Request, init?: RequestInit) => {
        requestSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          requestSignal?.addEventListener('abort', () => reject(requestSignal?.reason), {
            once: true,
          });
        });
      },
      { preconnect: originalFetch.preconnect }
    );
    const uploader = createLogUploader({
      workerBaseUrl: 'https://worker.example.com',
      sessionId: 'agent-session',
      getKiloSessionId: () => 'kilo-session',
      executionId: 'session',
      userId: 'user',
      getWorkerAuthToken: () => 'kka1.opaque',
      cliLogDir: path.join(directory, 'missing-cli-logs'),
      wrapperLogPath,
    });

    const upload = uploader.uploadNow();
    while (!requestSignal) await Bun.sleep(1);
    uploader.stop();
    const settled = await Promise.race([upload.then(() => true), Bun.sleep(100).then(() => false)]);

    expect(requestSignal.aborted).toBe(true);
    expect(settled).toBe(true);
  });

  it('binds log uploads to the Kilo session and sends the opaque worker credential', async () => {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'log-uploader-test-'));
    temporaryDirectories.push(directory);
    const cliLogDir = path.join(directory, 'cli-logs');
    const wrapperLogPath = path.join(directory, 'wrapper.log');
    await fsp.mkdir(cliLogDir);
    await fsp.writeFile(path.join(cliLogDir, 'kilo.log'), 'kilo log');
    await fsp.writeFile(wrapperLogPath, 'wrapper log');

    let capturedUrl: URL | undefined;
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        capturedUrl = new URL(input instanceof Request ? input.url : input.toString());
        capturedInit = init;
        return new Response(null, { status: 204 });
      },
      { preconnect: originalFetch.preconnect }
    );

    const uploader = createLogUploader({
      workerBaseUrl: 'https://worker.example.com',
      sessionId: 'agent/session',
      getKiloSessionId: () => 'kilo/session?one',
      executionId: 'session',
      userId: 'user@example.com',
      getWorkerAuthToken: () => 'kka1.opaque',
      cliLogDir,
      wrapperLogPath,
    });

    await uploader.uploadNow();

    expect(capturedUrl?.pathname).toBe(
      '/sessions/user%40example.com/agent%2Fsession/logs/session/logs.tar.gz'
    );
    expect(capturedUrl?.searchParams.get('kiloSessionId')).toBe('kilo/session?one');
    expect(new Headers(capturedInit?.headers).get('Authorization')).toBe('Bearer kka1.opaque');
    expect(capturedInit?.body).toBeInstanceOf(ReadableStream);
    expect(fs.existsSync(wrapperLogPath)).toBe(true);
  });

  it('reads the worker auth token fresh on every upload instead of a value captured at creation', async () => {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'log-uploader-refresh-test-'));
    temporaryDirectories.push(directory);
    const cliLogDir = path.join(directory, 'cli-logs');
    const wrapperLogPath = path.join(directory, 'wrapper.log');
    await fsp.mkdir(cliLogDir);
    await fsp.writeFile(path.join(cliLogDir, 'kilo.log'), 'kilo log');
    await fsp.writeFile(wrapperLogPath, 'wrapper log');

    const capturedAuthHeaders: Array<string | null> = [];
    globalThis.fetch = Object.assign(
      async (_input: string | URL | Request, init?: RequestInit) => {
        capturedAuthHeaders.push(new Headers(init?.headers).get('Authorization'));
        return new Response(null, { status: 204 });
      },
      { preconnect: originalFetch.preconnect }
    );

    let currentToken = 'kka1.first-ticket';
    const uploader = createLogUploader({
      workerBaseUrl: 'https://worker.example.com',
      sessionId: 'agent-session',
      getKiloSessionId: () => 'kilo-session',
      executionId: 'session',
      userId: 'user',
      getWorkerAuthToken: () => currentToken,
      cliLogDir,
      wrapperLogPath,
    });

    await uploader.uploadNow();
    currentToken = 'kka1.refreshed-ticket';
    await uploader.uploadNow();

    expect(capturedAuthHeaders).toEqual([
      'Bearer kka1.first-ticket',
      'Bearer kka1.refreshed-ticket',
    ]);
  });
});
