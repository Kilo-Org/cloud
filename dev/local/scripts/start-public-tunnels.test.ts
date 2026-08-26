import assert from 'node:assert/strict';
import test from 'node:test';

import {
  envValueForCapturedUrl,
  parsePublicTunnelPorts,
  providerBaseFromBackendTunnel,
  publicTunnelSpecs,
  updateEnvValue,
} from './start-public-tunnels';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('requires the three sandbox-facing local ports', () => {
  assert.throws(() => parsePublicTunnelPorts(['8794', '3000']), /Usage: start-public-tunnels/);
});

test('builds worker, nextjs, and session-ingest tunnels', () => {
  assert.deepEqual(publicTunnelSpecs(parsePublicTunnelPorts(['8794', '3000', '8800'])), [
    { label: 'worker', port: '8794', key: 'WORKER_URL' },
    { label: 'nextjs', port: '3000', key: 'KILOCODE_BACKEND_BASE_URL' },
    { label: 'session-ingest', port: '8800', key: 'KILO_SESSION_INGEST_URL' },
  ]);
});

test('adds a fake-llm tunnel with the /api suffix when that port is present', () => {
  const specs = publicTunnelSpecs(parsePublicTunnelPorts(['8794', '3000', '8800', '8811']));
  const fakeLlm = specs.find(spec => spec.label === 'fake-llm');
  assert.ok(fakeLlm);
  assert.deepEqual(fakeLlm, {
    label: 'fake-llm',
    port: '8811',
    key: 'KILO_OPENROUTER_BASE',
    suffix: '/api',
  });
  assert.equal(
    envValueForCapturedUrl(fakeLlm, 'https://abc.trycloudflare.com'),
    'https://abc.trycloudflare.com/api'
  );
});

test('derives the real-model provider URL from the backend tunnel', () => {
  assert.equal(
    providerBaseFromBackendTunnel('https://backend.trycloudflare.com'),
    'https://backend.trycloudflare.com/api'
  );
});

test('can pin KILO_OPENROUTER_BASE to the backend tunnel /api', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'public-tunnels-'));
  const envPath = path.join(dir, '.dev.vars');
  fs.writeFileSync(
    envPath,
    'KILOCODE_BACKEND_BASE_URL=http://localhost:5500\nKILO_OPENROUTER_BASE=http://localhost:5500/api\n'
  );
  updateEnvValue(envPath, 'KILOCODE_BACKEND_BASE_URL', 'https://backend.trycloudflare.com');
  updateEnvValue(envPath, 'KILO_OPENROUTER_BASE', 'https://backend.trycloudflare.com/api');
  assert.match(
    fs.readFileSync(envPath, 'utf8'),
    /KILO_OPENROUTER_BASE=https:\/\/backend\.trycloudflare\.com\/api/
  );
});
