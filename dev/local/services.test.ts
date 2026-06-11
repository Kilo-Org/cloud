import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { getAlwaysOnGroupIds, getService, resolveGroups } from './services';

test('starts auto routing as a core dev service', () => {
  const service = getService('auto-routing');

  assert.equal(service.group, 'core');
  assert.equal(service.type, 'worker');
  assert.equal(service.dir, 'services/auto-routing');
  assert.equal(service.port, 8810);
  assert.match(service.command.join(' '), /pnpm run dev/);
  assert.ok(resolveGroups(getAlwaysOnGroupIds()).includes('auto-routing'));
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

test('preserves auto routing backend auth secret name', () => {
  const service = getService('auto-routing');
  const wranglerConfig = fs.readFileSync(`${service.dir}/wrangler.jsonc`, 'utf-8');

  assert.match(wranglerConfig, /"binding": "INTERNAL_API_SECRET_PROD"/);
  assert.match(wranglerConfig, /"secret_name": "INTERNAL_API_SECRET_PROD"/);
  assert.doesNotMatch(wranglerConfig, /BACKEND_AUTH_TOKEN/);
});
