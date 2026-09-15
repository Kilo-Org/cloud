import assert from 'node:assert/strict';
import test from 'node:test';

import { LOCAL_FAKE_LLM_ADMIN_TOKEN } from '../../../services/cloud-agent-next/test/e2e/fake-llm-admin';
import { startFakeLlmServer } from '../../../services/cloud-agent-next/test/e2e/fake-llm-server';
import {
  envValueForCapturedUrl,
  evaluateFakeTunnelGuard,
  parsePublicTunnelPorts,
  probeFakeControlRoute,
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

// ---------------------------------------------------------------------------
// Fake LLM tunnel guard
// ---------------------------------------------------------------------------

function guardInput(overrides: {
  fakeLlmPort?: string;
  adminToken?: string;
  configured?: boolean;
  devDefault?: boolean;
}): {
  probes: string[];
  input: Parameters<typeof evaluateFakeTunnelGuard>[0];
} {
  const probes: string[] = [];
  return {
    probes,
    input: {
      ...(overrides.fakeLlmPort ? { fakeLlmPort: overrides.fakeLlmPort } : {}),
      adminToken: overrides.adminToken ?? 'configured-operator-token',
      probeConfiguredToken: async port => {
        probes.push(`configured:${port}`);
        return overrides.configured ?? true;
      },
      probeDevDefaultToken: async port => {
        probes.push(`dev-default:${port}`);
        return overrides.devDefault ?? false;
      },
    },
  };
}

test('publishes no fake-llm tunnel without a port, and probes nothing', async () => {
  const { probes, input } = guardInput({});
  assert.deepEqual(await evaluateFakeTunnelGuard(input), { allow: true });
  assert.deepEqual(probes, []);
});

test('refuses to publish the insecure development default token', async () => {
  const { probes, input } = guardInput({
    fakeLlmPort: '8811',
    adminToken: LOCAL_FAKE_LLM_ADMIN_TOKEN,
  });
  const result = await evaluateFakeTunnelGuard(input);
  assert.equal(result.allow, false);
  assert.match(result.allow === false ? result.reason : '', /development default/);
  // The environment guard runs before any probe.
  assert.deepEqual(probes, []);
});

test('refuses to publish an unset or empty admin token', async () => {
  for (const adminToken of ['', undefined]) {
    const { probes, input } = guardInput({
      fakeLlmPort: '8811',
      ...(adminToken === undefined ? {} : { adminToken }),
    });
    if (adminToken === undefined) input.adminToken = '';
    const result = await evaluateFakeTunnelGuard(input);
    assert.equal(result.allow, false);
    assert.match(result.allow === false ? result.reason : '', /unset or empty/);
    assert.deepEqual(probes, []);
  }
});

test('refuses when the running server rejects the configured token', async () => {
  const { probes, input } = guardInput({ fakeLlmPort: '8811', configured: false });
  const result = await evaluateFakeTunnelGuard(input);
  assert.equal(result.allow, false);
  assert.match(result.allow === false ? result.reason : '', /rejected the configured admin token/);
  assert.deepEqual(probes, ['configured:8811']);
});

test('refuses when the running server still accepts the development default', async () => {
  const { probes, input } = guardInput({ fakeLlmPort: '8811', devDefault: true });
  const result = await evaluateFakeTunnelGuard(input);
  assert.equal(result.allow, false);
  assert.match(result.allow === false ? result.reason : '', /development default token/);
  assert.deepEqual(probes, ['configured:8811', 'dev-default:8811']);
});

test('allows publishing a fake-llm tunnel guarded by a real token', async () => {
  const { probes, input } = guardInput({ fakeLlmPort: '8811' });
  assert.deepEqual(await evaluateFakeTunnelGuard(input), { allow: true });
  assert.deepEqual(probes, ['configured:8811', 'dev-default:8811']);
});

test('the real probe accepts only the token the running fake server uses', async () => {
  const previous = process.env.FAKE_LLM_ADMIN_TOKEN;
  process.env.FAKE_LLM_ADMIN_TOKEN = 'probe-test-token';
  const server = await startFakeLlmServer({ host: '127.0.0.1', port: 0 });
  try {
    const port = String(server.port);
    assert.equal(await probeFakeControlRoute(port, 'probe-test-token'), true);
    assert.equal(await probeFakeControlRoute(port, LOCAL_FAKE_LLM_ADMIN_TOKEN), false);
    assert.equal(await probeFakeControlRoute(port, 'wrong-token'), false);

    // The guard end-to-end against a real server: a real token is allowed, the
    // development default is refused, and an unreachable port fails closed.
    assert.deepEqual(
      await evaluateFakeTunnelGuard({
        fakeLlmPort: port,
        adminToken: 'probe-test-token',
        probeConfiguredToken: probePort => probeFakeControlRoute(probePort, 'probe-test-token'),
        probeDevDefaultToken: probePort =>
          probeFakeControlRoute(probePort, LOCAL_FAKE_LLM_ADMIN_TOKEN),
      }),
      { allow: true }
    );

    const refused = await evaluateFakeTunnelGuard({
      fakeLlmPort: port,
      adminToken: LOCAL_FAKE_LLM_ADMIN_TOKEN,
      probeConfiguredToken: probePort =>
        probeFakeControlRoute(probePort, LOCAL_FAKE_LLM_ADMIN_TOKEN),
      probeDevDefaultToken: probePort =>
        probeFakeControlRoute(probePort, LOCAL_FAKE_LLM_ADMIN_TOKEN),
    });
    assert.equal(refused.allow, false);

    assert.equal(await probeFakeControlRoute('1', 'probe-test-token'), false);
  } finally {
    await server.close();
    if (previous === undefined) delete process.env.FAKE_LLM_ADMIN_TOKEN;
    else process.env.FAKE_LLM_ADMIN_TOKEN = previous;
  }
});
