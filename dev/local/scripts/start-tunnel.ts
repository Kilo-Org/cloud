import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const devVarsPath = path.join(repoRoot, 'services/kiloclaw/.dev.vars');
const envLocalPath = path.join(repoRoot, '.env.local');

type TunnelConfig = {
  tunnelName: string;
  tunnelConfig: string;
  tunnelHostname: string;
  appHostname: string;
  kiloclawHostname: string;
  kiloChatHostname: string;
  updateAppEnv: boolean;
};

const DOCKER_HOST_INTERNAL = 'host.docker.internal';
const DOCKER_LOCAL_PROVIDER = 'docker-local';

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
    tunnelConfig: expandHome(merged['TUNNEL_CONFIG'] ?? ''),
    tunnelHostname: merged['TUNNEL_HOSTNAME'] ?? '',
    appHostname: merged['TUNNEL_APP_HOSTNAME'] ?? merged['TUNNEL_HOSTNAME'] ?? '',
    kiloclawHostname: merged['TUNNEL_KILOCLAW_HOSTNAME'] ?? merged['TUNNEL_HOSTNAME'] ?? '',
    kiloChatHostname: merged['TUNNEL_KILOCHAT_HOSTNAME'] ?? merged['TUNNEL_HOSTNAME'] ?? '',
    updateAppEnv: merged['TUNNEL_UPDATE_APP_ENV'] !== 'false',
  };
}

function expandHome(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function originFromHostname(value: string): string | null {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) return null;

  try {
    if (/^https?:\/\//.test(trimmed)) {
      return new URL(trimmed).origin;
    }
    return new URL(`https://${trimmed}`).origin;
  } catch {
    throw new Error(`Invalid tunnel hostname: ${value}`);
  }
}

function updateEnvValue(filePath: string, key: string, value: string): void {
  let content = '';
  if (fs.existsSync(filePath)) {
    content = fs.readFileSync(filePath, 'utf-8');
  }

  const lines = content.split('\n');
  const nextLines: string[] = [];
  let replaced = false;
  let replacedComment = false;

  for (const [index, line] of lines.entries()) {
    if (line === '' && index === lines.length - 1) continue;
    const trimmed = line.trimStart();
    if (!replaced && line.startsWith(`${key}=`)) {
      nextLines.push(`${key}=${value}`);
      replaced = true;
      continue;
    }
    if (!replaced && !replacedComment && trimmed.startsWith(`# ${key}=`)) {
      nextLines.push(`${key}=${value}`);
      replaced = true;
      replacedComment = true;
      continue;
    }
    if (line.startsWith(`${key}=`)) {
      continue;
    }
    nextLines.push(line);
  }

  if (!replaced) {
    if (nextLines.length > 0 && nextLines[nextLines.length - 1] !== '') {
      nextLines.push('');
    }
    nextLines.push(`${key}=${value}`);
  }

  fs.writeFileSync(filePath, `${nextLines.join('\n').replace(/\n+$/, '')}\n`);
}

function readEnvValueFromFile(filePath: string, key: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  for (const line of fs.readFileSync(filePath, 'utf-8').split('\n')) {
    if (line.startsWith(`${key}=`)) {
      return line.slice(key.length + 1);
    }
  }
  return null;
}

function appendEnvListValues(filePath: string, key: string, values: string[]): void {
  const existing = readEnvValueFromFile(filePath, key);
  const entries = new Set(
    (existing ?? '')
      .split(',')
      .map(value => value.trim())
      .filter(Boolean)
  );
  for (const value of values) {
    if (value) entries.add(value);
  }
  if (entries.size > 0) {
    updateEnvValue(filePath, key, [...entries].join(','));
  }
}

