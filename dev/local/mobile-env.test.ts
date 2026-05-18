import assert from 'node:assert/strict';
import test from 'node:test';
import { applyEnvValues, buildMobileEnvValues, isUsableIpv4, upsertRootEnv } from './mobile-env';

test('builds LAN URLs for every mobile-facing local service', () => {
  const values = buildMobileEnvValues('192.168.1.10');

  assert.equal(values.get('API_BASE_URL'), 'http://192.168.1.10:3000');
  assert.equal(values.get('WEB_BASE_URL'), 'http://192.168.1.10:3000');
  assert.equal(values.get('CLOUD_AGENT_WS_URL'), 'ws://192.168.1.10:8794');
  assert.equal(values.get('SESSION_INGEST_WS_URL'), 'ws://192.168.1.10:8800');
  assert.equal(values.get('KILO_CHAT_URL'), 'http://192.168.1.10:8808');
  assert.equal(values.get('EVENT_SERVICE_URL'), 'ws://192.168.1.10:8809');
  assert.equal(values.get('NOTIFICATIONS_URL'), 'http://192.168.1.10:8804');
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
