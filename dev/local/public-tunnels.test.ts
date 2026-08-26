import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import {
  buildFollowLogPipeCommand,
  buildLogPipeCommand,
  snapshotCloudAgentPublicTunnelEnv,
  waitForCloudAgentPublicTunnelCapture,
} from './runner';

function withTempRepo(devVars: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-public-tunnels-'));
  const target = path.join(root, 'services/cloud-agent-next/.dev.vars');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, devVars);
  return root;
}

test('buildLogPipeCommand cds to the repo so a deleted tmux-server cwd cannot kill tsx', () => {
  const command = buildLogPipeCommand('/tmp/service.log');
  assert.match(command, /^cd '/);
  assert.match(command, /log-filter\.ts/);
  assert.match(command, /\/tmp\/service\.log/);
});

test('buildFollowLogPipeCommand groups cd+tsx so tee does not steal the &&', () => {
  const command = buildFollowLogPipeCommand('/tmp/service.log', '/tmp/follow.log');
  assert.match(command, /tee -a '\/tmp\/follow\.log' \| \( cd '/);
});

test('snapshotCloudAgentPublicTunnelEnv reads the three public-tunnel keys', () => {
  const repoRoot = withTempRepo(
    [
      'WORKER_URL=https://worker.trycloudflare.com',
      'KILOCODE_BACKEND_BASE_URL=https://backend.trycloudflare.com',
      'KILO_SESSION_INGEST_URL=https://ingest.trycloudflare.com',
    ].join('\n')
  );

  const snapshot = snapshotCloudAgentPublicTunnelEnv(repoRoot);
  assert.equal(snapshot.values.WORKER_URL, 'https://worker.trycloudflare.com');
  assert.equal(snapshot.values.KILOCODE_BACKEND_BASE_URL, 'https://backend.trycloudflare.com');
  assert.equal(snapshot.values.KILO_SESSION_INGEST_URL, 'https://ingest.trycloudflare.com');
  assert.equal(typeof snapshot.mtime, 'number');
});

test('waitForCloudAgentPublicTunnelCapture returns true when all three keys change', async () => {
  const repoRoot = withTempRepo(
    [
      'WORKER_URL=https://old-worker.trycloudflare.com',
      'KILOCODE_BACKEND_BASE_URL=https://old-backend.trycloudflare.com',
      'KILO_SESSION_INGEST_URL=https://old-ingest.trycloudflare.com',
    ].join('\n')
  );
  const previous = snapshotCloudAgentPublicTunnelEnv(repoRoot);
  fs.writeFileSync(
    path.join(repoRoot, 'services/cloud-agent-next/.dev.vars'),
    [
      'WORKER_URL=https://new-worker.trycloudflare.com',
      'KILOCODE_BACKEND_BASE_URL=https://new-backend.trycloudflare.com',
      'KILO_SESSION_INGEST_URL=https://new-ingest.trycloudflare.com',
    ].join('\n')
  );

  assert.equal(await waitForCloudAgentPublicTunnelCapture(repoRoot, previous, 1000), true);
});

test('waitForCloudAgentPublicTunnelCapture waits for all sequential URL writes', async () => {
  const oldValues = [
    'WORKER_URL=https://old-worker.trycloudflare.com',
    'KILOCODE_BACKEND_BASE_URL=https://old-backend.trycloudflare.com',
    'KILO_SESSION_INGEST_URL=https://old-ingest.trycloudflare.com',
  ];
  const repoRoot = withTempRepo(oldValues.join('\n'));
  const envPath = path.join(repoRoot, 'services/cloud-agent-next/.dev.vars');
  const previous = snapshotCloudAgentPublicTunnelEnv(repoRoot);

  oldValues[0] = 'WORKER_URL=https://new-worker.trycloudflare.com';
  fs.writeFileSync(envPath, oldValues.join('\n'));
  fs.utimesSync(envPath, new Date(), new Date(Date.now() + 1000));
  assert.equal(await waitForCloudAgentPublicTunnelCapture(repoRoot, previous, 200), false);

  oldValues[1] = 'KILOCODE_BACKEND_BASE_URL=https://new-backend.trycloudflare.com';
  fs.writeFileSync(envPath, oldValues.join('\n'));
  assert.equal(await waitForCloudAgentPublicTunnelCapture(repoRoot, previous, 200), false);

  oldValues[2] = 'KILO_SESSION_INGEST_URL=https://new-ingest.trycloudflare.com';
  fs.writeFileSync(envPath, oldValues.join('\n'));
  assert.equal(await waitForCloudAgentPublicTunnelCapture(repoRoot, previous, 1000), true);
});

test('waitForCloudAgentPublicTunnelCapture times out when URLs stay the same', async () => {
  const repoRoot = withTempRepo('WORKER_URL=https://worker.trycloudflare.com\n');
  const previous = snapshotCloudAgentPublicTunnelEnv(repoRoot);
  assert.equal(await waitForCloudAgentPublicTunnelCapture(repoRoot, previous, 200), false);
});