function loadKiloClawProvider(): string {
  return parseConfFile(devVarsPath)['KILOCLAW_DEFAULT_PROVIDER'] ?? DOCKER_LOCAL_PROVIDER;
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

const port = process.argv[2] ?? '3000';
const controllerPort = process.argv[3] ?? '8795';
const kiloChatPort = process.argv[4] ?? '8808';
const config = loadTunnelConfig();
const provider = loadKiloClawProvider();

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

if (provider === DOCKER_LOCAL_PROVIDER) {
  const apiUrl = `http://${DOCKER_HOST_INTERNAL}:${port}/api/gateway/`;
  const checkinUrl = `http://${DOCKER_HOST_INTERNAL}:${controllerPort}/api/controller/checkin`;
  const kiloChatUrl = `http://${DOCKER_HOST_INTERNAL}:${kiloChatPort}`;

  updateEnvValue(devVarsPath, 'KILOCODE_API_BASE_URL', apiUrl);
  updateEnvValue(devVarsPath, 'KILOCLAW_CHECKIN_URL', checkinUrl);
  updateEnvValue(devVarsPath, 'KILOCHAT_BASE_URL', kiloChatUrl);

  console.log('Docker-local provider detected; skipping Cloudflare quick tunnels.');
  console.log(`Set KILOCODE_API_BASE_URL=${apiUrl}`);
  console.log(`Set KILOCLAW_CHECKIN_URL=${checkinUrl}`);
  console.log(`Set KILOCHAT_BASE_URL=${kiloChatUrl}`);

  setInterval(() => undefined, 60_000);
} else if (spawnSync('cloudflared', ['version'], { stdio: 'ignore' }).error) {
  console.error(
    'cloudflared not found on PATH. Install it:\n  https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/\n  brew install cloudflared'
  );
  process.exit(1);
}

if (provider !== DOCKER_LOCAL_PROVIDER && (config.tunnelName || config.tunnelConfig)) {
  const label = 'kiloclaw-tunnel';
  const args = config.tunnelConfig
    ? ['tunnel', '--config', config.tunnelConfig, 'run']
    : ['tunnel', 'run', config.tunnelName];
  const child = spawn('cloudflared', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  trackChild(label, child);

  const appOrigin = originFromHostname(config.appHostname);
  const kiloclawOrigin = originFromHostname(config.kiloclawHostname);
  const kiloChatOrigin = originFromHostname(config.kiloChatHostname);

  console.log(
    `Named tunnel: ${config.tunnelConfig || config.tunnelName}` +
      `${appOrigin ? `\n  app      -> ${appOrigin}` : ''}` +
      `${kiloclawOrigin ? `\n  kiloclaw -> ${kiloclawOrigin}` : ''}` +
      `${kiloChatOrigin ? `\n  kilochat -> ${kiloChatOrigin}` : ''}`
  );

  if (appOrigin) {
    const apiUrl = `${appOrigin}/api/gateway/`;
    updateEnvValue(devVarsPath, 'BACKEND_API_URL', appOrigin);
    updateEnvValue(devVarsPath, 'KILOCODE_API_BASE_URL', apiUrl);
    console.log(`Set BACKEND_API_URL=${appOrigin}`);
    console.log(`Set KILOCODE_API_BASE_URL=${apiUrl}`);

    if (config.updateAppEnv) {
      updateEnvValue(envLocalPath, 'APP_URL_OVERRIDE', appOrigin);
      updateEnvValue(envLocalPath, 'NEXTAUTH_URL', appOrigin);
      console.log(`Set APP_URL_OVERRIDE=${appOrigin}`);
      console.log(`Set NEXTAUTH_URL=${appOrigin}`);
    }
  }

  if (kiloclawOrigin) {
    const checkinUrl = `${kiloclawOrigin}/api/controller/checkin`;
    updateEnvValue(devVarsPath, 'KILOCLAW_CHECKIN_URL', checkinUrl);
    console.log(`Set KILOCLAW_CHECKIN_URL=${checkinUrl}`);

    if (config.updateAppEnv) {
      updateEnvValue(envLocalPath, 'KILOCLAW_API_URL', kiloclawOrigin);
      console.log(`Set KILOCLAW_API_URL=${kiloclawOrigin}`);
    }
  }

  if (kiloChatOrigin) {
    updateEnvValue(devVarsPath, 'KILOCHAT_BASE_URL', kiloChatOrigin);
    console.log(`Set KILOCHAT_BASE_URL=${kiloChatOrigin}`);
  }

  appendEnvListValues(
    devVarsPath,
    'OPENCLAW_ALLOWED_ORIGINS',
    [appOrigin, kiloclawOrigin, kiloChatOrigin].filter((origin): origin is string => !!origin)
  );

  child.stdout.on('data', data => prefixAndWrite(label, data));
  child.stderr.on('data', data => prefixAndWrite(label, data));
  child.on('close', code => exitAndStopOthers(label, code));
} else if (provider !== DOCKER_LOCAL_PROVIDER) {
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
  process.on(signal, () => {
    stopAllChildren(signal);
    if (children.length === 0) {
      process.exit(0);
    }
  });
}
