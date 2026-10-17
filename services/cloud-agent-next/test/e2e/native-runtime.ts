/**
 * Native runtime driver: public production surface only.
 *
 * It drives the unified `start` / `send` tRPC procedures and the `/stream`
 * WebSocket, with the native `cloudflare-containers-standard-3` allocation, an
 * explicit `finalization.autoCommit: false`, `createdOnPlatform: cloud-agent-web`,
 * and `kilo/fake-deterministic`. It adds no `/__e2e` route and is not part of
 * the default SDK matrix.
 *
 * Proof is real: a `file:read` fake directive reads the fixture sentinel and
 * the driver requires the completed read tool echo for the cold turn and the
 * same-chat follow-up, plus the session export for both turns. Native
 * snapshot, index, managed-base, and containment evidence is unavailable from
 * the public surface locally, so the result is `unsupported` unless explicit
 * evidence is supplied; a transition is never reported as passing from
 * operator CLI hash claims.
 *
 * Usage:
 *   pnpm --filter cloud-agent-next run e2e:native -- --worker-url http://localhost:9494 \
 *     [--auth-file <0600 file> | --email <local user email>] \
 *     [--fake-llm-url http://localhost:9511] [--ingest-url http://localhost:9500] \
 *     [--mode seed|restore] [--expected <value>] [--runtime-config <wrangler config>] \
 *     [--timeout-ms <n>]
 */

import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { parse as parseJsonc } from 'jsonc-parser';
import { z } from 'zod';

import { getSandboxAllocationRequest } from '@kilocode/worker-utils/sandbox-allocation';

import { CONTROL_PLANE_SUPERVISOR } from '../../src/shared/runtime-distribution.js';
import { RUNTIME_RELEASE_FORMAT, parseRuntimeRelease } from '../../src/shared/runtime-release.js';
import { computeDatabaseUrl } from '@kilocode/db';
import {
  DEFAULT_CONFIG,
  collectUntilTerminal,
  fakeDirective,
  deleteSession,
  failureReasonFromEvent,
  getMessageResult,
  openConnectedStream,
  trpcCall,
  type DriverConfig,
} from './client.js';
import { ensureTestUser, loadDevVars, loadRepoEnvFiles } from './auth.js';
import { fetchStreamTicket, loadDeployedAuthFile } from './deployed-auth.js';
import { awaitCorrelatedChildText } from './scenarios-shared.js';
import { parseFileReadEcho } from './scenario-assertions.js';
import { requireSessionExportTurn } from './session-export-check.js';
import {
  nativeFixtureSetupCommands,
  classifyNativeRun,
  nativeFixtureEnv,
  type NativeFixtureMode,
} from './native-runtime-support.js';

const SERVICE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NATIVE_ALLOCATION = 'cloudflare-containers-standard-3';
const SENTINEL_PATH = '.fx/sentinel';
const RUNTIME_JSON_PATH = '.fx/runtime.json';

type Options = {
  workerUrl: string;
  fakeLlmUrl: string;
  ingestUrl: string;
  gitUrl: string;
  model: string;
  authFile?: string;
  email?: string;
  mode: NativeFixtureMode;
  expected: string;
  timeoutMs: number;
  runtimeConfig?: string;
  runtimeEnvironment?: string;
  webUrl?: string;
};

function parseArgs(argv: string[]): Options {
  const options: Options = {
    workerUrl: process.env.NATIVE_DRIVER_WORKER_URL ?? DEFAULT_CONFIG.workerUrl,
    fakeLlmUrl: process.env.FAKE_LLM_URL ?? DEFAULT_CONFIG.fakeLlmUrl,
    ingestUrl: process.env.KILO_SESSION_INGEST_URL ?? process.env.SESSION_INGEST_WORKER_URL ?? '',
    gitUrl: process.env.NATIVE_DRIVER_GIT_URL ?? DEFAULT_CONFIG.gitUrl,
    model: DEFAULT_CONFIG.model,
    mode: 'restore',
    expected: 'kilo-native-fixture',
    timeoutMs: 240_000,
  };
  const flags: Record<string, (value: string) => void> = {
    '--worker-url': value => (options.workerUrl = value),
    '--fake-llm-url': value => (options.fakeLlmUrl = value),
    '--ingest-url': value => (options.ingestUrl = value),
    '--git-url': value => (options.gitUrl = value),
    '--model': value => (options.model = value),
    '--auth-file': value => (options.authFile = value),
    '--email': value => (options.email = value),
    '--mode': value => (options.mode = value as NativeFixtureMode),
    '--expected': value => (options.expected = value),
    '--runtime-config': value => (options.runtimeConfig = value),
    '--env': value => (options.runtimeEnvironment = value),
    '--web-url': value => (options.webUrl = value),
    '--timeout-ms': value => (options.timeoutMs = Number(value)),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    const eq = arg.indexOf('=');
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const handler = flags[flag];
    if (!handler) throw new Error(`unknown argument ${arg}`);
    const value = eq === -1 ? argv[(index += 1)] : arg.slice(eq + 1);
    if (value === undefined) throw new Error(`${flag} requires a value`);
    handler(value);
  }
  if (options.mode !== 'seed' && options.mode !== 'restore')
    throw new Error('--mode must be seed or restore');
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 600_000)
    throw new Error('--timeout-ms must be a positive integer up to 600000');
  if (options.expected.length > 256) throw new Error('--expected must be at most 256 characters');
  if (options.ingestUrl === '' && isLoopback(new URL(options.workerUrl)))
    options.ingestUrl = 'http://localhost:9500';
  return options;
}

