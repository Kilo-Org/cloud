import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '../../..');

type WorkerTunnelConfig = {
  tunnelName: string;
  tunnelHostname: string;
};

function parseConfFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  const result: Record<string, string> = {};
  for (const line of fs.readFileSync(filePath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const eqIndex = trimmed.indexOf('=');
    const key = trimmed.slice(0, eqIndex).trim();
    const raw = trimmed.slice(eqIndex + 1).trim();
    result[key] = raw.replace(/^["']|["']$/g, '');
  }
  return result;
}

function loadConfig(): WorkerTunnelConfig {
  const globalPath = path.join(os.homedir(), '.config/kiloclaw/dev-start.conf');
  const localPath = path.join(repoRoot, 'kiloclaw/scripts/.dev-start.conf');

  const merged = {
    ...parseConfFile(globalPath),
    ...parseConfFile(localPath),
  };

  return {
    tunnelName: merged['WORKER_TUNNEL_NAME'] ?? '',
    tunnelHostname: merged['WORKER_TUNNEL_HOSTNAME'] ?? '',
  };
}

if (spawnSync('cloudflared', ['version'], { stdio: 'ignore' }).error) {
  console.error(
    'cloudflared not found on PATH. Install it:\n  https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/\n  brew install cloudflared'
  );
  process.exit(1);
}

const config = loadConfig();

if (!config.tunnelName) {
  console.error(
    'WORKER_TUNNEL_NAME not set in ~/.config/kiloclaw/dev-start.conf or kiloclaw/scripts/.dev-start.conf'
  );
  process.exit(1);
}

const configFile = path.join(os.homedir(), '.cloudflared/kiloclaw-worker.yml');
console.log(`Named tunnel: ${config.tunnelName} -> ${config.tunnelHostname}`);

const child = spawn(
  'cloudflared',
  ['tunnel', '--config', configFile, 'run', config.tunnelName],
  { stdio: ['ignore', 'pipe', 'pipe'] }
);

function handleOutput(data: Buffer) {
  process.stderr.write(data);
}

child.stdout.on('data', handleOutput);
child.stderr.on('data', handleOutput);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => child.kill(signal));
}

child.on('close', code => {
  process.exit(code ?? 1);
});
