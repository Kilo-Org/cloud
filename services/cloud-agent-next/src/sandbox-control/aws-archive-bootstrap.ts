import type { AwsByocConfiguration } from '@kilocode/worker-utils/aws-byoc';
import {
  awsArchiveBaseImage,
  awsArchiveMatchesBase,
  awsArchiveObjectKey,
  decodeAwsArchiveSnapshot,
} from '../shared/aws-archive.js';
import { rootfsArchiveConfiguration } from '../shared/rootfs-archive.js';
import { ROOTFS_ARCHIVE_PYTHON } from '../shared/rootfs-archive-python.js';
import { STARTUP_FAILURES } from './startup-failure.js';
import type { ProviderStartupCommand } from './provider.js';

const RESTORE = String.raw`
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
const [serialized, python] = process.argv.slice(1);
const C = JSON.parse(serialized);
const signal = AbortSignal.timeout(Math.max(1, C.deadlineAt - Date.now()));
let scratch;
async function download(file) {
  for (let attempt = 0; attempt < 3; attempt++) {
    // Back off before a retry so a throttle or short S3 fault can clear within the deadline.
    if (attempt > 0) await delay(1000 * attempt, undefined, { signal }).catch(() => { throw new Error('download_failed'); });
    await fs.rm(file, { force: true });
    let response;
    try {
      response = await fetch(C.downloadUrl, { redirect: 'error', signal });
    } catch {
      if (attempt === 2 || signal.aborted) throw new Error('download_failed');
      continue;
    }
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel();
      if (attempt < 2 && (response.status === 408 || response.status === 429 || response.status >= 500)) continue;
      throw new Error(response.status === 404 ? 'archive_invalid' : 'download_failed');
    }
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) !== C.expected.size)) {
      await response.body.cancel();
      throw new Error('archive_invalid');
    }
    const hash = createHash('sha256');
    let bytes = 0;
    const bound = new Transform({ transform(chunk, encoding, done) {
      bytes += chunk.length;
      if (bytes > C.expected.size) return done(new Error('archive_invalid'));
      hash.update(chunk); done(null, chunk);
    }});
    try {
      await pipeline(Readable.fromWeb(response.body), bound, createWriteStream(file, { flags: 'wx', mode: 0o600 }), { signal });
    } catch (error) {
      if (bytes > C.expected.size) throw new Error('archive_invalid');
      if (attempt === 2 || signal.aborted) throw new Error('download_failed');
      continue;
    }
    if (bytes !== C.expected.size || hash.digest('hex') !== C.expected.sha256) throw new Error('archive_invalid');
    return;
  }
  throw new Error('download_failed');
}
async function restore(file) {
  await new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/python3', ['-c', python], {
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' },
      stdio: ['pipe', 'pipe', 'ignore'], signal,
    });
    let output = ''; let bytes = 0; let failed = false;
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 32768) { failed = true; child.kill('SIGTERM'); }
      else output += chunk.toString('utf8');
    });
    child.once('error', () => { failed = true; });
    child.stdin.on('error', () => { failed = true; child.kill('SIGTERM'); });
    child.once('close', code => {
      try {
        const reply = JSON.parse(output);
        if (!failed && code === 0 && reply.ok === true) return resolve();
        const invalid = ['invalid_archive', 'base_mismatch', 'limit_exceeded', 'unsupported_metadata'].includes(reply.code);
        reject(new Error(invalid ? 'archive_invalid' : 'restore_failed'));
      } catch { reject(new Error('restore_failed')); }
    });
    child.stdin.end(JSON.stringify({ ...C.archiveConfiguration, root: C.root, baseImage: C.expected.baseImage, action: 'restore', archivePath: file, expected: C.expected }));
  });
}
async function report(code) {
  for (let attempt = 0; attempt < 3; attempt++) {
    // The report often runs after the deadline, so its short backoff does not use the deadline signal.
    if (attempt > 0) await delay(250 * attempt);
    try {
      const response = await fetch(C.reportUrl, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(3000),
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + process.env.SANDBOX_CONTROL_CREDENTIAL },
        body: JSON.stringify({ allocationId: C.allocationId, code }),
      });
      await response.body?.cancel();
      if (response.ok || (response.status >= 400 && response.status < 500 && response.status !== 429)) return;
    } catch {}
  }
}
try {
  if (Date.now() >= C.deadlineAt) throw new Error('deadline');
  scratch = await fs.mkdtemp('/tmp/kilo-aws-restore-');
  const file = scratch + '/environment.tar';
  await download(file);
  await restore(file);
  await fs.rm(scratch, { recursive: true, force: true });
  scratch = undefined;
  if (signal.aborted) throw new Error('deadline');
} catch (error) {
  if (scratch) await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  const code = error?.message === 'archive_invalid' ? 'environment_restore_failed' : 'environment_restore_unavailable';
  await report(code);
  process.stderr.write('AWS environment restore failed\n');
  process.exit(C.failureExitCodes[code]);
}
const environment = Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined));
try { process.execve(C.argv[0], C.argv, environment); }
catch { await report('environment_restore_unavailable'); process.exit(C.failureExitCodes.environment_restore_unavailable); }
`;

