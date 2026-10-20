import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { fixtureRuntime } from './fixtures.js';
import { renderRuntimeBootstrap } from '../../src/sandbox-control/runtime-bootstrap.js';
import { sha256, writeTarEntries, type PackagedRuntime } from '../../scripts/publish-runtime.js';

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const image = process.env.RUNTIME_INSTALLER_TEST_IMAGE ?? 'ca-runtime-installer-process:local';
const credential = 'local-test-wrapper-credential';
const allocationId = 'local-test-allocation';
let temporary: string;
let port: number;
let grant: string;
let objects = new Map<string, Uint8Array>();
let reports: Array<{ allocationId: string; code: string; authenticated: boolean }> = [];
let requests: string[] = [];
let responseMode: 'normal' | 'unauthorized' | 'missing' | 'corrupt' | 'stall' = 'normal';
let heldHash: string | undefined;
let releaseHeld: (() => void) | undefined;
let held = false;
const names = new Set<string>();

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname === '/startup-failed') {
    let body = '';
    for await (const chunk of request) {
      body += chunk;
      if (body.length > 1024) break;
    }
    const data = JSON.parse(body);
    reports.push({
      ...data,
      authenticated: request.headers.authorization === `Bearer ${credential}`,
    });
    response.writeHead(204);
    response.end();
    return;
  }
  const hash = url.pathname.split('/').at(-1) ?? '';
  requests.push(hash);
  if (hash === heldHash) {
    held = true;
    await new Promise<void>(resolve => {
      releaseHeld = resolve;
    });
  }
  if (responseMode === 'stall') {
    await new Promise<void>(resolve => setTimeout(resolve, 7000));
  }
  const bytes = objects.get(hash);
  if (responseMode === 'unauthorized' || request.headers.authorization !== `Bearer ${grant}`) {
    response.writeHead(401);
    response.end();
    return;
  }
  if (responseMode === 'missing' || !bytes) {
    response.writeHead(404);
    response.end();
    return;
  }
  const body =
    responseMode === 'corrupt'
      ? Uint8Array.from(bytes, (value, index) => (index === 0 ? value ^ 1 : value))
      : bytes;
  response.writeHead(200, {
    'Content-Type': 'application/zstd',
    'Content-Length': body.byteLength,
  });
  response.end(body);
});

before(async () => {
  if (!process.env.RUNTIME_INSTALLER_TEST_IMAGE) {
    const wrapper = spawnSync('pnpm', ['run', 'build:wrapper'], {
      cwd: serviceRoot,
      stdio: 'inherit',
    });
    assert.equal(wrapper.status, 0, 'wrapper build');
    const build = spawnSync(
      'docker',
      ['build', '--platform', 'linux/amd64', '-t', image, '-f', 'Dockerfile.containers', '.'],
      { cwd: serviceRoot, stdio: 'inherit' }
    );
    assert.equal(build.status, 0, 'Dockerfile.containers build');
  }
  await new Promise<void>(resolve => server.listen(0, '0.0.0.0', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  port = address.port;
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'ca-runtime-installer-'));
});

after(async () => {
  releaseHeld?.();
  for (const name of names) spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await fs.rm(temporary, { recursive: true, force: true });
});

async function setup() {
  const root = path.join(temporary, randomUUID());
  for (const child of ['platform', 'workspace', 'home/.config'])
    await fs.mkdir(path.join(root, child), { recursive: true });
  await fs.writeFile(path.join(root, 'workspace/user-file'), 'user-file');
  await fs.writeFile(path.join(root, 'home/.config/user.json'), '{"preference":"keep"}');
  await fs.mkdir(path.join(root, 'workspace/node_modules/user-tool'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'workspace/node_modules/user-tool/run'),
    '#!/bin/sh\nprintf dependency-kept\n',
    { mode: 0o755 }
  );
  grant = randomUUID();
  objects = new Map();
  reports = [];
  requests = [];
  responseMode = 'normal';
  heldHash = undefined;
  held = false;
  releaseHeld = undefined;
  return root;
}

function select(runtime: PackagedRuntime) {
  objects.set(runtime.cli.sha256, runtime.cli.bytes);
  objects.set(runtime.control.sha256, runtime.control.bytes);
}

