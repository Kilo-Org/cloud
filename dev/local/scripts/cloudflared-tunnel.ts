import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';

export type CloudflaredTunnelOptions = {
  port: string;
  onCapture: (url: string) => void;
  namedTunnel?: {
    name: string;
    hostname?: string;
  };
};

function isFileNotFoundError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export function updateEnvValue(filePath: string, key: string, value: string): void {
  let content = '';
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (error) {
    if (!isFileNotFoundError(error)) throw error;
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

export function ensureCloudflared(): void {
  if (spawnSync('cloudflared', ['version'], { stdio: 'ignore' }).error) {
    console.error(
      'cloudflared not found on PATH. Install it:\n  https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/\n  brew install cloudflared'
    );
    process.exit(1);
  }
}

export function startCloudflaredTunnel(options: CloudflaredTunnelOptions): void {
  const namedTunnel = options.namedTunnel;
  const args = namedTunnel
    ? ['tunnel', 'run', namedTunnel.name]
    : ['tunnel', '--url', `http://localhost:${options.port}`];

  let urlPattern: RegExp | null = namedTunnel ? null : /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

  if (namedTunnel) {
    console.log(`Named tunnel: ${namedTunnel.name} -> ${namedTunnel.hostname ?? ''}`);
    if (namedTunnel.hostname) {
      options.onCapture(`https://${namedTunnel.hostname}`);
    }
  } else {
    console.log(`Starting quick tunnel -> http://localhost:${options.port}...`);
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
    options.onCapture(url);
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
}
