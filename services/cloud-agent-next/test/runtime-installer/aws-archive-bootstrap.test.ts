import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { renderAwsArchiveRestore } from '../../src/sandbox-control/aws-archive-bootstrap.js';
import {
  awsArchiveBaseImage,
  awsEcsArchiveBaseImage,
  encodeAwsArchiveSnapshot,
  awsArchiveObjectKey,
} from '../../src/shared/aws-archive.js';
import { ECS_TEST_CONFIG } from '../fixtures/aws-ecs.js';
import { AWS_TEST_CONFIGURATION } from '../fixtures/aws-provider.js';
import { ROOTFS_ARCHIVE_PYTHON } from '../../src/shared/rootfs-archive-python.js';
import {
  rootfsArchiveConfiguration,
  rootfsArchiveDescriptorSchema,
} from '../../src/shared/rootfs-archive.js';
import type { RootfsArchiveDescriptor } from '../../src/shared/rootfs-archive.js';

const exec = promisify(execFile);
const host = 'customer-artifacts.s3.us-east-1.amazonaws.com';
const connectionId = '11111111-1111-4111-8111-111111111111';
const identity = {
  format: 1 as const,
  captureId: '22222222-2222-4222-8222-222222222222',
  environmentId: '33333333-3333-4333-8333-333333333333',
  buildId: '44444444-4444-4444-8444-444444444444',
  allocationId: '55555555-5555-4555-8555-555555555555',
};
// Opt-in: CI does not run these cases. They need Linux, root (the HTTPS fixture listens on port 443),
// /usr/local/bin/node, /usr/bin/python3, openssl and a hosts entry that maps the bucket host above to 127.0.0.1 (docs/aws-byoc.md).
const enabled = process.platform === 'linux' && process.env.KILO_AWS_ARCHIVE_BOOTSTRAP_TEST === '1';
for (const provider of ['aws', 'aws-ecs'] as const) {
  const target =
    provider === 'aws'
      ? { provider, configuration: AWS_TEST_CONFIGURATION }
      : { provider, configuration: ECS_TEST_CONFIG };
  const baseImage =
    provider === 'aws'
      ? awsArchiveBaseImage(connectionId, AWS_TEST_CONFIGURATION)
      : awsEcsArchiveBaseImage(connectionId, ECS_TEST_CONFIG);
  function command(
    root: string,
    descriptor: RootfsArchiveDescriptor,
    deadlineAt = Date.now() + 30_000
  ) {
    return renderAwsArchiveRestore({
      snapshotId: encodeAwsArchiveSnapshot({ ...identity, archive: descriptor }),
      connectionId,
      ...target,
      downloadUrl: `https://${host}/${awsArchiveObjectKey(identity)}?synthetic-signature=fixture`,
      reportUrl: `https://${host}/startup-failure`,
      workerUrl: `https://${host}`,
      allocationId: identity.allocationId,
      deadlineAt,
      filesystemRoot: root,
      command: {
        argv: [
          '/usr/local/bin/node',
          '-e',
          'const fs=require("node:fs"); const cp=require("node:child_process"); fs.writeFileSync(process.argv[1],cp.execFileSync(process.argv[2]));',
          join(root, 'runtime-started'),
          join(root, 'usr/bin/prepared-tool'),
        ],
      },
    });
  }
  async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), 'aws-bootstrap-test-'));
    const root = join(directory, 'source');
    const restored = join(directory, 'restored');
    await mkdir(join(root, 'usr/bin'), { recursive: true });
    await writeFile(join(root, 'base-marker'), 'original base');
    await cp(root, restored, { recursive: true });
    const baselinePath = join(directory, 'baseline.json');
    const archivePath = join(directory, 'environment.tar');
    const location = {
      root,
      baseImage,
      signal: AbortSignal.timeout(30_000),
      baselinePath,
      archivePath,
    };
    const executeArchive = (action: 'baseline' | 'capture') =>
      JSON.parse(
        execFileSync('/usr/bin/python3', ['-c', ROOTFS_ARCHIVE_PYTHON], {
          input: JSON.stringify({ ...rootfsArchiveConfiguration(), ...location, action }),
          encoding: 'utf8',
          env: Object.fromEntries([
            ['PATH', '/usr/local/bin:/usr/bin:/bin'],
            ['LANG', 'C.UTF-8'],
          ]) as NodeJS.ProcessEnv,
        })
      );
    executeArchive('baseline');
    await writeFile(join(root, 'usr/bin/prepared-tool'), '#!/bin/sh\nprintf prepared-tool-ready', {
      mode: 0o755,
    });
    await mkdir(join(root, 'home/worktree/.cache'), { recursive: true });
    await writeFile(join(root, 'home/worktree/.cache/fixture'), 'prepared cache');
    const descriptor = rootfsArchiveDescriptorSchema.parse(executeArchive('capture').result);
    let body: Buffer = await readFile(archivePath);
    const key = join(directory, 'tls.key');
    const certificate = join(directory, 'tls.pem');
    await exec(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        `/CN=${host}`,
        '-addext',
        `subjectAltName=DNS:${host}`,
        '-keyout',
        key,
        '-out',
        certificate,
      ],
      { timeout: 10_000 }
    );
    const reports: unknown[] = [];
    let gets = 0;
    let reportAttempts = 0;
    let stallDownload = false;
    let downloadStatus: number | undefined;
    let sendContentLength = true;
    const server = createServer(
      { key: await readFile(key), cert: await readFile(certificate) },
      async (request, response) => {
        if (request.method === 'POST' && request.url === '/startup-failure') {
          assert.equal(request.headers.authorization, 'Bearer synthetic-launch-credential');
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(Buffer.from(chunk));
          reports.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          reportAttempts++;
          response.writeHead(reportAttempts === 1 ? 503 : 204).end();
          return;
        }
        gets++;
        if (stallDownload) return;
        if (downloadStatus !== undefined) {
          response.writeHead(downloadStatus).end();
          return;
        }
        if (gets === 1) {
          response.writeHead(503).end();
          return;
        }
        response
          .writeHead(200, sendContentLength ? { 'content-length': body.length } : {})
          .end(body);
      }
    );
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(443, '0.0.0.0', resolve);
    });
    return {
      directory,
      restored,
      descriptor,
      reports,
      gets: () => gets,
      setBody: (value: Buffer) => {
        body = value;
      },
      setDownloadStatus(value?: number) {
        downloadStatus = value;
      },
      omitContentLength() {
        sendContentLength = false;
      },
      stallDownload() {
        stallDownload = true;
      },
      async run(
        expected = descriptor,
        options: { deadlineMs?: number; pythonSource?: string } = {}
      ) {
        const startup = command(restored, expected, Date.now() + (options.deadlineMs ?? 30_000));
        const argv = [...startup.argv];
        if (options.pythonSource) argv[argv.length - 1] = options.pythonSource;
        try {
          const result = await exec(argv[0], argv.slice(1), {
            timeout: 40_000,
            env: Object.fromEntries([
              ['PATH', '/usr/local/bin:/usr/bin:/bin'],
              ['NODE_EXTRA_CA_CERTS', certificate],
              ['SANDBOX_CONTROL_CREDENTIAL', 'synthetic-launch-credential'],
            ]) as NodeJS.ProcessEnv,
            maxBuffer: 32_768,
          });
          return { status: 0, stderr: result.stderr };
        } catch (error) {
          const value = error as NodeJS.ErrnoException & { stderr?: string };
          return { status: value.code, stderr: value.stderr ?? '' };
        }
      },
      async close() {
        await new Promise<void>((resolve, reject) =>
          server.close(error => (error ? reject(error) : resolve()))
        );
        await rm(directory, { recursive: true, force: true });
      },
    };
  }

  await test(
    `${provider}: the restore bootstrap runs prepared tools before the fresh runtime starts`,
    { skip: !enabled },
    async () => {
      const f = await fixture();
      try {
        assert.equal((await f.run()).status, 0);
        assert.equal(
          await readFile(join(f.restored, 'runtime-started'), 'utf8'),
          'prepared-tool-ready'
        );
        assert.equal(
          await readFile(join(f.restored, 'home/worktree/.cache/fixture'), 'utf8'),
          'prepared cache'
        );
        assert.equal(f.gets(), 2);
        assert.deepEqual(f.reports, []);
      } finally {
        await f.close();
      }
    }
  );
  await test(
    `${provider}: a wrong checksum reports the failure and never starts a fresh runtime`,
    { skip: !enabled },
    async () => {
      const f = await fixture();
      try {
        const result = await f.run({ ...f.descriptor, sha256: 'a'.repeat(64) });
        assert.equal(result.status, 78);
        assert.equal(await readFile(join(f.restored, 'base-marker'), 'utf8'), 'original base');
        assert.equal(await stat(join(f.restored, 'runtime-started')).catch(() => null), null);
        assert.deepEqual(
          f.reports,
          Array(2).fill({ allocationId: identity.allocationId, code: 'environment_restore_failed' })
        );
        assert.equal(result.stderr.includes('synthetic-signature'), false);
        assert.equal(result.stderr.includes('synthetic-launch-credential'), false);
      } finally {
        await f.close();
      }
    }
  );
  await test(
    `${provider}: an invalid archive reports the failure before destination mutation`,
    { skip: !enabled },
    async () => {
      const f = await fixture();
      try {
        const bytes = Buffer.from('invalid tar payload');
        f.setBody(bytes);
        const result = await f.run({
          ...f.descriptor,
          size: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        });
        assert.equal(result.status, 78);
        assert.equal(await readFile(join(f.restored, 'base-marker'), 'utf8'), 'original base');
        assert.equal(await stat(join(f.restored, 'usr/bin/prepared-tool')).catch(() => null), null);
        assert.equal(await stat(join(f.restored, 'runtime-started')).catch(() => null), null);
        assert.equal(f.reports.length, 2);
      } finally {
        await f.close();
      }
    }
  );

  await test(
    `${provider}: a stalled download stops at the deadline and reports the failure`,
    { skip: !enabled },
    async () => {
      const f = await fixture();
      try {
        f.stallDownload();
        const start = Date.now();
        const result = await f.run(f.descriptor, { deadlineMs: 2000 });
        assert.equal(result.status, 79);
        assert.ok(Date.now() - start < 5000);
        assert.equal(f.gets(), 1);
        assert.equal(await stat(join(f.restored, 'runtime-started')).catch(() => null), null);
        assert.deepEqual(
          f.reports,
          Array(2).fill({
            allocationId: identity.allocationId,
            code: 'environment_restore_unavailable',
          })
        );
      } finally {
        await f.close();
      }
    }
  );
  await test(
    `${provider}: a stalled restore terminates its Python child before reporting failure`,
    { skip: !enabled },
    async () => {
      const f = await fixture();
      try {
        const pidPath = join(f.directory, 'owned-python.pid');
        const source = `import os,time
open(${JSON.stringify(pidPath)},'w').write(str(os.getpid()))
time.sleep(120)`;
        const result = await f.run(f.descriptor, { deadlineMs: 2000, pythonSource: source });
        assert.equal(result.status, 79);
        const pid = Number(await readFile(pidPath, 'utf8'));
        assert.ok(Number.isInteger(pid) && pid > 0);
        assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
        assert.equal(await stat(join(f.restored, 'runtime-started')).catch(() => null), null);
        assert.deepEqual(
          f.reports,
          Array(2).fill({
            allocationId: identity.allocationId,
            code: 'environment_restore_unavailable',
          })
        );
      } finally {
        await f.close();
      }
    }
  );

  await test(
    `${provider}: an exhausted transport failure can retry the same archive without a rebuild`,
    { skip: !enabled },
    async () => {
      const f = await fixture();
      try {
        f.setDownloadStatus(503);
        const result = await f.run();
        assert.equal(result.status, 79);
        assert.equal(f.gets(), 3);
        assert.deepEqual(
          f.reports,
          Array(2).fill({
            allocationId: identity.allocationId,
            code: 'environment_restore_unavailable',
          })
        );
        assert.equal(await stat(join(f.restored, 'runtime-started')).catch(() => null), null);
        f.setDownloadStatus();
        assert.equal((await f.run()).status, 0);
        assert.equal(
          await readFile(join(f.restored, 'runtime-started'), 'utf8'),
          'prepared-tool-ready'
        );
        assert.equal(f.gets(), 4);
      } finally {
        await f.close();
      }
    }
  );

  await test(
    `${provider}: a missing archive requires a rebuild rather than repeated downloads`,
    { skip: !enabled },
    async () => {
      const f = await fixture();
      try {
        f.setDownloadStatus(404);
        assert.equal((await f.run()).status, 78);
        assert.equal(f.gets(), 1);
        assert.deepEqual(
          f.reports,
          Array(2).fill({ allocationId: identity.allocationId, code: 'environment_restore_failed' })
        );
        assert.equal(await stat(join(f.restored, 'runtime-started')).catch(() => null), null);
      } finally {
        await f.close();
      }
    }
  );

  await test(
    `${provider}: an oversized chunked archive preserves the invalid-archive failure category`,
    { skip: !enabled },
    async () => {
      const f = await fixture();
      try {
        f.omitContentLength();
        f.setBody(Buffer.alloc(f.descriptor.size + 1));
        assert.equal((await f.run()).status, 78);
        // The first fixture response is transient; the oversized response must not retry.
        assert.equal(f.gets(), 2);
        assert.deepEqual(
          f.reports,
          Array(2).fill({ allocationId: identity.allocationId, code: 'environment_restore_failed' })
        );
        assert.equal(await stat(join(f.restored, 'runtime-started')).catch(() => null), null);
      } finally {
        await f.close();
      }
    }
  );
}
