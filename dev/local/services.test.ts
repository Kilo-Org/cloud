import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  computePortOffset,
  getAlwaysOnGroupIds,
  getService,
  portOffset,
  resolveGroups,
  resolveSessionNextAuthUrl,
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

test('points NEXTAUTH_URL at the offset port when the web app runs without a tunnel', () => {
  const url = resolveSessionNextAuthUrl({
    portOffset: 2900,
    serviceNames: ['nextjs', 'postgres', 'redis'],
    nextjsPort: 5900,
  });
  assert.equal(url, 'http://localhost:5900');
});

test('leaves NEXTAUTH_URL to .env.local when there is no port offset', () => {
  const url = resolveSessionNextAuthUrl({
    portOffset: 0,
    serviceNames: ['nextjs'],
    nextjsPort: 3000,
  });
  assert.equal(url, undefined);
});

test('does not override NEXTAUTH_URL when a tunnel rewrites it to a public origin', () => {
  const url = resolveSessionNextAuthUrl({
    portOffset: 2900,
    serviceNames: ['nextjs', 'kiloclaw-tunnel'],
    nextjsPort: 5900,
  });
  assert.equal(url, undefined);
});

test('skips NEXTAUTH_URL when the web app is not being started', () => {
  const url = resolveSessionNextAuthUrl({
    portOffset: 2900,
    serviceNames: ['postgres', 'redis'],
    nextjsPort: 5900,
  });
  assert.equal(url, undefined);
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

test('starts Storybook with Storybook v10 port flags', () => {
  const service = getService('storybook');

  assert.deepEqual(service.command, ['pnpm', 'run', 'storybook', '-p', String(service.port)]);
});

test('preserves auto routing backend auth secret name', () => {
  const service = getService('auto-routing');
  const wranglerConfig = fs.readFileSync(`${service.dir}/wrangler.jsonc`, 'utf-8');

  assert.match(wranglerConfig, /"binding": "INTERNAL_API_SECRET_PROD"/);
  assert.match(wranglerConfig, /"secret_name": "INTERNAL_API_SECRET_PROD"/);
  assert.doesNotMatch(wranglerConfig, /BACKEND_AUTH_TOKEN/);
});
