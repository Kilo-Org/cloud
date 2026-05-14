import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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

function isUsableIpv4(value: string | undefined): value is string {
  if (typeof value !== 'string' || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) {
    return false;
  }

  return value.split('.').every(part => Number(part) <= 255);
}

function detectLanIp(): string | undefined {
  try {
    const routeOutput = execFileSync('route', ['-n', 'get', 'default'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const iface = routeOutput.match(/interface:\s*(\S+)/)?.[1];
    if (iface) {
      const ip = execFileSync('ipconfig', ['getifaddr', iface], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (isUsableIpv4(ip)) {
        return ip;
      }
    }
  } catch {
    // Fall through to Node's cross-platform interface scan.
  }

  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal && isUsableIpv4(address.address)) {
        return address.address;
      }
    }
  }
  return undefined;
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
  writeMobileEnv(repoRoot, host);
  writeRootEnv(repoRoot, host);

  const appUrl = serviceUrl(host, 'nextjs', 'http');
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

export { applyEnvValues, buildMobileEnvValues, detectLanIp, isUsableIpv4, upsertRootEnv };
