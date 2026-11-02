/**
 * Live local Cloud stack discovery shared by the local-Kilo harness and the
 * fixture provider. Ports come only from `pnpm dev:status --json`; there is no
 * hardcoded-port or production-origin fallback.
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { loadRepoEnvFiles } from './auth.js';
import { FixtureProviderError } from './fixture-contract.js';

export const REQUIRED_STACK_SERVICES = [
  'nextjs',
  'cloud-agent-next',
  'ai-gateway',
  'fake-llm',
  'postgres',
  // Sandbox preparation calls this service; a down meter fails a cold start late.
  'container-usage-meter',
] as const;

export type LocalStack = {
  service: string;
  root: string;
  web: string;
  worker: string;
  gateway: string;
  fake: string;
  sessionIngest?: string;
  events?: string;
  postgres: number;
  database: string;
};

export type LocalStackOptions = {
  service?: string;
  root?: string;
  attempts?: number;
  probeHealth?: boolean;
};

const statusSchema = z.object({
  services: z.array(z.object({ name: z.string(), port: z.number(), status: z.string() })),
});

type StackStatus = z.infer<typeof statusSchema>;

function defaultServiceDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
}

function readStatus(root: string): StackStatus {
  return statusSchema.parse(
    JSON.parse(
      execFileSync('pnpm', ['-s', 'dev:status', '--json'], {
        cwd: root,
        encoding: 'utf8',
        timeout: 30_000,
      })
    )
  );
}

function notReady(status: StackStatus | undefined, lastError: unknown): string {
  if (!status) {
    return `Local stack is not ready: ${lastError instanceof Error ? lastError.message : String(lastError)}. Start it with \`pnpm dev:start cloud-agent\`.`;
  }
  const down = REQUIRED_STACK_SERVICES.filter(
    name => !status.services.some(entry => entry.name === name && entry.status === 'up')
  );
  return `Local stack is not ready: missing or down services: ${down.join(', ') || 'unknown'}. Start the stack with \`pnpm dev:start cloud-agent\`.`;
}

/** Validate that a database URL belongs to the discovered local postgres. */
export function assertLocalDatabase(database: string, postgresPort: number): void {
  let target: URL;
  try {
    target = new URL(database);
  } catch {
    throw new FixtureProviderError(
      'database_mismatch',
      'POSTGRES_URL/DATABASE_URL is not a valid database URL; refusing to verify fixture ownership'
    );
  }
  const host = target.hostname;
  if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) {
    throw new FixtureProviderError(
      'database_mismatch',
      `refusing non-loopback database host ${host}; the fixture provider only works against the discovered local stack`
    );
  }
  if (Number(target.port) !== postgresPort) {
    throw new FixtureProviderError(
      'database_mismatch',
      `Database does not belong to the discovered local stack: URL port ${target.port || '(default)'} but the stack postgres is ${postgresPort}. Run \`pnpm dev:env\` for this worktree.`
    );
  }
}

export async function discoverLocalStack(options: LocalStackOptions = {}): Promise<LocalStack> {
  const service = options.service ?? defaultServiceDir();
  const root = options.root ?? path.resolve(service, '../..');
  const attempts = options.attempts ?? 6;
  let status: StackStatus | undefined;
  let lastError: unknown;
  // The status probe intermittently reports the whole stack down under load.
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const parsed = readStatus(root);
      if (
        REQUIRED_STACK_SERVICES.every(name =>
          parsed.services.some(entry => entry.name === name && entry.status === 'up')
        )
      ) {
        status = parsed;
        break;
      }
      status = parsed;
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts - 1) await delay(2_000);
  }
  if (!status) throw new FixtureProviderError('stack_unavailable', notReady(undefined, lastError));
  const requiredUp = REQUIRED_STACK_SERVICES.every(name =>
    status.services.some(entry => entry.name === name && entry.status === 'up')
  );
  if (!requiredUp) {
    throw new FixtureProviderError('stack_unavailable', notReady(status, lastError));
  }
  const port = (name: string) => {
    const entry = status.services.find(item => item.name === name && item.status === 'up');
    if (!entry || entry.port <= 0) {
      throw new FixtureProviderError('stack_unavailable', `Local service ${name} is not running`);
    }
    return entry.port;
  };
  const optionalPort = (name: string) => {
    const entry = status.services.find(item => item.name === name && item.status === 'up');
    return entry && entry.port > 0 ? entry.port : undefined;
  };
  const web = `http://localhost:${port('nextjs')}`;
  const worker = `http://localhost:${port('cloud-agent-next')}`;
  const gateway = `http://localhost:${port('ai-gateway')}`;
  const fake = `http://localhost:${port('fake-llm')}`;
  const postgres = port('postgres');
  if (options.probeHealth !== false) {
    const health = await fetch(`${worker}/health`, {
      signal: AbortSignal.timeout(10_000),
    }).catch((error: unknown) => {
      throw new FixtureProviderError(
        'stack_unavailable',
        `Cloud Worker health check failed: ${error instanceof Error ? error.message : String(error)}`
      );
    });
    if (!health.ok) {
      throw new FixtureProviderError(
        'stack_unavailable',
        `Cloud Worker health check failed: HTTP ${health.status}`
      );
    }
  }
  loadRepoEnvFiles(service);
  const database = process.env.POSTGRES_URL ?? process.env.DATABASE_URL;
  if (!database) {
    throw new FixtureProviderError(
      'database_mismatch',
      'POSTGRES_URL is required in the worktree .env.local; run `pnpm dev:env`'
    );
  }
  assertLocalDatabase(database, postgres);
  const sessionIngestPort = optionalPort('cloudflare-session-ingest');
  const eventsPort = optionalPort('event-service');
  return {
    service,
    root,
    web,
    worker,
    gateway,
    fake,
    ...(sessionIngestPort === undefined
      ? {}
      : { sessionIngest: `http://localhost:${sessionIngestPort}` }),
    ...(eventsPort === undefined ? {} : { events: `http://localhost:${eventsPort}` }),
    postgres,
    database,
  };
}
