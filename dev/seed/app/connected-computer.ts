import { execFileSync } from 'node:child_process';
import { posix } from 'node:path';

import { kilocode_users } from '@kilocode/db/schema';
import { signKiloToken } from '@kilocode/worker-utils';
import { eq } from 'drizzle-orm';

import {
  listAgentsV1Schema,
  listDirectoriesV1Schema,
  remoteModelCatalogWireV1Schema,
  type RemoteModelCatalogWireV1,
} from '../../../packages/cloud-agent-sdk/src/schemas';
import {
  CLIInboundMessageSchema,
  CLIOutboundMessageSchema,
  type CLIOutboundMessage,
} from '../../../services/session-ingest/src/types/user-connection-protocol';
import type { SeedResult } from '../index';
import { assertLocalSeedDatabase, getSeedDb } from '../lib/db';
import { parseSessionIngestServiceStatus } from '../lib/mobile-sheet-fixtures';

export const usage = '<email> [seconds] [sessionIngestPort]';

const COMPUTER_NAME = 'Dev seed computer (read-only)';
const LAUNCH_DIRECTORY = '/workspace/new-session-fixture';
const DEEP_LINK = 'kiloapp:///(app)/agent-chat/new?preselectRunOn=computer';
const HEARTBEAT_INTERVAL_MS = 5_000;
const DEFAULT_SECONDS = 300;
const MAX_SECONDS = 3_600;
const PROVIDER_ID = 'dev-seed';
const MODEL_ID = 'read-only-preview';

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed app:connected-computer ${usage}`);
  console.log('');
  console.log('Uses an existing local fake account; does not create users or sessions.');
  console.log(`Connects a synthetic computer for 1-${MAX_SECONDS}s (default ${DEFAULT_SECONDS}).`);
  console.log('Requires local Postgres, NEXTAUTH_SECRET, and local session-ingest.');
  console.log('The port defaults to the running cloudflare-session-ingest dev:status entry.');
  console.log('Only model/agent catalogs and synthetic directory listings are served.');
  console.log('All session creation, execution, and other commands are explicitly refused.');
  console.log(`Open ${DEEP_LINK}, select this computer, then choose a launch folder.`);
  console.log(
    'Directory results are synthetic; no filesystem browsing, remote execution, or inference occurs.'
  );
}

function localDatabase() {
  assertLocalSeedDatabase('app:connected-computer');
  return getSeedDb();
}

function directoryListing(path: string) {
  const resolved = posix.resolve(LAUNCH_DIRECTORY, path || '.');
  let children: string[];
  switch (resolved) {
    case LAUNCH_DIRECTORY:
      children = ['apps', 'packages'];
      break;
    case `${LAUNCH_DIRECTORY}/apps`:
      children = ['mobile', 'web'];
      break;
    case `${LAUNCH_DIRECTORY}/packages`:
      children = ['shared'];
      break;
    case `${LAUNCH_DIRECTORY}/apps/mobile`:
    case `${LAUNCH_DIRECTORY}/apps/web`:
    case `${LAUNCH_DIRECTORY}/packages/shared`:
      children = [];
      break;
    default:
      throw new Error('invalid list_directories path');
  }
  return listDirectoriesV1Schema.parse({
    protocolVersion: 1,
    path: resolved,
    directories: children.map(name => ({ name, path: posix.join(resolved, name) })),
  });
}

function modelCatalog() {
  const textOnly = { text: true, audio: false, image: false, video: false, pdf: false };
  return remoteModelCatalogWireV1Schema.parse({
    protocolVersion: 1,
    all: [
      {
        id: PROVIDER_ID,
        name: 'Dev seed (read-only)',
        source: 'custom',
        env: [],
        options: {},
        models: {
          [MODEL_ID]: {
            id: MODEL_ID,
            providerID: PROVIDER_ID,
            api: { id: MODEL_ID, url: '', npm: '' },
            name: 'Read-only preview',
            capabilities: {
              temperature: false,
              reasoning: true,
              attachment: false,
              toolcall: false,
              input: textOnly,
              output: textOnly,
              interleaved: false,
            },
            cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
            limit: { context: 128_000, output: 8_000 },
            status: 'active',
            options: {},
            headers: {},
            release_date: '',
            variants: { low: {}, medium: {}, high: {} },
          },
        },
      },
    ],
    default: { [PROVIDER_ID]: MODEL_ID },
    connected: [PROVIDER_ID],
    failed: [],
    defaultModel: { providerID: PROVIDER_ID, modelID: MODEL_ID },
    currentModel: { model: { providerID: PROVIDER_ID, modelID: MODEL_ID }, variant: 'medium' },
    truncated: false,
  });
}

function readCommand(command: string, data: unknown, catalog: RemoteModelCatalogWireV1) {
  if (!['list_models', 'list_directories', 'list_agents'].includes(command)) {
    throw new Error(`Read-only dev fixture refuses command: ${command}`);
  }
  if (typeof data !== 'object' || data === null || !('protocolVersion' in data)) {
    throw new Error(`invalid ${command} request`);
  }
  if (data.protocolVersion !== 1) {
    throw new Error(`invalid ${command} request`);
  }
  if (command === 'list_models') return catalog;
  const path =
    command === 'list_agents'
      ? 'directory' in data
        ? data.directory
        : ''
      : 'path' in data
        ? data.path
        : '';
  if (typeof path !== 'string') throw new Error(`invalid ${command} request`);
  const listing = directoryListing(path);
  if (command === 'list_directories') return listing;
  return listAgentsV1Schema.parse({
    protocolVersion: 1,
    agents: [{ name: 'build' }, { name: 'plan' }],
  });
}

export async function run(...args: string[]): Promise<SeedResult | void> {
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }
  const email = args[0]?.trim().toLowerCase();
  if (!email || args.length > 3) {
    printUsage();
    throw new Error('An existing local fake-account email is required.');
  }
  const seconds = args[1] === undefined ? DEFAULT_SECONDS : Number(args[1]);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_SECONDS) {
    throw new Error(`seconds must be an integer from 1 to ${MAX_SECONDS}.`);
  }
  const db = localDatabase();
  const [user] = await db
    .select({ id: kilocode_users.id, apiTokenPepper: kilocode_users.api_token_pepper })
    .from(kilocode_users)
    .where(eq(kilocode_users.google_user_email, email))
    .limit(1);
  if (!user) throw new Error('No existing local user matches that email.');
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error('NEXTAUTH_SECRET is not set for this worktree.');

  let port = Number(args[2]);
  if (args[2] === undefined) {
    const status = parseSessionIngestServiceStatus(
      execFileSync('pnpm', ['-s', 'dev:status', '--json'], { encoding: 'utf8' })
    );
    if (status.status !== 'up')
      throw new Error('cloudflare-session-ingest must be running locally.');
    port = status.port;
  }
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('sessionIngestPort must be an integer from 1 to 65535.');
  }
  const catalog = modelCatalog();
  const { token } = await signKiloToken({
    userId: user.id,
    pepper: user.apiTokenPepper,
    secret,
    expiresInSeconds: seconds + 60,
    env: 'development',
  });
  const startedAt = new Date().toISOString();
  // Node's WebSocket accepts authenticated handshake options without putting the token in the URL.
  const socket = new WebSocket(`ws://localhost:${port}/api/user/cli`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const send = (message: CLIOutboundMessage) => {
    socket.send(JSON.stringify(CLIOutboundMessageSchema.parse(message)));
  };
  const heartbeat = () =>
    send({
      type: 'heartbeat',
      protocolVersion: '1',
      capabilities: { attachments: false, sessionClone: false, sessionCloneAtMessage: false },
      instance: {
        name: COMPUTER_NAME,
        projectName: LAUNCH_DIRECTORY,
        version: 'dev-seed',
        kind: 'remote',
        startedAt,
      },
      sessions: [],
    });
  let heartbeatTimer: NodeJS.Timeout | undefined;
  let durationTimer: NodeJS.Timeout | undefined;
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const openTimer = setTimeout(() => reject(new Error('CLI socket open timed out.')), 10_000);
  try {
    socket.addEventListener('error', () => reject(new Error('Local CLI socket failed.')));
    socket.addEventListener('close', () => reject(new Error('Local CLI socket closed early.')));
    socket.addEventListener(
      'open',
      () => {
        clearTimeout(openTimer);
        heartbeat();
        heartbeatTimer = setInterval(heartbeat, HEARTBEAT_INTERVAL_MS);
        durationTimer = setTimeout(resolve, seconds * 1_000);
        console.log(`Read-only computer connected for ${seconds}s. Open ${DEEP_LINK}`);
        console.log(`Choose ${COMPUTER_NAME}, then Folder > apps > mobile > Done.`);
      },
      { once: true }
    );
    socket.addEventListener('message', event => {
      let raw: unknown;
      try {
        raw = JSON.parse(String(event.data));
      } catch {
        reject(new Error('Local CLI socket sent invalid JSON.'));
        return;
      }
      const parsed = CLIInboundMessageSchema.safeParse(raw);
      if (!parsed.success) {
        reject(new Error('Local CLI socket sent an invalid protocol message.'));
        return;
      }
      const message = parsed.data;
      if (message.type !== 'command') return;
      try {
        const result = readCommand(message.command, message.data, catalog);
        console.log(`Served read-only ${message.command}`);
        send({
          type: 'response',
          id: message.id,
          result,
        });
      } catch (error) {
        send({
          type: 'response',
          id: message.id,
          error: error instanceof Error ? error.message : 'Read-only fixture refused command.',
        });
      }
    });
    await promise;
  } finally {
    clearTimeout(openTimer);
    clearTimeout(durationTimer);
    clearInterval(heartbeatTimer);
    socket.close();
  }
  return {
    userId: user.id,
    email,
    computerName: COMPUTER_NAME,
    launchDirectory: LAUNCH_DIRECTORY,
    seconds,
    deepLink: DEEP_LINK,
  };
}
