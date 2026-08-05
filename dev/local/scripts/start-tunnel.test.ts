import assert from 'node:assert/strict';
import test from 'node:test';

import { buildDockerLocalEnvValues } from './start-tunnel';

test('returns BACKEND_API_URL with localhost when using default port', () => {
  const env = buildDockerLocalEnvValues('3000', '8795', '8808');

  assert.equal(env.BACKEND_API_URL, 'http://localhost:3000');
  assert.equal(env.KILOCODE_API_BASE_URL, 'http://host.docker.internal:3000/api/gateway/');
  assert.equal(env.KILOCLAW_CHECKIN_URL, 'http://host.docker.internal:8795/api/controller/checkin');
  assert.equal(env.KILOCHAT_BASE_URL, 'http://host.docker.internal:8808');
});

test('writes BACKEND_API_URL and KILOCODE values with port 4900', () => {
  const env = buildDockerLocalEnvValues('4900', '8795', '8808');

  assert.equal(env.BACKEND_API_URL, 'http://localhost:4900');
  assert.equal(env.KILOCODE_API_BASE_URL, 'http://host.docker.internal:4900/api/gateway/');
  assert.equal(env.KILOCLAW_CHECKIN_URL, 'http://host.docker.internal:8795/api/controller/checkin');
  assert.equal(env.KILOCHAT_BASE_URL, 'http://host.docker.internal:8808');
});

test('BACKEND_API_URL uses localhost, not host.docker.internal', () => {
  const env = buildDockerLocalEnvValues('3000', '8795', '8808');

  assert.ok(env.BACKEND_API_URL.startsWith('http://localhost:'));
  assert.ok(
    env.KILOCODE_API_BASE_URL.startsWith('http://host.docker.internal:'),
    'KILOCODE_API_BASE_URL must use host.docker.internal for Docker containers'
  );
});

test('includes all four required keys', () => {
  const env = buildDockerLocalEnvValues('3000', '8795', '8808');

  const keys = Object.keys(env).sort();
  assert.deepEqual(keys, [
    'BACKEND_API_URL',
    'KILOCHAT_BASE_URL',
    'KILOCLAW_CHECKIN_URL',
    'KILOCODE_API_BASE_URL',
  ]);
});
