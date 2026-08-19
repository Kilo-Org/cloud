import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  applyPortOffset,
  candidatePortOffsets,
  clearDevLogs,
  computePortOffset,
  getAlwaysOnGroupIds,
  getService,
  portOffset,
  readPersistedPortOffset,
  resolveGroups,
  resolveDeletionMockSessionEnv,
  resolveSessionNextAuthUrl,
  resolveTargets,
  writePersistedPortOffset,
} from './services';

test('uses an automatic port offset for secondary worktrees by default', () => {
  assert.equal(
    computePortOffset({ explicit: undefined, isPrimary: false, slug: 'mobile-context-info' }),
    1100
  );
});

test('never assigns default ports to a secondary worktree', () => {
  assert.equal(computePortOffset({ explicit: 'auto', isPrimary: false, slug: 'd' }), 5000);
});

test('keeps the primary worktree on the default ports', () => {
  assert.equal(computePortOffset({ explicit: undefined, isPrimary: true, slug: 'cloud' }), 0);
});

test('honors an explicit port offset', () => {
  assert.equal(computePortOffset({ explicit: '1200', isPrimary: false, slug: 'anything' }), 1200);
});

test('prefers the persisted manifest offset over the slug hash', () => {
  assert.equal(
    computePortOffset({
      explicit: undefined,
      persisted: 700,
      isPrimary: false,
      slug: 'mobile-context-info',
    }),
    700
  );
  // Stability beats reshuffling: a probed offset sticks for the primary too.
  assert.equal(
    computePortOffset({ explicit: undefined, persisted: 700, isPrimary: true, slug: 'cloud' }),
    700
  );
});

test('an explicit port offset beats the persisted manifest offset', () => {
  assert.equal(
    computePortOffset({ explicit: '1200', persisted: 700, isPrimary: false, slug: 'anything' }),
    1200
  );
});