function command(runtime: PackagedRuntime, deadlineAt = Date.now() + 30_000) {
  const origin = `http://host.docker.internal:${port}`;
  return renderRuntimeBootstrap({
    descriptor: JSON.stringify(runtime.descriptor),
    artifactBaseUrl: `${origin}/objects/`,
    reportUrl: `${origin}/startup-failed`,
    allocationId,
    grant,
    deadlineAt,
  });
}

function run(
  root: string,
  runtime: PackagedRuntime,
  options: { deadlineAt?: number; poison?: boolean } = {}
) {
  const name = `ca-runtime-installer-${randomUUID()}`;
  names.add(name);
  const args = [
    'run',
    '--rm',
    '--name',
    name,
    '--platform',
    'linux/amd64',
    ...(process.platform === 'linux' ? ['--add-host', 'host.docker.internal:host-gateway'] : []),
    '--mount',
    `type=bind,src=${path.join(root, 'platform')},dst=/opt/kilo-cloud`,
    '--mount',
    `type=bind,src=${path.join(root, 'workspace')},dst=/workspace/app`,
    '--mount',
    `type=bind,src=${path.join(root, 'home')},dst=/root`,
    '--env',
    `SANDBOX_CONTROL_CREDENTIAL=${credential}`,
    '--env',
    'SANDBOX_CONTROL_URL=ws://unused.local',
    ...(options.poison
      ? [
          '--env',
          'PATH=/workspace/app/poison',
          '--env',
          'NODE_OPTIONS=--require /workspace/app/poison.cjs',
          '--env',
          'BUN_OPTIONS=--preload /workspace/app/poison.cjs',
          '--env',
          'CONTROL_PLANE_WRAPPER_COMMAND=exit 99',
          '--env',
          'KILO_RUNTIME_CLI_PATH=/workspace/app/old-kilo',
        ]
      : []),
    '--entrypoint',
    '/bin/sh',
    image,
    ...command(runtime, options.deadlineAt).argv.slice(1),
  ];
  const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => {
    stdout += chunk;
  });
  child.stderr.on('data', chunk => {
    stderr += chunk;
  });
  const completed = new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      child.on('error', () => reject(new Error('Cannot start installer container')));
      child.on('exit', code => {
        names.delete(name);
        resolve({
          code,
          stdout: stdout.replaceAll(grant, '[redacted]'),
          stderr: stderr.replaceAll(grant, '[redacted]'),
        });
      });
    }
  );
  return { name, completed };
}

async function succeeds(
  root: string,
  runtime: PackagedRuntime,
  options: { poison?: boolean } = {}
) {
  select(runtime);
  const result = await run(root, runtime, options).completed;
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(await fs.readFile(path.join(root, 'workspace/observed.json'), 'utf8'));
}

async function fails(
  root: string,
  runtime: PackagedRuntime,
  expected: string,
  exit: number,
  options: { deadlineAt?: number } = {}
) {
  select(runtime);
  const result = await run(root, runtime, options).completed;
  assert.equal(result.code, exit, result.stderr);
  assert.deepEqual(reports, [{ allocationId, code: expected, authenticated: true }]);
  await assert.rejects(fs.access(path.join(root, 'workspace/starts-B')));
}

void test('fresh bootstrap selects the runtime and leaves user files, configuration and an executable dependency intact', async () => {
  const root = await setup();
  const runtime = await fixtureRuntime();
  const observed = await succeeds(root, runtime);
  assert.equal(observed.id, 'B');
  assert.deepEqual(observed.pid1.split('\0').filter(Boolean), [
    '/bin/sh',
    '/usr/local/bin/kilocode-control-plane-supervisor.sh',
  ]);
  assert.equal(await fs.readFile(path.join(root, 'workspace/user-file'), 'utf8'), 'user-file');
  assert.equal(
    await fs.readFile(path.join(root, 'home/.config/user.json'), 'utf8'),
    '{"preference":"keep"}'
  );
  const dependency = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '--platform',
      'linux/amd64',
      '--mount',
      `type=bind,src=${path.join(root, 'workspace')},dst=/workspace/app`,
      '--entrypoint',
      '/workspace/app/node_modules/user-tool/run',
      image,
    ],
    { encoding: 'utf8' }
  );
  assert.equal(dependency.stdout, 'dependency-kept');
  assert.equal(dependency.status, 0);
});

