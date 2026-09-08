import { afterEach, describe, expect, it } from 'bun:test';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  createControlFileLogUploader,
  selectControlFileLogPaths,
  type ControlFileLogUploader,
} from './file-log-uploader';

const originalFetch = globalThis.fetch;
const temporaryDirectories: string[] = [];
const uploaders: ControlFileLogUploader[] = [];

async function createFixture() {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'control-file-logs-'));
  temporaryDirectories.push(directory);
  const homeRoot = path.join(directory, 'kilo-worktrees');
  const kiloLogDir = path.join(homeRoot, 'home-a', '.local', 'share', 'kilo', 'log');
  const wrapperLogPath = path.join(directory, 'kilocode-control-wrapper.log');
  await fsp.mkdir(kiloLogDir, { recursive: true });
  await fsp.writeFile(wrapperLogPath, 'wrapper log\n');
  await fsp.writeFile(path.join(kiloLogDir, 'kilo.log'), 'kilo log\n');
  return { directory, homeRoot, kiloLogDir, wrapperLogPath };
}

function createUploader(
  files: { homeRoot: string; wrapperLogPath: string },
  handler: (url: URL, init: RequestInit) => Promise<Response>
): ControlFileLogUploader {
  const uploader = createControlFileLogUploader({
    uploadUrl: 'https://worker.example.com/sandbox-logs/sandbox/allocation/wrapper',
    uploadGrant: 'test-upload-only-grant',
    wrapperLogPath: files.wrapperLogPath,
    homeRoot: files.homeRoot,
    fetch: (url, init) => handler(new URL(url), init),
  });
  uploaders.push(uploader);
  return uploader;
}

async function readArchive(init: RequestInit): Promise<string> {
  const bytes = await new Response(init.body).arrayBuffer();
  return gunzipSync(bytes).toString();
}

afterEach(async () => {
  for (const uploader of uploaders.splice(0)) uploader.stop();
  globalThis.fetch = originalFetch;
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(directory => fsp.rm(directory, { recursive: true, force: true }))
  );
});

describe('control file log uploader', () => {
  it('packs the wrapper log and kilo log dir and puts gzip', async () => {
    const files = await createFixture();
    let capturedUrl: URL | undefined;
    let capturedInit: RequestInit | undefined;
    let capturedArchive: string | undefined;
    const uploader = createUploader(files, async (url, init) => {
      capturedUrl = url;
      capturedInit = init;
      capturedArchive = await readArchive(init);
      return new Response(null, { status: 204 });
    });

    await uploader.uploadNow();

    expect(capturedUrl?.pathname).toBe('/sandbox-logs/sandbox/allocation/wrapper/files.tar.gz');
    expect(new Headers(capturedInit?.headers).get('Content-Type')).toBe('application/gzip');
    expect(new Headers(capturedInit?.headers).get('Authorization')).toBe(
      'Bearer test-upload-only-grant'
    );
    expect(capturedArchive).toContain('wrapper log');
    expect(capturedArchive).toContain('kilo log');
  });

  it('keeps shutdown from waiting on a failed upload', async () => {
    const files = await createFixture();
    const uploader = createUploader(files, async () => {
      throw new Error('upload failed');
    });
    const settled = await Promise.race([
      uploader.finalize(50).then(() => true),
      Bun.sleep(200).then(() => false),
    ]);
    expect(settled).toBe(true);
  });

  it('includes the wrapper log first, then newest kilo files until the cap', async () => {
    const files = await createFixture();
    await fsp.rm(path.join(files.kiloLogDir, 'kilo.log'));
    const older = path.join(files.kiloLogDir, 'older.log');
    const newest = path.join(files.kiloLogDir, 'newest.log');
    await fsp.writeFile(older, 'old');
    await fsp.writeFile(newest, 'new-content');
    const olderTime = new Date('2026-01-01T00:00:00Z');
    const newerTime = new Date('2026-01-02T00:00:00Z');
    await fsp.utimes(older, olderTime, olderTime);
    await fsp.utimes(newest, newerTime, newerTime);
    const wrapperSize = (await fsp.stat(files.wrapperLogPath)).size;
    const newestSize = (await fsp.stat(newest)).size;
    const selected = selectControlFileLogPaths({
      wrapperLogPath: files.wrapperLogPath,
      kiloLogDirs: [files.kiloLogDir],
      maxBytes: wrapperSize + newestSize,
    });
    expect(selected[0]).toBe(files.wrapperLogPath);
    expect(selected).toContain(newest);
    expect(selected).not.toContain(older);
  });
});
