import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const envDevLocalPath = path.join(repoRoot, 'apps/web/.env.development.local');

export type BitbucketWebhookTunnelPlan =
  | {
      mode: 'quick';
      cloudflaredArgs: string[];
      webhookBaseUrl: null;
    }
  | {
      mode: 'named';
      cloudflaredArgs: string[];
      webhookBaseUrl: string;
      label: string;
    };

type ConfigPaths = {
  globalPath: string;
  localPath: string;
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
    throw new Error(`Invalid Bitbucket webhook tunnel hostname: ${value}`);
  }
}

function defaultConfigPaths(): ConfigPaths {
  return {
    globalPath: path.join(os.homedir(), '.config/kiloclaw/dev-start.conf'),
    localPath: path.join(repoRoot, 'services/kiloclaw/scripts/.dev-start.conf'),
  };
}

function loadTunnelConfig(paths: ConfigPaths = defaultConfigPaths()): Record<string, string> {
  return {
    ...parseConfFile(paths.globalPath),
    ...parseConfFile(paths.localPath),
  };
}

export function resolveBitbucketWebhookTunnelPlan(
  config: Record<string, string>,
  port: string
): BitbucketWebhookTunnelPlan {
  const tunnelConfig = expandHome(
    config['BITBUCKET_CODE_REVIEW_TUNNEL_CONFIG'] ?? config['TUNNEL_CONFIG'] ?? ''
  );
  const tunnelName = config['BITBUCKET_CODE_REVIEW_TUNNEL_NAME'] ?? config['TUNNEL_NAME'] ?? '';

  if (tunnelConfig || tunnelName) {
    const webhookBaseUrl = originFromHostname(
      config['BITBUCKET_CODE_REVIEW_WEBHOOK_BASE_URL'] ??
        config['BITBUCKET_CODE_REVIEW_WEBHOOK_HOSTNAME'] ??
        config['TUNNEL_APP_HOSTNAME'] ??
        config['TUNNEL_HOSTNAME'] ??
        ''
    );
    if (!webhookBaseUrl) {
      throw new Error(
        'Named Bitbucket webhook tunnel requires BITBUCKET_CODE_REVIEW_WEBHOOK_HOSTNAME, BITBUCKET_CODE_REVIEW_WEBHOOK_BASE_URL, TUNNEL_APP_HOSTNAME, or TUNNEL_HOSTNAME.'
      );
    }

    return {
      mode: 'named',
      cloudflaredArgs: tunnelConfig
        ? ['tunnel', '--config', tunnelConfig, 'run']
        : ['tunnel', 'run', tunnelName],
      webhookBaseUrl,
      label: tunnelConfig || tunnelName,
    };
  }

  return {
    mode: 'quick',
    cloudflaredArgs: ['tunnel', '--url', `http://localhost:${port}`],
    webhookBaseUrl: null,
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

function main(): void {
  if (spawnSync('cloudflared', ['version'], { stdio: 'ignore' }).error) {
    console.error(
      'cloudflared not found on PATH. Install it:\n  https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/\n  brew install cloudflared'
    );
    process.exit(1);
  }

  const port = process.argv[2] ?? '3000';
  let plan: BitbucketWebhookTunnelPlan;
  try {
    plan = resolveBitbucketWebhookTunnelPlan(loadTunnelConfig(), port);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  const child = spawn('cloudflared', plan.cloudflaredArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (plan.mode === 'named') {
    updateEnvValue(envDevLocalPath, 'BITBUCKET_CODE_REVIEW_WEBHOOK_BASE_URL', plan.webhookBaseUrl);
    console.log(`Named Bitbucket webhook tunnel: ${plan.label}`);
    console.log(`Bitbucket webhook tunnel URL: ${plan.webhookBaseUrl}`);
    console.log(`Set BITBUCKET_CODE_REVIEW_WEBHOOK_BASE_URL=${plan.webhookBaseUrl}`);

    child.stdout.on('data', data => process.stderr.write(data));
    child.stderr.on('data', data => process.stderr.write(data));
  } else {
    console.log(`Starting Bitbucket webhook tunnel -> http://localhost:${port}...`);

    let urlPattern: RegExp | null = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

    function handleOutput(data: Buffer) {
      process.stderr.write(data);

      if (!urlPattern) return;
      const match = data.toString().match(urlPattern);
      if (!match) return;

      const url = match[0];
      updateEnvValue(envDevLocalPath, 'BITBUCKET_CODE_REVIEW_WEBHOOK_BASE_URL', url);

      console.log(`\nBitbucket webhook tunnel URL: ${url}`);
      console.log(`Set BITBUCKET_CODE_REVIEW_WEBHOOK_BASE_URL=${url}`);

      urlPattern = null;
    }

    child.stdout.on('data', handleOutput);
    child.stderr.on('data', handleOutput);
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => child.kill(signal));
  }

  child.on('close', code => {
    process.exit(code ?? 1);
  });
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main();
}