/** Restore before the fresh runtime and credentials start. A failed restore never starts that command. */
export function renderAwsArchiveRestore(input: {
  snapshotId: string;
  connectionId: string;
  configuration: AwsByocConfiguration;
  downloadUrl: string;
  reportUrl: string;
  allocationId: string;
  deadlineAt: number;
  command: ProviderStartupCommand;
  /** Explicit so tests can use an isolated filesystem. Production always supplies '/'. */
  filesystemRoot: string;
}): ProviderStartupCommand {
  const snapshot = decodeAwsArchiveSnapshot(input.snapshotId);
  const baseImage = awsArchiveBaseImage(input.connectionId, input.configuration);
  if (!snapshot || !awsArchiveMatchesBase(snapshot, baseImage))
    throw new Error('AWS archive base is incompatible');
  const source = new URL(input.downloadUrl);
  const host = `${input.configuration.bucket}.s3.${input.configuration.region}.amazonaws.com`;
  const report = new URL(input.reportUrl);
  if (
    source.protocol !== 'https:' ||
    source.host !== host ||
    source.username ||
    source.password ||
    source.hash ||
    source.pathname !== '/' + awsArchiveObjectKey(snapshot) ||
    report.protocol !== 'https:' ||
    report.username ||
    report.password ||
    report.search ||
    report.hash ||
    !/^[0-9a-f-]{36}$/.test(input.allocationId) ||
    !Number.isSafeInteger(input.deadlineAt) ||
    !input.filesystemRoot.startsWith('/') ||
    input.command.argv.length === 0 ||
    !input.command.argv[0].startsWith('/')
  ) {
    throw new Error('Invalid AWS archive startup');
  }
  const configuration = {
    downloadUrl: source.href,
    reportUrl: report.href,
    allocationId: input.allocationId,
    deadlineAt: input.deadlineAt,
    root: input.filesystemRoot,
    expected: snapshot.archive,
    archiveConfiguration: rootfsArchiveConfiguration(),
    argv: input.command.argv,
    failureExitCodes: {
      environment_restore_failed: STARTUP_FAILURES.environment_restore_failed.exitCode,
      environment_restore_unavailable: STARTUP_FAILURES.environment_restore_unavailable.exitCode,
    },
  };
  const argv = [
    '/usr/local/bin/node',
    '--input-type=module',
    '-e',
    RESTORE,
    JSON.stringify(configuration),
    ROOTFS_ARCHIVE_PYTHON,
  ];
  if (argv.some(arg => new TextEncoder().encode(arg).byteLength >= 128 * 1024))
    throw new Error('AWS archive startup exceeds the argument limit');
  return { argv, user: 'root' };
}
