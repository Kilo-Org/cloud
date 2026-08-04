import assert from 'node:assert/strict';
import test from 'node:test';

import { applyAppEnv, buildAppEnv, buildComposeEnv, composeProjectName } from './infra-env';

const PORTS = { postgres: 5532, redis: 6479, 'redis-http': 8179, grafana: 4100 };

test('publishes the offset ports to Compose under a per-worktree project', () => {
  const env = buildComposeEnv(
    composeProjectName('/Users/dev/.worktrees/Checkout 9f1c', 532),
    PORTS
  );

  assert.equal(env.COMPOSE_PROJECT_NAME, 'kilo-dev-checkout-9f1c-532');
  assert.equal(env.KILO_POSTGRES_PORT, '5532');
  assert.equal(env.KILO_REDIS_PORT, '6479');
  assert.equal(env.KILO_REDIS_HTTP_PORT, '8179');
  assert.equal(env.KILO_GRAFANA_PORT, '4100');
});

test('rewrites local endpoints in .env.local and adds a missing key', () => {
  const before = [
    'NEXTAUTH_SECRET=keep-me',
    'POSTGRES_URL=postgres://postgres:postgres@localhost:5432/postgres',
    'REDIS_URL=redis://127.0.0.1:6379',
    '',
  ].join('\n');

  const { content, changed, kept } = applyAppEnv(before, buildAppEnv(PORTS));

  assert.deepEqual(kept, []);
  assert.deepEqual(changed.sort(), ['POSTGRES_URL', 'REDIS_URL', 'UPSTASH_REDIS_REST_URL']);
  assert.match(content, /^NEXTAUTH_SECRET=keep-me$/m);
  assert.match(content, /^POSTGRES_URL=postgres:\/\/postgres:postgres@localhost:5532\/postgres$/m);
  assert.match(content, /^REDIS_URL=redis:\/\/localhost:6479$/m);
  assert.match(content, /^UPSTASH_REDIS_REST_URL=http:\/\/localhost:8179$/m);
});

test('keeps a value that names another host', () => {
  // No credentials in the fixture: a connection string with them trips secret scanning.
  const before = 'POSTGRES_URL=postgres://db.example.com:5432/prod\n';

  const { content, changed, kept } = applyAppEnv(before, buildAppEnv(PORTS));

  assert.deepEqual(kept, ['POSTGRES_URL']);
  assert.ok(!changed.includes('POSTGRES_URL'));
  assert.match(content, /^POSTGRES_URL=postgres:\/\/db\.example\.com:5432\/prod$/m);
});

test('separates two worktrees whose basenames normalize to the same slug', () => {
  assert.notEqual(
    composeProjectName('/Users/dev/.worktrees/Checkout 9f1c', 500),
    composeProjectName('/Users/dev/.worktrees/checkout-9f1c', 600)
  );
});

test('leaves a value that already names the target host and port', () => {
  const before = 'POSTGRES_URL=postgresql://postgres:postgres@localhost:5532/postgres\n';

  const { content, changed, kept } = applyAppEnv(before, buildAppEnv(PORTS));

  assert.deepEqual(kept, []);
  assert.ok(!changed.includes('POSTGRES_URL'));
  assert.equal(content.split('\n')[0], before.trim());
});