function assertLoopbackDatabase(): void {
  if (process.env.USE_PRODUCTION_DB === 'true')
    throw new Error('refusing production database mode');
  const expected = new URL(computeDatabaseUrl());
  const selected = new URL(process.env.DATABASE_URL ?? expected.href);
  if (
    !isLoopback(selected) ||
    selected.host !== expected.host ||
    selected.pathname !== expected.pathname
  )
    throw new Error('refusing a database outside the configured local worktree');
}

function isLoopback(url: URL): boolean {
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname);
}

export function assertDriverTarget(
  options: Pick<Options, 'workerUrl' | 'fakeLlmUrl' | 'ingestUrl' | 'authFile' | 'webUrl'>
): void {
  const worker = new URL(options.workerUrl);
  if (worker.username || worker.password || worker.pathname !== '/' || worker.search || worker.hash)
    throw new Error('the Worker target must be a bare origin');
  if (isLoopback(worker)) {
    if (!isLoopback(new URL(options.ingestUrl)) || !isLoopback(new URL(options.fakeLlmUrl)))
      throw new Error('local verification requires loopback ingest and model targets');
  } else if (
    options.authFile === undefined ||
    worker.protocol !== 'https:' ||
    !/^cloud-agent-next-[a-z0-9-]+-test\.engineering-e11\.workers\.dev$/.test(worker.hostname)
  ) {
    throw new Error(
      'non-local verification requires an explicit personal test Worker and auth file'
    );
  }
  if (!isLoopback(worker)) {
    if (options.ingestUrl === '')
      throw new Error('personal verification requires an explicit HTTPS --ingest-url');
    const ingest = new URL(options.ingestUrl);
    if (
      ingest.protocol !== 'https:' ||
      ingest.username ||
      ingest.password ||
      ingest.pathname !== '/' ||
      ingest.search ||
      ingest.hash
    )
      throw new Error('personal verification requires an explicit bare HTTPS ingest origin');
  }
  if (options.authFile !== undefined && options.webUrl !== undefined) {
    const web = new URL(options.webUrl);
    if (
      web.username ||
      web.password ||
      (isLoopback(worker) && !isLoopback(web)) ||
      (!isLoopback(web) && web.protocol !== 'https:')
    )
      throw new Error('the stream-ticket target does not match the selected environment');
  }
}

/**
 * Build the driver config. A `--auth-file` (0600 regular JSON) supplies an
 * ordinary personal token and identity with NO database access. The local mint
 * path loads repo env, requires a loopback database target, and uses a funded
 * owned synthetic user. There is no production fallback.
 */
export async function buildConfig(options: Options): Promise<DriverConfig> {
  assertDriverTarget(options);
  const base = {
    workerUrl: options.workerUrl,
    fakeLlmUrl: options.fakeLlmUrl,
    gitUrl: options.gitUrl,
    model: options.model,
    expectControlPlane: true,
  };
  if (options.authFile !== undefined) {
    const backendUrl = options.webUrl;
    if (backendUrl === undefined)
      throw new Error('--auth-file requires an explicit --web-url for stream tickets');
    const auth = loadDeployedAuthFile(options.authFile);
    return {
      ...base,
      user: { id: auth.identity.userId, email: auth.identity.email },
      bearerToken: auth.token,
      fetchStreamTicket: sessionId =>
        fetchStreamTicket({ backendUrl, token: auth.token, sessionId }),
    };
  }
  const email = options.email ?? 'native-driver@cloud-agent-next-e2e.example.com';
  loadRepoEnvFiles(SERVICE_ROOT);
  assertLoopbackDatabase();
  const user = await ensureTestUser(process.env.DATABASE_URL ?? computeDatabaseUrl(), email, {
    funded: true,
  });
  const { NEXTAUTH_SECRET } = loadDevVars(SERVICE_ROOT);
  return { ...base, user, nextAuthSecret: NEXTAUTH_SECRET };
}

type StartResult = {
  cloudAgentSessionId: string;
  kiloSessionId: string;
  messageId: string;
  delivery: 'sent' | 'queued';
};