test('reads the persisted offset back from the running-stack manifest', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-manifest-'));
  try {
    const manifestPath = path.join(dir, 'dev', 'logs', 'manifest.json');
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({ session: 'kilo-dev', portOffset: 700, services: [] })
    );
    assert.equal(readPersistedPortOffset(dir), 700);

    fs.writeFileSync(manifestPath, '{"portOffset":"garbage"}');
    assert.equal(readPersistedPortOffset(dir), undefined);

    assert.equal(readPersistedPortOffset(path.join(dir, 'missing')), undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('persists the selected offset before a stack manifest exists', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-port-offset-'));
  try {
    writePersistedPortOffset(dir, 900);
    assert.equal(readPersistedPortOffset(dir), 900);
    assert.equal(fs.readFileSync(path.join(dir, 'dev/logs/port-offset'), 'utf8'), '900\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('log cleanup preserves startup coordination state', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-log-cleanup-'));
  const logs = path.join(dir, 'dev/logs');
  try {
    fs.mkdirSync(path.join(logs, 'start.lock'), { recursive: true });
    fs.writeFileSync(path.join(logs, 'port-offset'), '900\n');
    fs.writeFileSync(path.join(logs, 'service.log'), 'old\n');
    clearDevLogs(dir);
    assert.equal(fs.readFileSync(path.join(logs, 'port-offset'), 'utf8'), '900\n');
    assert.ok(fs.existsSync(path.join(logs, 'start.lock')));
    assert.ok(!fs.existsSync(path.join(logs, 'service.log')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('candidate offsets step by 100 and wrap within the valid range', () => {
  const candidates = candidatePortOffsets(4900);
  assert.equal(candidates[0], 5000);
  assert.equal(candidates[1], 100);
  assert.equal(candidates.length, 49);
  assert.ok(!candidates.includes(4900));
  assert.ok(!candidates.includes(0));
});

test('points NEXTAUTH_URL at the offset port when the web app runs without a tunnel', () => {
  const url = resolveSessionNextAuthUrl({
    portOffset: 2900,
    serviceNames: ['nextjs', 'postgres', 'redis'],
    nextjsPort: 5900,
    repoRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-env-')),
  });
  assert.equal(url, 'http://localhost:5900');
});

test('leaves NEXTAUTH_URL to .env.local when there is no port offset', () => {
  const url = resolveSessionNextAuthUrl({
    portOffset: 0,
    serviceNames: ['nextjs'],
    nextjsPort: 3000,
    repoRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-env-')),
  });
  assert.equal(url, undefined);
});

test('does not override NEXTAUTH_URL when a tunnel rewrites it to a public origin', () => {
  const url = resolveSessionNextAuthUrl({
    portOffset: 2900,
    serviceNames: ['nextjs', 'kiloclaw-tunnel'],
    nextjsPort: 5900,
    repoRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-env-')),
  });
  assert.equal(url, undefined);
});

test('skips NEXTAUTH_URL when the web app is not being started', () => {
  const url = resolveSessionNextAuthUrl({
    portOffset: 2900,
    serviceNames: ['postgres', 'redis'],
    nextjsPort: 5900,
    repoRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-env-')),
  });
  assert.equal(url, undefined);
});

test('uses the LAN host from .env.local and the offset port', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-env-'));
  fs.writeFileSync(
    path.join(repoRoot, '.env.local'),
    'NEXTAUTH_URL=http://192.168.1.82:3000\n'
  );
  const url = resolveSessionNextAuthUrl({
    portOffset: 100,
    serviceNames: ['nextjs'],
    nextjsPort: 3100,
    repoRoot,
  });
  assert.equal(url, 'http://192.168.1.82:3100');
});

test('preserves 127.0.0.1 as the host and forces the offset port', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-env-'));
  fs.writeFileSync(
    path.join(repoRoot, '.env.local'),
    'NEXTAUTH_URL=http://127.0.0.1:3000\n'
  );
  const url = resolveSessionNextAuthUrl({
    portOffset: 100,
    serviceNames: ['nextjs'],
    nextjsPort: 3100,
    repoRoot,
  });
  assert.equal(url, 'http://127.0.0.1:3100');
});

test('uses the LAN host from APP_URL_OVERRIDE in .env.development.local', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-env-'));
  fs.writeFileSync(
    path.join(repoRoot, '.env.development.local'),
    'APP_URL_OVERRIDE=https://10.0.0.5:3000\n'
  );
  const url = resolveSessionNextAuthUrl({
    portOffset: 100,
    serviceNames: ['nextjs'],
    nextjsPort: 3100,
    repoRoot,
  });
  assert.equal(url, 'https://10.0.0.5:3100');
});

test('auto-corrects the loopback port when .env.local still pins the default :3000', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-env-'));
  fs.writeFileSync(
    path.join(repoRoot, '.env.local'),
    'NEXTAUTH_URL=http://localhost:3000\n'
  );
  const url = resolveSessionNextAuthUrl({
    portOffset: 100,
    serviceNames: ['nextjs'],
    nextjsPort: 3100,
    repoRoot,
  });
  assert.equal(url, 'http://localhost:3100');
});

test('ignores malformed NEXTAUTH_URL entries and falls back to the offset port', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-env-'));
  fs.writeFileSync(path.join(repoRoot, '.env.local'), 'NEXTAUTH_URL=not-a-url\n');
  const url = resolveSessionNextAuthUrl({
    portOffset: 100,
    serviceNames: ['nextjs'],
    nextjsPort: 3100,
    repoRoot,
  });
  assert.equal(url, 'http://localhost:3100');
});

test('preserves IPv6 loopback and keeps the brackets in the origin', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-env-'));
  fs.writeFileSync(path.join(repoRoot, '.env.local'), 'NEXTAUTH_URL=http://[::1]:3000\n');
  const url = resolveSessionNextAuthUrl({
    portOffset: 100,
    serviceNames: ['nextjs'],
    nextjsPort: 3100,
    repoRoot,
  });
  assert.equal(url, 'http://[::1]:3100');
});

test('preserves a leftover tunnel hostname in .env.local as-is (tunnel cleanup tracked separately)', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-env-'));
  fs.writeFileSync(
    path.join(repoRoot, '.env.local'),
    'NEXTAUTH_URL=https://abc-123.trycloudflare.com:3000\n'
  );
  const url = resolveSessionNextAuthUrl({
    portOffset: 100,
    serviceNames: ['nextjs'],
    nextjsPort: 3100,
    repoRoot,
  });
  assert.equal(url, 'https://abc-123.trycloudflare.com:3000');
});

test('preserves a public IP in .env.local without forcing the offset port', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-env-'));
  fs.writeFileSync(path.join(repoRoot, '.env.local'), 'NEXTAUTH_URL=http://8.8.8.8:3000\n');
  const url = resolveSessionNextAuthUrl({
    portOffset: 100,
    serviceNames: ['nextjs'],
    nextjsPort: 3100,
    repoRoot,
  });
  assert.equal(url, 'http://8.8.8.8:3000');
});