void test('restore-like A files never run again when B replaces the selected runtime; profiles cannot select A', async () => {
  const root = await setup();
  await succeeds(root, await fixtureRuntime('A'));
  await fs.writeFile(
    path.join(root, 'workspace/poison.cjs'),
    "require('node:fs').writeFileSync('/workspace/app/poisoned', 'yes')"
  );
  await fs.writeFile(path.join(root, 'home/.profile'), 'touch /workspace/app/poisoned\n');
  const observed = await succeeds(root, await fixtureRuntime('B'), { poison: true });
  assert.equal(observed.id, 'B');
  assert.equal(
    (await fs.readFile(path.join(root, 'workspace/starts-A'), 'utf8')).split('start').length - 1,
    1
  );
  await assert.rejects(fs.access(path.join(root, 'workspace/poisoned')));
  assert.equal(observed.env.SANDBOX_CONTROL_CREDENTIAL, credential);
  assert.equal(observed.env.NODE_OPTIONS, undefined);
});

void test('cached verified archives repair a changed extracted file through fresh extraction', async () => {
  const root = await setup();
  const runtime = await fixtureRuntime();
  const first = await succeeds(root, runtime);
  const relative = first.env.KILO_RUNTIME_CLI_PATH.replace('/opt/kilo-cloud/', '');
  await fs.writeFile(path.join(root, 'platform', relative), '#!/bin/sh\nexit 91\n');
  const count = requests.length;
  responseMode = 'unauthorized';
  const second = await succeeds(root, runtime);
  assert.equal(second.id, 'B');
  assert.notEqual(second.env.KILO_RUNTIME_CLI_PATH, first.env.KILO_RUNTIME_CLI_PATH);
  assert.equal(requests.length, count);
});

void test('after handoff the grant is absent from probe, supervisor, argv, retained processes and created platform files', async () => {
  const root = await setup();
  const observed = await succeeds(root, await fixtureRuntime());
  assert.equal(JSON.stringify(observed).includes(grant), false);
  assert.equal(
    (await fs.readFile(path.join(root, 'workspace/probe-env.json'), 'utf8')).includes(grant),
    false
  );
  async function inspect(directory: string): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await inspect(file);
      else if (entry.isFile())
        assert.equal((await fs.readFile(file)).includes(Buffer.from(grant)), false);
    }
  }
  await inspect(path.join(root, 'platform'));
});

for (const [mode, code, exit] of [
  ['unauthorized', 'artifact_unauthorized', 71],
  ['missing', 'artifact_unavailable', 70],
  ['corrupt', 'artifact_invalid', 73],
] as const) {
  void test(`${mode} artifacts report once and never run a captured runtime`, async () => {
    const root = await setup();
    await succeeds(root, await fixtureRuntime('A'));
    responseMode = mode;
    await fails(root, await fixtureRuntime('B'), code, exit);
    assert.equal(
      (await fs.readFile(path.join(root, 'workspace/starts-A'), 'utf8')).split('start').length - 1,
      1
    );
  });
}

void test('incompatible base, failed CLI probe and missing supervisor have specific reports', async () => {
  for (const variant of ['base', 'probe', 'supervisor'] as const) {
    const root = await setup();
    const runtime = await fixtureRuntime('B', 'B', {
      probeFailure: variant === 'probe',
      missingSupervisor: variant === 'supervisor',
    });
    if (variant === 'base') runtime.descriptor.platform.arch = 'arm64';
    await fails(
      root,
      runtime,
      variant === 'base'
        ? 'base_incompatible'
        : variant === 'probe'
          ? 'cli_probe_failed'
          : 'supervisor_missing',
      variant === 'base' ? 72 : variant === 'probe' ? 76 : 77
    );
  }
});

void test('an absolute install deadline bounds an unavailable artifact and reports the deadline', async () => {
  const root = await setup();
  responseMode = 'stall';
  await fails(root, await fixtureRuntime(), 'deadline_exceeded', 75, {
    deadlineAt: Date.now() + 5000,
  });
});

