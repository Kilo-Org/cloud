import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const devVarsPath = path.join(repoRoot, 'cloudflare-app-builder/.dev.vars');
const envDevLocalPath = path.join(repoRoot, '.env.development.local');

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

const port = process.argv[2] ?? '8790';

const child = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${port}`], {
  stdio: ['ignore', 'pipe', 'pipe'],
});

console.log(`Starting quick tunnel -> http://localhost:${port}...`);

let urlPattern: RegExp | null = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

function handleOutput(data: Buffer) {
  process.stderr.write(data);

  if (!urlPattern) return;
  const match = data.toString().match(urlPattern);
  if (!match) return;

  const url = match[0];
  const hostname = url.replace('https://', '');
  updateEnvValue(devVarsPath, 'BUILDER_HOSTNAME', hostname);
  updateEnvValue(envDevLocalPath, 'APP_BUILDER_URL', url);

  console.log(`\nTunnel URL: ${url}`);
  console.log(`Set BUILDER_HOSTNAME=${hostname}`);
  console.log(`Set APP_BUILDER_URL=${url}`);

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
