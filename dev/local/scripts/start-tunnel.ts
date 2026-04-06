import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const devVarsPath = path.join(repoRoot, 'services/kiloclaw/.dev.vars');

type TunnelConfig = {
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

function loadTunnelConfig(): TunnelConfig {
  const globalPath = path.join(os.homedir(), '.config/kiloclaw/dev-start.conf');
  const localPath = path.join(repoRoot, 'services/kiloclaw/scripts/.dev-start.conf');

  const merged = {
    ...parseConfFile(globalPath),
    ...parseConfFile(localPath),
  };

  return {
    tunnelName: merged['TUNNEL_NAME'] ?? '',
    tunnelHostname: merged['TUNNEL_HOSTNAME'] ?? '',
  };
}

function updateEnvValue(filePath: string, key: string, value: string): void {
  let content = '';
  if (fs.existsSync(filePath)) {
    content = fs.readFileSync(filePath, 'utf-8');
  }

  const activePattern = new RegExp(`^${key}=.*`, 'm');
  const commentedPattern = new RegExp(`^# ${key}=.*`, 'm');

  if (activePattern.test(content)) {
    content = content.replace(activePattern, `${key}=${value}`);
  } else if (commentedPattern.test(content)) {
    content = content.replace(commentedPattern, `${key}=${value}`);
  } else {
    content = content.endsWith('\n') || content === '' ? content : content + '\n';
    content += `${key}=${value}\n`;
  }

  fs.writeFileSync(filePath, content);
}

if (spawnSync('cloudflared', ['version'], { stdio: 'ignore' }).error) {
  console.error(
    'cloudflared not found on PATH. Install it:\n  https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/\n  brew install cloudflared'
  );
  process.exit(1);
}

const port = process.argv[2] ?? '3000';
const config = loadTunnelConfig();

let command: string;
let args: string[];
let urlPattern: RegExp | null = null;

if (config.tunnelName) {
  command = 'cloudflared';
  args = ['tunnel', 'run', config.tunnelName];
  console.log(`Named tunnel: ${config.tunnelName} -> ${config.tunnelHostname}`);

  if (config.tunnelHostname) {
    const apiUrl = `https://${config.tunnelHostname}/api/gateway/`;
    updateEnvValue(devVarsPath, 'KILOCODE_API_BASE_URL', apiUrl);
  }
} else {
  command = 'cloudflared';
  args = ['tunnel', '--url', `http://localhost:${port}`];
  urlPattern = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
  console.log(`Starting quick tunnel -> http://localhost:${port}...`);
}

const child = spawn(command, args, {
  stdio: ['ignore', 'pipe', 'pipe'],
});

function handleOutput(data: Buffer) {
  process.stderr.write(data);

  if (!urlPattern) return;
  const match = data.toString().match(urlPattern);
  if (!match) return;

  const url = match[0];
  const apiUrl = `${url}/api/gateway/`;
  updateEnvValue(devVarsPath, 'KILOCODE_API_BASE_URL', apiUrl);

  console.log(`\nTunnel URL: ${url}`);
  console.log(`Set KILOCODE_API_BASE_URL=${apiUrl}`);

  // Only capture once
  urlPattern = null;
}

child.stdout.on('data', handleOutput);
child.stderr.on('data', handleOutput);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => child.kill(signal));
}

child.on('close', code => {
  process.exit(code ?? 1);
});