test('preserves a public custom domain (e.g. Cloudflare Access) without a port', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-env-'));
  fs.writeFileSync(path.join(repoRoot, '.env.local'), 'NEXTAUTH_URL=https://clouddev.example.com\n');
  const url = resolveSessionNextAuthUrl({
    portOffset: 100,
    serviceNames: ['nextjs'],
    nextjsPort: 3100,
    repoRoot,
  });
  assert.equal(url, 'https://clouddev.example.com');
});

test('prefers .env.development.local over .env.local per key, matching dev.sh', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-env-'));
  fs.writeFileSync(
    path.join(repoRoot, '.env.development.local'),
    'NEXTAUTH_URL=http://10.0.0.5:3000\n'
  );
  fs.writeFileSync(
    path.join(repoRoot, '.env.local'),
    'NEXTAUTH_URL=http://192.168.1.82:3000\n'
  );
  const url = resolveSessionNextAuthUrl({
    portOffset: 100,
    serviceNames: ['nextjs'],
    nextjsPort: 3100,
    repoRoot,
  });
  assert.equal(url, 'http://10.0.0.5:3100');
});

test('keeps auto routing workers in their own opt-in group', () => {
  const service = getService('auto-routing');

  assert.equal(service.group, 'auto-routing');
  assert.equal(service.type, 'worker');
  assert.equal(service.dir, 'services/auto-routing');
  assert.equal(service.port, 8810 + portOffset);
  assert.match(service.command.join(' '), /pnpm run dev/);

  const benchmark = getService('auto-routing-benchmark');
  assert.equal(benchmark.group, 'auto-routing');
  assert.equal(benchmark.type, 'worker');
  assert.equal(benchmark.dir, 'services/auto-routing-benchmark');
  assert.equal(benchmark.port - service.port, 4);

  const alwaysOn = resolveGroups(getAlwaysOnGroupIds());
  assert.ok(!alwaysOn.includes('auto-routing'));
  assert.ok(!alwaysOn.includes('auto-routing-benchmark'));
});

test('registers user data export with worktree-aware ports and dependencies', () => {
  const service = getService('user-data-export');

  assert.equal(service.group, 'data-export');
  assert.equal(service.type, 'worker');
  assert.equal(service.dir, 'services/user-data-export');
  assert.equal(service.port, 8818 + portOffset);
  assert.deepEqual(service.dependsOn, ['postgres', 'nextjs']);
  assert.deepEqual(resolveTargets(['data-export']), [
    'stripe',
    'redis',
    'postgres',
    'redis-http',
    'nextjs',
    'user-data-export',
  ]);
});

test('points both user data export Hyperdrive bindings at the offset database', () => {
  const initialOffset = portOffset;
  try {
    applyPortOffset(1200);
    const command = getService('user-data-export').command.join(' ');
    assert.match(
      command,
      /CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_PRIMARY_STATE_DB=.*localhost:6632/
    );
    assert.match(
      command,
      /CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_EXPORT_WAREHOUSE_DB=.*localhost:6632\/data_export/
    );
  } finally {
    applyPortOffset(initialOffset);
  }
});

test('keeps auto routing package dev script compatible with local launcher flags', () => {
  const service = getService('auto-routing');
  const packageJson = JSON.parse(fs.readFileSync(`${service.dir}/package.json`, 'utf-8')) as {
    scripts?: { dev?: string };
  };
  const scriptFlags = packageJson.scripts?.dev?.split(/\s+/) ?? [];
  const launcherFlags = service.command;

  assert.equal(scriptFlags.filter(part => part === '--ip').length, 0);
  assert.equal(scriptFlags.filter(part => part === '--env').length, 0);
  assert.equal(scriptFlags.filter(part => part === '-e').length, 0);
  assert.equal(launcherFlags.filter(part => part === '--ip').length, 1);
});

test('starts the container usage meter whenever Gastown starts', () => {
  // Gastown's TownContainerDO binds container-usage-meter via a service binding,
  // which only connects when the meter is registered in the same local Wrangler
  // dev registry. Starting Gastown must therefore always launch the meter.
  const gastownTargets = resolveTargets(['gastown']);
  assert.ok(
    gastownTargets.includes('container-usage-meter'),
    `expected container-usage-meter in gastown start targets, got: ${gastownTargets.join(', ')}`
  );

  const meter = getService('container-usage-meter');
  assert.equal(meter.type, 'worker');
  assert.equal(meter.dir, 'services/container-usage-meter');
  assert.equal(meter.port, 8813 + portOffset);
});

