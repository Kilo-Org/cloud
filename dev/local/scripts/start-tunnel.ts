import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const devVarsPath = path.join(repoRoot, 'kiloclaw/.dev.vars');

type TunnelMode = {
  nameKey: string;
  hostnameKey: string;
  onUrl: ((url: string) => void) | null;
};

const TUNNEL_MODES = {
  nextjs: {
    nameKey: 'TUNNEL_NAME',
    hostnameKey: 'TUNNEL_HOSTNAME',
    onUrl: (url: string) =>
      updateEnvValue(devVarsPath, 'KILOCODE_API_BASE_URL', `${url}/api/gateway/`),
  },
  worker: {
    nameKey: 'WORKER_TUNNEL_NAME',
    hostnameKey: 'WORKER_TUNNEL_HOSTNAME',
    onUrl: (url: string) =>
      updateEnvValue(devVarsPath, 'KILOCLAW_CHECKIN_URL', `${url}/api/controller/checkin`),
  },
} satisfies Record<string, TunnelMode>;

type ModeName = keyof typeof TUNNEL_MODES;

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

function loadConf(): Record<string, string> {
  const globalPath = path.join(os.homedir(), '.config/kiloclaw/dev-start.conf');
  const localPath = path.join(repoRoot, 'kiloclaw/scripts/.dev-start.conf');
  return { ...parseConfFile(globalPath), ...parseConfFile(localPath) };
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

const modeArg = process.argv[2];
const modeName: ModeName = modeArg === 'worker' ? 'worker' : 'nextjs';
// For worker mode: argv[2]='worker', argv[3]=port
// For nextjs mode: argv[2]=port (no mode prefix)
const port =
  modeName === 'worker'
    ? (process.argv[3] ?? '8795')
    : (modeArg ?? '3000');
const mode = TUNNEL_MODES[modeName];
const conf = loadConf();
const tunnelName = conf[mode.nameKey] ?? '';
const tunnelHostname = conf[mode.hostnameKey] ?? '';

let args: string[];
let urlPattern: RegExp | null = null;

if (tunnelName) {
  args = ['tunnel', 'run', tunnelName];
  console.log(`Named tunnel: ${tunnelName} -> ${tunnelHostname}`);

  if (mode.onUrl && tunnelHostname) {
    mode.onUrl(`https://${tunnelHostname}`);
  }
} else {
  args = ['tunnel', '--url', `http://localhost:${port}`];
  urlPattern = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
  console.log(`Starting quick tunnel -> http://localhost:${port}...`);
}

const child = spawn('cloudflared', args, {
  stdio: ['ignore', 'pipe', 'pipe'],
});

function handleOutput(data: Buffer) {
  process.stderr.write(data);

  if (!urlPattern) return;
  const match = data.toString().match(urlPattern);
  if (!match) return;

  const url = match[0];
  mode.onUrl?.(url);

  console.log(`\nTunnel URL: ${url}`);
  if (mode.onUrl) {
    console.log(`Set KILOCODE_API_BASE_URL=${url}/api/gateway/`);
  }

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