void test('archive traversal and link entries cannot change a user sentinel', async () => {
  for (const variant of ['traversal', 'symlink'] as const) {
    const root = await setup();
    const runtime = await fixtureRuntime();
    const tar = writeTarEntries([
      {
        path: variant === 'traversal' ? '../outside' : 'escape',
        mode: 0o755,
        bytes: Buffer.from('wrong'),
      },
    ]);
    if (variant === 'symlink') {
      tar[156] = 50;
      tar.set(Buffer.from('/workspace/app/user-file'), 157);
      tar.fill(0, 148, 156);
      tar.fill(32, 148, 156);
      const checksum = tar.subarray(0, 512).reduce((sum, byte) => sum + byte, 0);
      tar.set(Buffer.from(checksum.toString(8).padStart(7, '0') + '\0'), 148);
    }
    const bytes = zstdCompressSync(tar);
    runtime.cli = { sha256: sha256(bytes), bytes };
    runtime.descriptor.artifacts[0] = {
      role: 'cli',
      sha256: runtime.cli.sha256,
      transferBytes: bytes.byteLength,
      expandedBytes: 5,
      fileCount: 1,
    };
    runtime.descriptor.inventory[0] = [
      'cli',
      'package/bin/kilo',
      0o755,
      5,
      sha256(Buffer.from('wrong')),
    ];
    await fails(root, runtime, 'artifact_invalid', 73);
    assert.equal(await fs.readFile(path.join(root, 'workspace/user-file'), 'utf8'), 'user-file');
    await assert.rejects(fs.access(path.join(root, 'platform/outside')));
  }
});

void test('a restored symlink in a platform directory cannot redirect extraction', async () => {
  const root = await setup();
  await fs.symlink('/workspace/app', path.join(root, 'platform/cli'));
  await fails(root, await fixtureRuntime(), 'artifact_invalid', 73);
  assert.equal(await fs.readFile(path.join(root, 'workspace/user-file'), 'utf8'), 'user-file');
  assert.deepEqual(await fs.readdir(path.join(root, 'workspace/node_modules')), ['user-tool']);
});

