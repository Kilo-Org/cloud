import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import {
  isPortlessServiceHealthy,
  isPublicUrl,
  isTunnelUrlServing,
  readCapturedTunnelUrl,
  readEnvValueFromText,
  TUNNEL_URL_SOURCES,
} from './tunnel-health';

function withTempRepo(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-tunnel-health-'));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return root;
}

function listen(handler: http.RequestListener): Promise<{ url: string; close: () => void }> {
  const server = http.createServer(handler);
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('no port');
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => server.close(),
      });
    });
  });
}

test('readEnvValueFromText takes the last active assignment and ignores comments', () => {
  const content = [
    '# WORKER_URL=https://commented.trycloudflare.com',
    'WORKER_URL=https://first.trycloudflare.com',
    'OTHER=1',
    'WORKER_URL="https://second.trycloudflare.com"',
  ].join('\n');

  assert.equal(readEnvValueFromText(content, 'WORKER_URL'), 'https://second.trycloudflare.com');
  assert.equal(readEnvValueFromText(content, 'MISSING'), undefined);
  assert.equal(readEnvValueFromText('WORKER_URL=\n', 'WORKER_URL'), undefined);
});

test('readCapturedTunnelUrl reads the file each tunnel script writes', () => {
  const source = TUNNEL_URL_SOURCES['cloud-agent-public-tunnels'];
  assert.ok(source);
  const repoRoot = withTempRepo({
    [source.file]: `${source.key}=https://tunnel.trycloudflare.com\n`,
  });

  assert.equal(
    readCapturedTunnelUrl(repoRoot, 'cloud-agent-public-tunnels'),
    'https://tunnel.trycloudflare.com'
  );
  assert.equal(readCapturedTunnelUrl(repoRoot, 'nextjs'), undefined);
  assert.equal(readCapturedTunnelUrl('/missing', 'cloud-agent-public-tunnels'), undefined);
});

test('readCapturedTunnelUrl rejects a value that is not a URL', () => {
  const source = TUNNEL_URL_SOURCES['kiloclaw-tunnel'];
  assert.ok(source);
  const repoRoot = withTempRepo({ [source.file]: `${source.key}=set-me\n` });

  assert.equal(readCapturedTunnelUrl(repoRoot, 'kiloclaw-tunnel'), undefined);
});

test('isTunnelUrlServing probes /health and treats a live origin as up', async () => {
  const livePaths: string[] = [];
  const live = await listen((req, res) => {
    livePaths.push(req.url ?? '');
    res.writeHead(req.url === '/health' ? 200 : 404);
    res.end(req.url === '/health' ? '{"status":"ok"}' : 'not found');
  });
  const dead = await listen((_req, res) => {
    res.writeHead(530); // what the Cloudflare edge returns for a dead quick tunnel
    res.end('tunnel gone');
  });

  try {
    assert.equal(await isTunnelUrlServing(live.url), true);
    assert.deepEqual(livePaths, ['/health']);
    assert.equal(await isTunnelUrlServing(`${live.url}/api/gateway/`), true);
    assert.deepEqual(livePaths, ['/health', '/api/gateway/health']);
    assert.equal(await isTunnelUrlServing(dead.url), false);
  } finally {
    live.close();
    dead.close();
  }
});

test('isTunnelUrlServing reports an unreachable host as down without hanging', async () => {
  const closed = await listen((_req, res) => res.end('ok'));
  const url = closed.url;
  closed.close();

  assert.equal(await isTunnelUrlServing(url, 500), false);
});

test('isTunnelUrlServing treats a 404 on /health as up', async () => {
  const origin = await listen((req, res) => {
    res.writeHead(req.url === '/health' ? 404 : 500);
    res.end('not found');
  });

  try {
    assert.equal(await isTunnelUrlServing(origin.url), true);
  } finally {
    origin.close();
  }
});

test('isPublicUrl rejects the local URLs docker-local mode writes', () => {
  // kiloclaw-tunnel writes BACKEND_API_URL=http://localhost:<nextjs-port> when
  // the docker-local provider skips tunnels. That port answers because nextjs
  // is up, which says nothing about the tunnel service.
  assert.equal(isPublicUrl('http://localhost:5500'), false);
  assert.equal(isPublicUrl('http://127.0.0.1:5500'), false);
  assert.equal(isPublicUrl('http://host.docker.internal:5500/api/gateway/'), false);
  assert.equal(isPublicUrl('https://tunnel.trycloudflare.com'), true);
  assert.equal(isPublicUrl('not-a-url'), false);
});

test('isPortlessServiceHealthy reports a captured dead URL as down even if the pane is alive', async () => {
  const source = TUNNEL_URL_SOURCES['cloud-agent-public-tunnels'];
  assert.ok(source);
  const dead = withTempRepo({
    [source.file]: `${source.key}=https://does-not-resolve-kilo-dev.invalid\n`,
  });
  const none = withTempRepo({});

  assert.equal(await isPortlessServiceHealthy(dead, 'cloud-agent-public-tunnels', true), false);
  assert.equal(await isPortlessServiceHealthy(none, 'cloud-agent-public-tunnels', true), true);
  assert.equal(await isPortlessServiceHealthy(none, 'cloud-agent-public-tunnels', false), false);
  assert.equal(await isPortlessServiceHealthy(none, 'stripe', true), true);
});

test('readCapturedTunnelUrl ignores a local URL from docker-local mode', () => {
  const source = TUNNEL_URL_SOURCES['kiloclaw-tunnel'];
  assert.ok(source);
  const repoRoot = withTempRepo({ [source.file]: `${source.key}=http://localhost:5500\n` });

  assert.equal(readCapturedTunnelUrl(repoRoot, 'kiloclaw-tunnel'), undefined);
});