function opTag(runId: string, turn: number): string {
  return `native-${runId}-${turn}`.replace(/[^A-Za-z0-9-]/g, '-');
}

function readDirective(runId: string, turn: number, filePath: string): string {
  return fakeDirective(`file:read:${opTag(runId, turn)}:${filePath}`);
}

async function startNativeSession(
  config: DriverConfig,
  options: Options,
  directive: string
): Promise<StartResult> {
  const setupCommands = nativeFixtureSetupCommands();
  const started = await trpcCall<StartResult>(config, 'start', {
    message: { prompt: directive },
    agent: { mode: 'code', model: config.model },
    finalization: { autoCommit: false },
    repository: { type: 'git', url: config.gitUrl },
    profile: {
      overrides: {
        setupCommands,
        envVars: nativeFixtureEnv(options.mode, options.expected),
      },
    },
    runtime: { sandboxAllocation: getSandboxAllocationRequest(NATIVE_ALLOCATION) },
    options: { createdOnPlatform: 'cloud-agent-web' },
  });
  if (!started.cloudAgentSessionId.startsWith('workspace_'))
    throw new Error(
      `started ${started.cloudAgentSessionId}, but the native driver requires a workspace_* session`
    );
  return started;
}

async function pollStatus(
  config: DriverConfig,
  sessionId: string,
  messageId: string,
  timeoutMs: number
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let status = 'queued';
  while (Date.now() < deadline) {
    try {
      status = (await getMessageResult(config, sessionId, messageId)).status;
      if (status === 'completed' || status === 'failed' || status === 'interrupted') return status;
    } catch {
      // Not registered yet; keep polling until the deadline.
    }
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
  return status;
}

type MeasuredRuntime = {
  cliSha256: string;
  supervisorSha256: string;
  sentinel: string;
};

function parseMeasuredRuntime(text: string): MeasuredRuntime | null {
  const body = parseFileReadEcho(text, RUNTIME_JSON_PATH);
  if (body === null) return null;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    if (
      typeof parsed.cliSha256 !== 'string' ||
      typeof parsed.supervisorSha256 !== 'string' ||
      typeof parsed.sentinel !== 'string'
    )
      return null;
    return {
      cliSha256: parsed.cliSha256,
      supervisorSha256: parsed.supervisorSha256,
      sentinel: parsed.sentinel,
    };
  } catch {
    return null;
  }
}

/**
 * Compare measured selected bytes against the immutable descriptor inventory
 * (tuple index 4). Returns `'verified'` only on an exact match of the CLI
 * executable and the canonical control supervisor.
 */
