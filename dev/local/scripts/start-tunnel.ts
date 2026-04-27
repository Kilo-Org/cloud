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

function prefixAndWrite(label: string, chunk: Buffer): void {
  const text = chunk.toString();
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length === 0 && i === lines.length - 1) continue;
    process.stderr.write(`[${label}] ${line}\n`);
  }
}

if (spawnSync('cloudflared', ['version'], { stdio: 'ignore' }).error) {
  console.error(
    'cloudflared not found on PATH. Install it:\n  https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/\n  brew install cloudflared'
  );
  process.exit(1);
}

const port = process.argv[2] ?? '3000';
const controllerPort = process.argv[3] ?? '8795';
const kiloChatPort = process.argv[4] ?? '8808';
const config = loadTunnelConfig();

const children: Array<{ label: string; child: ReturnType<typeof spawn> }> = [];

function trackChild(label: string, child: ReturnType<typeof spawn>): void {
  children.push({ label, child });
}

function stopAllChildren(signal: NodeJS.Signals): void {
  for (const { child } of children) {
    child.kill(signal);
  }
}

let exiting = false;

function exitAndStopOthers(originLabel: string, code: number | null): void {
  if (exiting) return;
  exiting = true;
  for (const { label, child } of children) {
    if (label !== originLabel) {
      child.kill('SIGTERM');
    }
  }
  process.exit(code ?? 1);
}

function startQuickTunnel(options: {
  label: string;
  localPort: string;
  onUrl: (url: string) => void;
}): void {
  const { label, localPort, onUrl } = options;
  const child = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${localPort}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  trackChild(label, child);

  console.log(`Starting quick tunnel (${label}) -> http://localhost:${localPort}...`);

  let captured = false;
  const urlPattern = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
  const handleOutput = (data: Buffer) => {
    prefixAndWrite(label, data);

    if (captured) return;
    const match = data.toString().match(urlPattern);
    if (!match) return;

    captured = true;
    onUrl(match[0]);
  };

  child.stdout.on('data', handleOutput);
  child.stderr.on('data', handleOutput);
  child.on('close', code => exitAndStopOthers(label, code));
}

if (config.tunnelName) {
  const label = 'kiloclaw-tunnel';
  const child = spawn('cloudflared', ['tunnel', 'run', config.tunnelName], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  trackChild(label, child);

  console.log(`Named tunnel: ${config.tunnelName} -> ${config.tunnelHostname}`);

  if (config.tunnelHostname) {
    const apiUrl = `https://${config.tunnelHostname}/api/gateway/`;
    const checkinUrl = `https://${config.tunnelHostname}/api/controller/checkin`;
    const kiloChatUrl = `https://${config.tunnelHostname}`;
    updateEnvValue(devVarsPath, 'KILOCODE_API_BASE_URL', apiUrl);
    updateEnvValue(devVarsPath, 'KILOCLAW_CHECKIN_URL', checkinUrl);
    updateEnvValue(devVarsPath, 'KILOCHAT_BASE_URL', kiloChatUrl);
    console.log(`Set KILOCODE_API_BASE_URL=${apiUrl}`);
    console.log(`Set KILOCLAW_CHECKIN_URL=${checkinUrl}`);
    console.log(`Set KILOCHAT_BASE_URL=${kiloChatUrl}`);
  }

  child.stdout.on('data', data => prefixAndWrite(label, data));
  child.stderr.on('data', data => prefixAndWrite(label, data));
  child.on('close', code => exitAndStopOthers(label, code));
} else {
  startQuickTunnel({
    label: 'gateway',
    localPort: port,
    onUrl: url => {
      const apiUrl = `${url}/api/gateway/`;
      updateEnvValue(devVarsPath, 'KILOCODE_API_BASE_URL', apiUrl);
      console.log(`\nGateway tunnel URL: ${url}`);
      console.log(`Set KILOCODE_API_BASE_URL=${apiUrl}`);
    },
  });

  startQuickTunnel({
    label: 'controller',
    localPort: controllerPort,
    onUrl: url => {
      const checkinUrl = `${url}/api/controller/checkin`;
      updateEnvValue(devVarsPath, 'KILOCLAW_CHECKIN_URL', checkinUrl);
      console.log(`\nController tunnel URL: ${url}`);
      console.log(`Set KILOCLAW_CHECKIN_URL=${checkinUrl}`);
    },
  });

  startQuickTunnel({
    label: 'kilo-chat',
    localPort: kiloChatPort,
    onUrl: url => {
      updateEnvValue(devVarsPath, 'KILOCHAT_BASE_URL', url);
      console.log(`\nKilo-chat tunnel URL: ${url}`);
      console.log(`Set KILOCHAT_BASE_URL=${url}`);
    },
  });
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => stopAllChildren(signal));
}
