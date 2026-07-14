import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  applyEnvValues,
  buildMobileEnvValues,
  ensureRootEnv,
  isUsableIpv4,
  prepareMobileEnvironment,
  upsertRootEnv,
} from './mobile-env';
import { getService } from './services';

test('builds LAN URLs for every mobile-facing local service', () => {
  const values = buildMobileEnvValues('192.168.1.10');

  assert.equal(values.get('API_BASE_URL'), `http://192.168.1.10:${getService('nextjs').port}`);
  assert.equal(values.get('WEB_BASE_URL'), `http://192.168.1.10:${getService('nextjs').port}`);
  assert.equal(
    values.get('CLOUD_AGENT_WS_URL'),
    `ws://192.168.1.10:${getService('cloud-agent-next').port}`
  );
  assert.equal(
    values.get('SESSION_INGEST_WS_URL'),
    `ws://192.168.1.10:${getService('cloudflare-session-ingest').port}`
  );
  assert.equal(values.get('KILO_CHAT_URL'), `http://192.168.1.10:${getService('kilo-chat').port}`);
  assert.equal(
    values.get('EVENT_SERVICE_URL'),
    `ws://192.168.1.10:${getService('event-service').port}`
  );
  assert.equal(
    values.get('NOTIFICATIONS_URL'),
    `http://192.168.1.10:${getService('notifications').port}`
  );
});

test('rewrites only requested env keys while preserving comments and other values', () => {
  const content = [
    '# comment',
    'API_BASE_URL=http://localhost:3000',
    'APPSFLYER_APP_ID=6761193135',
    '',
  ].join('\n');

  const result = applyEnvValues(
    content,
    new Map([
      ['API_BASE_URL', 'http://192.168.1.10:3000'],
      ['WEB_BASE_URL', 'http://192.168.1.10:3000'],
    ])
  );

  assert.equal(
    result,
    [
      '# comment',
      'API_BASE_URL=http://192.168.1.10:3000',
      'APPSFLYER_APP_ID=6761193135',
      '',
      'WEB_BASE_URL=http://192.168.1.10:3000',
      '',
    ].join('\n')
  );
});

test('upserts quoted web app URL values in root env', () => {
  const result = upsertRootEnv(
    ['NEXTAUTH_URL="http://localhost:3000"', 'OTHER=value', ''].join('\n'),
    new Map([
      ['APP_URL_OVERRIDE', 'http://192.168.1.10:3000'],
      ['NEXTAUTH_URL', 'http://192.168.1.10:3000'],
    ])
  );

  assert.equal(
    result,
    [
      'NEXTAUTH_URL="http://192.168.1.10:3000"',
      'OTHER=value',
      '',
      'APP_URL_OVERRIDE="http://192.168.1.10:3000"',
      '',
    ].join('\n')
  );
});

test('validates IPv4-looking host values', () => {
  assert.equal(isUsableIpv4('192.168.1.10'), true);
  assert.equal(isUsableIpv4('999.999.999.999'), false);
  assert.equal(isUsableIpv4('localhost'), false);
  assert.equal(isUsableIpv4(undefined), false);
});

test('copies the primary worktree root env when a secondary worktree is missing it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-mobile-env-'));
  const primary = path.join(root, 'primary');
  const secondary = path.join(root, 'secondary');
  fs.mkdirSync(primary);
  fs.mkdirSync(secondary);
  fs.writeFileSync(path.join(primary, '.env.local'), 'NEXTAUTH_SECRET=secret\n');

  ensureRootEnv(secondary, [primary, secondary]);

  assert.equal(
    fs.readFileSync(path.join(secondary, '.env.local'), 'utf8'),
    'NEXTAUTH_SECRET=secret\n'
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('prepares mobile URLs before returning values for the Metro tmux environment', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-mobile-env-'));
  fs.mkdirSync(path.join(root, 'apps/mobile'), { recursive: true });
  fs.writeFileSync(path.join(root, '.env.local'), 'NEXTAUTH_URL="http://localhost:3000"\n');
  fs.writeFileSync(
    path.join(root, 'apps/mobile/.env.local.example'),
    'API_BASE_URL=http://localhost:3000\nWEB_BASE_URL=http://localhost:3000\n'
  );

  const result = prepareMobileEnvironment(root, '192.168.1.10');

  const appUrl = `http://192.168.1.10:${getService('nextjs').port}`;
  assert.equal(result.appUrl, appUrl);
  assert.equal(result.sessionEnv.API_BASE_URL, appUrl);
  assert.equal(result.sessionEnv.WEB_BASE_URL, appUrl);
  assert.equal(result.sessionEnv.NEXTAUTH_URL, undefined);
  assert.equal(result.sessionEnv.APP_URL_OVERRIDE, undefined);
  fs.rmSync(root, { recursive: true, force: true });
});