function verifySelectedBytes(
  descriptorSource: string,
  measured: MeasuredRuntime
): 'verified' | 'unverified' | 'mismatch' {
  const bytes = new TextEncoder().encode(descriptorSource);
  const descriptor = parseRuntimeRelease(bytes);
  const cliEntry = descriptor.inventory.find(
    entry => entry[0] === 'cli' && entry[1] === descriptor.cliExecutable
  );
  const supervisorEntry = descriptor.inventory.find(
    entry => entry[0] === 'control' && entry[1].endsWith(`/${CONTROL_PLANE_SUPERVISOR.installName}`)
  );
  if (cliEntry === undefined || supervisorEntry === undefined) return 'unverified';
  if (cliEntry[4] !== measured.cliSha256 || supervisorEntry[4] !== measured.supervisorSha256)
    return 'mismatch';
  return 'verified';
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const config = await buildConfig(options);
  const runId = randomUUID();
  const coldPath = options.runtimeConfig === undefined ? SENTINEL_PATH : RUNTIME_JSON_PATH;
  const started = await startNativeSession(config, options, readDirective(runId, 1, coldPath));
  console.log(JSON.stringify({ admitted: started }));
  const stream = await openConnectedStream(config, started.cloudAgentSessionId, true);
  let passed = false;
  try {
    const cold = await collectUntilTerminal(stream, started.messageId, options.timeoutMs);
    const coldStatus = await pollStatus(
      config,
      started.cloudAgentSessionId,
      started.messageId,
      options.timeoutMs
    );
    if (coldStatus !== 'completed')
      throw new Error(`cold turn failed: ${failureReasonFromEvent(cold.terminal) ?? coldStatus}`);
    const coldText = await awaitCorrelatedChildText({
      stream,
      parentMessageId: started.messageId,
      timeoutMs: options.timeoutMs,
      label: 'cold file-read',
      ready: text => parseFileReadEcho(text, coldPath) !== null,
    });
    const measured = options.runtimeConfig === undefined ? null : parseMeasuredRuntime(coldText);
    const coldEcho = measured?.sentinel ?? parseFileReadEcho(coldText, coldPath);
    if (coldEcho !== options.expected)
      throw new Error('cold tool result did not preserve the fixture sentinel');
    await requireSessionExportTurn(
      {
        config,
        within: (_label, operation) => operation(new AbortController().signal),
      },
      {
        kiloSessionId: started.kiloSessionId,
        messageId: started.messageId,
        assistantMarker: coldText,
        sentinelPath: SENTINEL_PATH,
        sentinelContents: options.expected,
      },
      options.ingestUrl
    );

    const turn2 = 2;
    const followup = await trpcCall<{ messageId: string }>(config, 'send', {
      cloudAgentSessionId: started.cloudAgentSessionId,
      message: { prompt: readDirective(runId, turn2, SENTINEL_PATH) },
      agent: { mode: 'code', model: config.model },
      finalization: { autoCommit: false },
    });
    const follow = await collectUntilTerminal(stream, followup.messageId, options.timeoutMs);
    const followStatus = await pollStatus(
      config,
      started.cloudAgentSessionId,
      followup.messageId,
      options.timeoutMs
    );
    if (followStatus !== 'completed')
      throw new Error(
        `followup failed: ${failureReasonFromEvent(follow.terminal) ?? followStatus}`
      );
    const followText = await awaitCorrelatedChildText({
      stream,
      parentMessageId: followup.messageId,
      timeoutMs: options.timeoutMs,
      label: 'followup file-read',
      ready: text => parseFileReadEcho(text, SENTINEL_PATH) !== null,
    });
    const followEcho = parseFileReadEcho(followText, SENTINEL_PATH);
    if (followEcho !== options.expected)
      throw new Error('followup tool result did not preserve the fixture sentinel');
    await requireSessionExportTurn(
      {
        config,
        within: (_label, operation) => operation(new AbortController().signal),
      },
      {
        kiloSessionId: started.kiloSessionId,
        messageId: followup.messageId,
        assistantMarker: followText,
        sentinelPath: SENTINEL_PATH,
        sentinelContents: options.expected,
      },
      options.ingestUrl
    );

    let bytesVerified: 'verified' | 'unverified' | 'mismatch' = 'unverified';
    if (options.runtimeConfig !== undefined) {
      const source = await readFile(options.runtimeConfig, 'utf8');
      const environment =
        options.runtimeEnvironment ?? (isLoopback(new URL(options.workerUrl)) ? 'dev' : undefined);
      const descriptor = runtimeDescriptorFromConfig(source, environment);
      if (measured === null) throw new Error('selected runtime byte measurement is missing');
      bytesVerified = verifySelectedBytes(descriptor, measured);
      if (bytesVerified !== 'verified')
        throw new Error('selected runtime bytes do not match the immutable descriptor');
    }

    const outcome = classifyNativeRun({
      coldTurnCompleted: coldStatus === 'completed',
      coldToolTurnObserved: coldEcho !== null,
      followupCompleted: followStatus === 'completed',
    });
    passed = outcome.functional === 'pass';
    if (!passed) process.exitCode = 1;
    console.log(
      JSON.stringify(
        {
          cloudAgentSessionId: started.cloudAgentSessionId,
          coldStatus,
          coldEchoPresent: coldEcho !== null,
          followTerminal: follow.terminal?.streamEventType ?? null,
          followStatus,
          followEchoPresent: followEcho !== null,
          selectedBytes: bytesVerified,
          releaseFormat: RUNTIME_RELEASE_FORMAT,
          ...outcome,
        },
        null,
        2
      )
    );
  } finally {
    stream.close();
    if (passed) {
      const cleanup = await deleteSession(
        config,
        started.cloudAgentSessionId,
        AbortSignal.timeout(30_000)
      );
      console.log(
        JSON.stringify({
          cleanedUp: cleanup.success,
          cloudAgentSessionId: started.cloudAgentSessionId,
        })
      );
      if (!cleanup.success) process.exitCode = 1;
    }
  }
}

const runtimeConfigSchema = z
  .object({
    vars: z.record(z.string(), z.unknown()).optional(),
    env: z
      .record(
        z.string(),
        z.object({ vars: z.record(z.string(), z.unknown()).optional() }).passthrough()
      )
      .optional(),
  })
  .passthrough();

export function runtimeDescriptorFromConfig(source: string, environment?: string): string {
  const config = runtimeConfigSchema.parse(parseJsonc(source));
  const vars = environment === undefined ? config.vars : config.env?.[environment]?.vars;
  const descriptor = vars?.RUNTIME_RELEASE_DESCRIPTOR;
  if (typeof descriptor !== 'string')
    throw new Error('the selected runtime config has no descriptor for this environment');
  parseRuntimeRelease(descriptor);
  return descriptor;
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : 'native runtime driver failed');
    process.exitCode = 1;
  });
}

export { assertLoopbackDatabase, parseMeasuredRuntime, verifySelectedBytes };
