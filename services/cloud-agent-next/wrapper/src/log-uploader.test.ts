import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLogUploader } from './log-uploader';
import { getKiloImportDiagnosticPath } from './utils';

function asFetch(
  fn: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>
): typeof fetch {
  return Object.assign(fn, { preconnect: fetch.preconnect });
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

describe('createLogUploader', () => {
  let tmpDir: string;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'log-uploader-test-'));
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('uploads the import failure diagnostic in the authenticated R2 log archive', async () => {
    const cliLogDir = path.join(tmpDir, 'cli-logs');
    const wrapperLogPath = path.join(tmpDir, 'wrapper.log');
    const diagnosticPath = getKiloImportDiagnosticPath(wrapperLogPath);
    fs.mkdirSync(cliLogDir);
    fs.writeFileSync(path.join(cliLogDir, 'kilo.log'), 'cli log');
    fs.writeFileSync(wrapperLogPath, 'wrapper log');
    fs.writeFileSync(diagnosticPath, '{"version":1,"stderr":{"text":"schema failure"}}');

    const requests: Array<{ url: string; authorization: string | null; archive: Uint8Array }> = [];
    globalThis.fetch = asFetch(async (input, init) => {
      const body = init?.body;
      if (!(body instanceof ReadableStream)) throw new Error('Expected streaming archive body');
      requests.push({
        url: requestUrl(input),
        authorization: new Headers(init?.headers).get('Authorization'),
        archive: new Uint8Array(await new Response(body).arrayBuffer()),
      });
      return new Response(null, { status: 204 });
    });

    const uploader = createLogUploader({
      workerBaseUrl: 'https://worker.example',
      sessionId: 'agent_test',
      executionId: 'session',
      userId: 'user_test',
      workerAuthToken: 'worker-token',
      cliLogDir,
      wrapperLogPath,
    });
    await uploader.uploadNow();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      'https://worker.example/sessions/user_test/agent_test/logs/session/logs.tar.gz'
    );
    expect(requests[0]?.authorization).toBe('Bearer worker-token');

    const archivePath = path.join(tmpDir, 'logs.tar.gz');
    const extractDir = path.join(tmpDir, 'extracted');
    fs.writeFileSync(archivePath, requests[0]?.archive ?? new Uint8Array());
    fs.mkdirSync(extractDir);
    const extraction = Bun.spawnSync(['tar', 'xzf', archivePath, '-C', extractDir], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(extraction.exitCode).toBe(0);
    expect(fs.readFileSync(path.join(extractDir, path.basename(diagnosticPath)), 'utf8')).toContain(
      'schema failure'
    );
  });

  it('serializes final uploads into one bounded final archive key', async () => {
    const cliLogDir = path.join(tmpDir, 'cli-logs');
    const wrapperLogPath = path.join(tmpDir, 'wrapper.log');
    const diagnosticPath = getKiloImportDiagnosticPath(wrapperLogPath);
    fs.mkdirSync(cliLogDir);
    fs.writeFileSync(wrapperLogPath, 'wrapper log');

    const archives: Uint8Array[] = [];
    const requestUrls: string[] = [];
    const uploadOrder: string[] = [];
    let firstUploadSignal: AbortSignal | undefined;
    let releaseFirstResponse: (() => void) | undefined;
    const firstResponseGate = new Promise<void>(resolve => {
      releaseFirstResponse = resolve;
    });
    globalThis.fetch = asFetch(async (input, init) => {
      const body = init?.body;
      if (!(body instanceof ReadableStream)) throw new Error('Expected streaming archive body');
      requestUrls.push(requestUrl(input));
      const requestNumber = requestUrls.length;
      uploadOrder.push(`start-${requestNumber}`);
      archives.push(new Uint8Array(await new Response(body).arrayBuffer()));
      if (requestNumber === 1) {
        firstUploadSignal = init?.signal ?? undefined;
        await firstResponseGate;
      }
      uploadOrder.push(`settle-${requestNumber}`);
      return new Response(null, { status: 204 });
    });

    const uploader = createLogUploader({
      workerBaseUrl: 'https://worker.example',
      sessionId: 'agent_test',
      executionId: 'session',
      userId: 'user_test',
      workerAuthToken: 'worker-token',
      cliLogDir,
      wrapperLogPath,
    });
    const periodicUpload = uploader.uploadNow();
    while (requestUrls.length === 0) await Bun.sleep(1);

    fs.writeFileSync(diagnosticPath, '{"version":1,"stderr":{"text":"late failure"}}');
    const finalUpload = uploader.flushNow();
    await Promise.resolve();
    await Promise.resolve();
    const firstUploadWasAborted = firstUploadSignal?.aborted ?? false;
    const finalUploadStartedBeforeFirstSettled = requestUrls.length > 1;
    const release = releaseFirstResponse;
    if (!release) throw new Error('First upload did not start');
    release();
    await Promise.all([periodicUpload, finalUpload]);

    expect(firstUploadWasAborted).toBe(false);
    expect(finalUploadStartedBeforeFirstSettled).toBe(false);
    expect(uploadOrder).toEqual(['start-1', 'settle-1', 'start-2', 'settle-2']);
    expect(requestUrls[0]).toContain('/logs/session/logs.tar.gz');
    expect(requestUrls[1]).toContain('/logs/session-final/logs.tar.gz');

    await uploader.flushNow();

    expect(requestUrls[2]).toBe(requestUrls[1]);
    expect(new Set(requestUrls).size).toBe(2);
    expect(archives).toHaveLength(3);
    const archivePath = path.join(tmpDir, 'final-logs.tar.gz');
    const extractDir = path.join(tmpDir, 'final-extracted');
    fs.writeFileSync(archivePath, archives[1] ?? new Uint8Array());
    fs.mkdirSync(extractDir);
    const extraction = Bun.spawnSync(['tar', 'xzf', archivePath, '-C', extractDir], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(extraction.exitCode).toBe(0);
    expect(fs.readFileSync(path.join(extractDir, path.basename(diagnosticPath)), 'utf8')).toContain(
      'late failure'
    );
  });
});
