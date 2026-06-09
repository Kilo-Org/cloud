import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { getAlwaysOnGroupIds, getService, resolveGroups } from './services';

test('starts auto model classifier as a core dev service', () => {
  const service = getService('cloudflare-auto-model-classifier');

  assert.equal(service.group, 'core');
  assert.equal(service.type, 'worker');
  assert.equal(service.dir, 'services/auto-model-classifier');
  assert.equal(service.port, 8810);
  assert.match(service.command.join(' '), /pnpm run dev/);
  assert.ok(resolveGroups(getAlwaysOnGroupIds()).includes('cloudflare-auto-model-classifier'));
});

test('keeps auto model classifier package dev script compatible with local launcher flags', () => {
  const service = getService('cloudflare-auto-model-classifier');
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

test('preserves auto model classifier backend auth secret name', () => {
  const service = getService('cloudflare-auto-model-classifier');
  const wranglerConfig = fs.readFileSync(`${service.dir}/wrangler.jsonc`, 'utf-8');

  assert.match(wranglerConfig, /"binding": "INTERNAL_API_SECRET_PROD"/);
  assert.match(wranglerConfig, /"secret_name": "INTERNAL_API_SECRET_PROD"/);
  assert.doesNotMatch(wranglerConfig, /BACKEND_AUTH_TOKEN/);
});
