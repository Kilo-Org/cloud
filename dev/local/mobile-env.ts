import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { detectLanIp, isUsableIpv4 } from './lan-ip';
import { services } from './services';

const MOBILE_ENV_REL_PATH = 'apps/mobile/.env.local';
const MOBILE_ENV_EXAMPLE_REL_PATH = 'apps/mobile/.env.local.example';
const ROOT_ENV_REL_PATH = '.env.local';

const URL_KEY_TO_SERVICE = new Map<string, { service: string; protocol: 'http' | 'ws' }>([
  ['API_BASE_URL', { service: 'nextjs', protocol: 'http' }],
  ['WEB_BASE_URL', { service: 'nextjs', protocol: 'http' }],
  ['CLOUD_AGENT_WS_URL', { service: 'cloud-agent-next', protocol: 'ws' }],
  ['SESSION_INGEST_WS_URL', { service: 'cloudflare-session-ingest', protocol: 'ws' }],
  ['KILO_CHAT_URL', { service: 'kilo-chat', protocol: 'http' }],
  ['EVENT_SERVICE_URL', { service: 'event-service', protocol: 'ws' }],
  ['NOTIFICATIONS_URL', { service: 'notifications', protocol: 'http' }],
]);

type MobileEnvValues = ReadonlyMap<string, string>;
type PreparedMobileEnvironment = {
  appUrl: string;
  sessionEnv: Record<string, string>;
};

function parseArgs(args: string[]): { host: string | undefined } {
  let host = process.env.MOBILE_DEV_HOST;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--host') {
      host = args[index + 1];
      index++;
    } else if (arg?.startsWith('--host=')) {
      host = arg.slice('--host='.length);
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: pnpm dev:env:mobile [--host <lan-ip>]');
      process.exit(0);
    }
  }
  return { host };
}

function serviceUrl(host: string, serviceName: string, protocol: 'http' | 'ws'): string {
  const service = services.get(serviceName);
  if (!service) {
    throw new Error(`Unknown service: ${serviceName}`);
  }
  return `${protocol}://${host}:${service.port}`;
}

function buildMobileEnvValues(host: string): MobileEnvValues {
  const values = new Map<string, string>();
  for (const [key, target] of URL_KEY_TO_SERVICE) {
    values.set(key, serviceUrl(host, target.service, target.protocol));
  }
  return values;
}

function applyEnvValues(content: string, values: MobileEnvValues): string {
  const seen = new Set<string>();
  const lines = content.split('\n').map(line => {
    const match = line.match(/^([A-Z0-9_]+)=/);
    if (!match) {
      return line;
    }
    const key = match[1];
    const value = values.get(key);
    if (value === undefined) {
      return line;
    }
    seen.add(key);
    return `${key}=${value}`;
  });

  for (const [key, value] of values) {
    if (!seen.has(key)) {
      lines.push(`${key}=${value}`);
    }
  }

  return `${lines.join('\n').replace(/\n*$/, '')}\n`;
}