async function waitHeld() {
  const end = Date.now() + 10_000;
  while (!held && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(held, true, 'installer reached the held payload');
}

void test('an interrupted install keeps the complete old active release and the next start succeeds', async () => {
  const root = await setup();
  await succeeds(root, await fixtureRuntime('A'));
  const active = await fs.readlink(path.join(root, 'platform/active'));
  const runtime = await fixtureRuntime();
  select(runtime);
  heldHash = runtime.control.sha256;
  const pending = run(root, runtime);
  await waitHeld();
  spawnSync('docker', ['stop', '--time', '0', pending.name], { stdio: 'ignore' });
  await pending.completed;
  assert.equal(await fs.readlink(path.join(root, 'platform/active')), active);
  releaseHeld?.();
  heldHash = undefined;
  const observed = await succeeds(root, runtime);
  assert.equal(observed.id, 'B');
});

void test('concurrent setup is excluded while the first installer owns the lock', async () => {
  const root = await setup();
  const runtime = await fixtureRuntime();
  select(runtime);
  heldHash = runtime.control.sha256;
  const pending = run(root, runtime);
  await waitHeld();
  const invocation = command(runtime).argv;
  const second = spawn(
    'docker',
    ['exec', '--env', `SANDBOX_CONTROL_CREDENTIAL=${credential}`, pending.name, ...invocation],
    { stdio: ['ignore', 'ignore', 'ignore'] }
  );
  const code = await new Promise<number | null>(resolve => second.on('exit', resolve));
  assert.equal(code, 74);
  assert.deepEqual(reports, [{ allocationId, code: 'install_interrupted', authenticated: true }]);
  releaseHeld?.();
  heldHash = undefined;
  const result = await pending.completed;
  assert.equal(result.code, 0, result.stderr);
});

void test('the setup lock stays held by the supervisor and protects files used by its processes', async () => {
  const root = await setup();
  const runtime = await fixtureRuntime('B', 'B', { holdSupervisor: true });
  select(runtime);
  const pending = run(root, runtime);
  const end = Date.now() + 10_000;
  let observed;
  while (Date.now() < end) {
    try {
      observed = JSON.parse(await fs.readFile(path.join(root, 'workspace/observed.json'), 'utf8'));
      break;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  assert.ok(observed, 'the selected wrapper ran');
  const active = await fs.readlink(path.join(root, 'platform/active'));
  const next = await fixtureRuntime('A');
  const invocation = command(next).argv;
  const second = spawn(
    'docker',
    ['exec', '--env', `SANDBOX_CONTROL_CREDENTIAL=${credential}`, pending.name, ...invocation],
    { stdio: ['ignore', 'ignore', 'ignore'] }
  );
  const code = await new Promise<number | null>(resolve => second.on('exit', resolve));
  assert.equal(code, 74);
  assert.equal(await fs.readlink(path.join(root, 'platform/active')), active);
  await fs.access(
    path.join(root, 'platform', observed.env.KILO_RUNTIME_CLI_PATH.replace('/opt/kilo-cloud/', ''))
  );
  spawnSync('docker', ['stop', '--time', '0', pending.name], { stdio: 'ignore' });
  await pending.completed;
});

void test('the archive cache stays bounded across runtime changes and failed attempts', async () => {
  const root = await setup();
  await succeeds(root, await fixtureRuntime('A'));
  for (const id of ['B', 'C', 'D', 'E']) {
    await succeeds(root, await fixtureRuntime('B', id));
    const cache = await fs.readdir(path.join(root, 'platform/archives'));
    assert.ok(cache.length <= 4);
  }
  await fs.writeFile(
    path.join(root, 'platform/archives', '0'.repeat(64) + '.tar.zst.tmp-' + randomUUID()),
    'interrupted'
  );
  const bad = await fixtureRuntime('B', 'F', { missingSupervisor: true });
  // Successful B starts exist already; this case checks cache state, not that marker.
  select(bad);
  const result = await run(root, bad).completed;
  assert.equal(result.code, 77);
  const cache = await fs.readdir(path.join(root, 'platform/archives'));
  assert.ok(cache.length <= 4);
  assert.equal(
    cache.some(name => name.includes('.tmp-')),
    false
  );
});

void test('a corrupt cached archive is not reused and the authorized retry repairs it', async () => {
  const root = await setup();
  const runtime = await fixtureRuntime();
  await succeeds(root, runtime);
  const cached = path.join(root, 'platform/archives', runtime.cli.sha256 + '.tar.zst');
  const bytes = await fs.readFile(cached);
  bytes[0] ^= 1;
  await fs.writeFile(cached, bytes);
  responseMode = 'unauthorized';
  const failed = await run(root, runtime).completed;
  assert.equal(failed.code, 71);
  assert.deepEqual(reports, [{ allocationId, code: 'artifact_unauthorized', authenticated: true }]);
  assert.equal(
    (await fs.readFile(path.join(root, 'workspace/starts-B'), 'utf8')).split('start').length - 1,
    1
  );
  responseMode = 'normal';
  await succeeds(root, runtime);
  assert.equal(sha256(await fs.readFile(cached)), runtime.cli.sha256);
});

void test('a CLI that exits successfully with the wrong selected version fails its probe', async () => {
  const root = await setup();
  const runtime = await fixtureRuntime();
  runtime.descriptor.cliVersion = '9.9.9';
  await fails(root, runtime, 'cli_probe_failed', 76);
});

void test('a first-install alias failure leaves a complete active target for installed aliases', async () => {
  const root = await setup();
  await fs.mkdir(path.join(root, 'platform/kilo-git-credential'));
  const runtime = await fixtureRuntime();
  select(runtime);
  const result = await run(root, runtime).completed;
  assert.equal(result.code, 73);
  assert.deepEqual(reports, [{ allocationId, code: 'artifact_invalid', authenticated: true }]);
  const active = await fs.readlink(path.join(root, 'platform/active'));
  const release = active.replace('/opt/kilo-cloud', path.join(root, 'platform'));
  const control = (await fs.readlink(path.join(release, 'control'))).replace(
    '/opt/kilo-cloud',
    path.join(root, 'platform')
  );
  assert.equal(
    (await fs.stat(path.join(control, 'usr/local/bin/kilocode-control-plane-wrapper.js'))).isFile(),
    true
  );
});