test('binds the container usage meter under its unsuffixed Wrangler name', () => {
  // Gastown binds CONTAINER_USAGE to service "container-usage-meter" with no
  // "-dev" suffix. The meter's dev script must not pass --env (which would
  // register it as a different name) and must accept the launcher's flags.
  const meter = getService('container-usage-meter');
  const packageJson = JSON.parse(fs.readFileSync(`${meter.dir}/package.json`, 'utf-8')) as {
    scripts?: { dev?: string };
  };
  const scriptFlags = packageJson.scripts?.dev?.split(/\s+/) ?? [];

  assert.equal(scriptFlags.filter(part => part === '--env').length, 0);
  assert.equal(scriptFlags.filter(part => part === '-e').length, 0);
  assert.equal(meter.command.filter(part => part === '--ip').length, 1);
});

test('starts Storybook with Storybook v10 port flags', () => {
  const service = getService('storybook');

  assert.deepEqual(service.command, ['pnpm', 'run', 'storybook', '-p', String(service.port)]);
});

test('registers deletion-mock as an opt-in loopback process', () => {
  const service = getService('deletion-mock');

  assert.equal(service.group, 'deletion-mock');
  assert.equal(service.type, 'process');
  assert.equal(service.dir, 'dev/local/scripts');
  assert.equal(service.port, 4010 + portOffset);
  assert.deepEqual(service.command, [
    'env',
    `PORT=${service.port}`,
    'pnpm',
    'exec',
    'tsx',
    'deletion-provider-mock.ts',
  ]);

  const alwaysOn = resolveGroups(getAlwaysOnGroupIds());
  assert.ok(!alwaysOn.includes('deletion-mock'));
  assert.deepEqual(
    resolveTargets(['deletion-mock']).filter(name => name === 'deletion-mock'),
    ['deletion-mock']
  );
});

test('injects deletion-mock host overrides only when the service is selected', () => {
  assert.equal(
    resolveDeletionMockSessionEnv({
      serviceNames: ['nextjs'],
      mockPort: 4010,
      env: {},
    }),
    undefined
  );

  const env = resolveDeletionMockSessionEnv({
    serviceNames: ['nextjs', 'deletion-mock'],
    mockPort: 5210,
    env: {},
  });
  assert.deepEqual(env, {
    POSTHOG_HOST: 'http://127.0.0.1:5210',
    PYLON_HOST: 'http://127.0.0.1:5210',
    SUBSTACK_PUBLICATION_URL: 'http://127.0.0.1:5210',
    CUSTOMERIO_TRACK_BASE: 'http://127.0.0.1:5210',
    PYLON_API_KEY: 'deletion-mock',
    POSTHOG_PERSONAL_API_KEY: 'deletion-mock',
    POSTHOG_ENVIRONMENT_ID: 'deletion-mock',
  });
});

test('keeps existing deletion provider keys when injecting deletion-mock hosts', () => {
  const env = resolveDeletionMockSessionEnv({
    serviceNames: ['deletion-mock'],
    mockPort: 4010,
    env: {
      PYLON_API_KEY: 'real-pylon',
      POSTHOG_PERSONAL_API_KEY: 'real-posthog',
      POSTHOG_ENVIRONMENT_ID: 'proj-1',
    },
  });
  assert.equal(env?.PYLON_API_KEY, undefined);
  assert.equal(env?.POSTHOG_PERSONAL_API_KEY, undefined);
  assert.equal(env?.POSTHOG_ENVIRONMENT_ID, undefined);
  assert.equal(env?.POSTHOG_HOST, 'http://127.0.0.1:4010');
});

test('preserves auto routing backend auth secret name', () => {
  const service = getService('auto-routing');
  const wranglerConfig = fs.readFileSync(`${service.dir}/wrangler.jsonc`, 'utf-8');

  assert.match(wranglerConfig, /"binding": "INTERNAL_API_SECRET_PROD"/);
  assert.match(wranglerConfig, /"secret_name": "INTERNAL_API_SECRET_PROD"/);
  assert.doesNotMatch(wranglerConfig, /BACKEND_AUTH_TOKEN/);
});