function quoteEnvValue(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function upsertRootEnv(content: string, values: MobileEnvValues): string {
  const quotedValues = new Map(
    [...values.entries()].map(([key, value]) => [key, quoteEnvValue(value)] as const)
  );
  return applyEnvValues(content, quotedValues);
}

function writeMobileEnv(repoRoot: string, host: string): void {
  const examplePath = path.join(repoRoot, MOBILE_ENV_EXAMPLE_REL_PATH);
  const envPath = path.join(repoRoot, MOBILE_ENV_REL_PATH);
  if (!fs.existsSync(examplePath)) {
    throw new Error(`Missing ${MOBILE_ENV_EXAMPLE_REL_PATH}`);
  }

  const content = fs.readFileSync(examplePath, 'utf-8');
  fs.writeFileSync(envPath, applyEnvValues(content, buildMobileEnvValues(host)), 'utf-8');
}

function writeRootEnv(repoRoot: string, host: string): void {
  const envPath = path.join(repoRoot, ROOT_ENV_REL_PATH);
  if (!fs.existsSync(envPath)) {
    throw new Error(`Missing ${ROOT_ENV_REL_PATH}. Run: vercel env pull .env.local`);
  }

  const appUrl = serviceUrl(host, 'nextjs', 'http');
  const values = new Map([
    ['APP_URL_OVERRIDE', appUrl],
    ['NEXTAUTH_URL', appUrl],
  ]);
  const content = fs.readFileSync(envPath, 'utf-8');
  fs.writeFileSync(envPath, upsertRootEnv(content, values), 'utf-8');
}

function getWorktreePaths(repoRoot: string): string[] {
  const output = execFileSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return output
    .split('\n')
    .filter(line => line.startsWith('worktree '))
    .map(line => line.slice('worktree '.length));
}

function ensureRootEnv(repoRoot: string, worktreePaths?: string[]): void {
  const envPath = path.join(repoRoot, ROOT_ENV_REL_PATH);
  if (fs.existsSync(envPath)) return;

  const primaryWorktree = (worktreePaths ?? getWorktreePaths(repoRoot))[0];
  const sourcePath = primaryWorktree && path.join(primaryWorktree, ROOT_ENV_REL_PATH);
  if (
    sourcePath &&
    path.resolve(primaryWorktree) !== path.resolve(repoRoot) &&
    fs.existsSync(sourcePath)
  ) {
    fs.copyFileSync(sourcePath, envPath);
    console.log(`Copied ${ROOT_ENV_REL_PATH} from primary worktree`);
    return;
  }

  throw new Error(
    `Missing ${ROOT_ENV_REL_PATH} in this worktree and the primary worktree. Run pnpm dev:worktree:prepare.`
  );
}

function prepareMobileEnvironment(repoRoot: string, host: string): PreparedMobileEnvironment {
  if (!isUsableIpv4(host)) {
    throw new Error(`Invalid mobile development host: ${host}`);
  }
  ensureRootEnv(repoRoot);
  writeMobileEnv(repoRoot, host);
  writeRootEnv(repoRoot, host);

  const mobileValues = buildMobileEnvValues(host);
  const appUrl = serviceUrl(host, 'nextjs', 'http');
  return {
    appUrl,
    sessionEnv: Object.fromEntries(mobileValues),
  };
}

function findRepoRoot(): string {
  let dir = import.meta.dirname;
  for (let i = 0; i < 20; i++) {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { name?: string };
      if (pkg.name === 'kilocode-monorepo') {
        return dir;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  throw new Error("Could not find repo root (package.json with name 'kilocode-monorepo')");
}

function main(): void {
  const { host: hostArg } = parseArgs(process.argv.slice(2));
  const host = hostArg ?? detectLanIp();
  if (!isUsableIpv4(host)) {
    throw new Error(
      'Could not detect LAN IP. Pass one explicitly: pnpm dev:env:mobile -- --host 192.168.x.x'
    );
  }

  const repoRoot = findRepoRoot();
  const { appUrl } = prepareMobileEnvironment(repoRoot, host);
  console.log(`Wrote ${MOBILE_ENV_REL_PATH}`);
  console.log(`Updated ${ROOT_ENV_REL_PATH} APP_URL_OVERRIDE and NEXTAUTH_URL`);
  console.log(`Mobile web/API base URL: ${appUrl}`);
  console.log('Restart Next.js after changing this while dev is running: pnpm dev:restart nextjs');
  console.log('Reload or restart the mobile dev build so Expo reads apps/mobile/.env.local.');
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(import.meta.dirname, 'mobile-env.ts');

if (isMain) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

export {
  applyEnvValues,
  buildMobileEnvValues,
  detectLanIp,
  ensureRootEnv,
  isUsableIpv4,
  prepareMobileEnvironment,
  serviceUrl,
  upsertRootEnv,
};
export type { PreparedMobileEnvironment };
