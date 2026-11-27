/**
 * Local end-to-end run of the identity-store login rotation (design 5.2): the mint Worker under
 * `wrangler dev` with `LOGIN_ROTATION=on`, a local Postgres with the migrations applied, a stand-in
 * secrets manager (JWT Auth login, create and describe in `/admin/identity-store` under a change
 * policy) and a stand-in Cloudflare API that holds the three Hyperdrive configs.
 *
 * The run triggers the Worker's cron (`/__scheduled`) once a second, approves each change request
 * a second after it opens, and proves:
 *
 * 1. Each config moves to its idle login (app, pat, reader to `_b`), then app moves back to `_a`:
 *    a full a -> b -> a rotation.
 * 2. Clients that loop queries never fail: one opens a new connection per query with the login and
 *    password the stand-in config holds, as Hyperdrive does for a new pool connection; one keeps
 *    the session it opened as `uts_app_a` before the first rotation.
 * 3. Each rotated login logs in with the password stored in the manager, its seed no longer works,
 *    and the manager received each value only through a change request.
 * 4. The rotation object ends idle, and no password appears in the Worker's log.
 *
 * Synthetic data only: every password is random for the run and none is printed.
 *
 *   UTS_E2E_ADMIN_URL  the local admin login (scripts/e2e-store.ts)
 *   UTS_E2E_PORT       first of the run's ports (default 9560): the Worker, its inspector, the
 *                      stand-in manager at +2 and the stand-in Cloudflare API at +3
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { UTS_ENDPOINTS } from '@kilocode/uts-contracts';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import pg from 'pg';
import { z } from 'zod';
import { MANAGER_IDENTITIES, MANAGER_JWKS_PATH } from '../src/manager/config';
import {
  CLOUDFLARE_ACCOUNT_ID,
  HYPERDRIVE_CONFIG_IDS,
  LOGIN_NAMES,
  type LoginName,
  POOL_LOGINS,
  ROTATION_POOLS,
  type RotationPool,
} from '../src/rotation/config';
import { openE2eStore } from './e2e-store';

const PORT = z.coerce
  .number()
  .int()
  .positive()
  .parse(process.env.UTS_E2E_PORT ?? '9560');
const MINT = `http://127.0.0.1:${PORT}`;
const MANAGER_PORT = PORT + 2;
const CLOUDFLARE_PORT = PORT + 3;
const DATABASE = 'uts_rotation_e2e';
const PERIOD_SECONDS = 3;
const DEADLINE_MS = 240_000;
const { identityId: IDENTITY_ID } = MANAGER_IDENTITIES.development;
const SWITCH_TOKEN = randomBytes(24).toString('base64url');

const UTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORK = mkdtempSync(join(tmpdir(), 'uts-rotation-e2e-'));
console.log(`run directory: ${WORK}`);

let failures = 0;
function check(condition: boolean, message: string): void {
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${message}`);
  if (!condition) failures += 1;
}

async function body(request: IncomingMessage): Promise<unknown> {
  request.setEncoding('utf8');
  let text = '';
  for await (const chunk of request) text += String(chunk);
  return JSON.parse(text || 'null');
}

function send(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
}

async function listen(
  port: number,
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>
) {
  const server = createServer((request, response) => {
    handler(request, response).catch(error => send(response, 500, { message: String(error) }));
  });
  const listening = Promise.withResolvers<void>();
  server.once('error', listening.reject);
  server.listen(port, '127.0.0.1', listening.resolve);
  await listening.promise;
  return server;
}

// ---- stand-in manager ------------------------------------------------------------------------

const ACCESS_TOKEN = randomBytes(24).toString('base64url');
const jwks = createRemoteJWKSet(new URL(`${MINT}${MANAGER_JWKS_PATH}`), { cacheMaxAge: 0 });
const CreateSchema = z.strictObject({
  projectId: z.string(),
  environment: z.literal('development'),
  secretPath: z.literal('/admin/identity-store'),
  secretValue: z.string().min(1),
  type: z.literal('shared'),
});
/** Approved secrets, and change requests with the time they opened. */
const managerSecrets = new Map<string, string>();
const changeRequests = new Map<string, { value: string; openedAt: number }>();
let changeRequestCount = 0;
/** The login seeds in `/db-switch/uts`, and how often each was read. */
const seedFolder = new Map<string, string>();
const seedReads = new Map<string, number>();

async function manager(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${MANAGER_PORT}`);
  if (request.method === 'POST' && url.pathname === '/api/v1/auth/jwt-auth/login') {
    const login = z
      .object({ identityId: z.literal(IDENTITY_ID), jwt: z.string() })
      .safeParse(await body(request));
    if (!login.success) return send(response, 400, { message: 'bad login' });
    try {
      await jwtVerify(login.data.jwt, jwks, {
        algorithms: ['ES256'],
        issuer: `${UTS_ENDPOINTS.development.issuer}/manager-auth`,
        subject: 'uts:development:rotation',
        audience: `https://eu.infisical.com/identities/${IDENTITY_ID}`,
      });
    } catch {
      return send(response, 401, { message: 'invalid jwt' });
    }
    return send(response, 200, { accessToken: ACCESS_TOKEN, expiresIn: 600, tokenType: 'Bearer' });
  }
  if (request.headers.authorization !== `Bearer ${ACCESS_TOKEN}`) {
    return send(response, 401, { message: 'no token' });
  }
  const name = url.pathname.match(/^\/api\/v4\/secrets\/([a-z0-9_]+)$/)?.[1];
  if (name === undefined) return send(response, 404, { message: 'no route' });
  if (request.method === 'POST') {
    const create = CreateSchema.safeParse(await body(request));
    if (!create.success) return send(response, 403, { message: 'outside /admin/identity-store' });
    if (managerSecrets.has(name) || changeRequests.has(name)) {
      return send(response, 400, { message: 'exists' });
    }
    changeRequests.set(name, { value: create.data.secretValue, openedAt: Date.now() });
    changeRequestCount += 1;
    return send(response, 200, {
      approval: { id: `approval-${changeRequestCount}`, status: 'open' },
    });
  }
  if (url.searchParams.get('secretPath') === '/db-switch/uts') {
    // The seed read of decision Q88: a value, from this folder only.
    if (url.searchParams.get('viewSecretValue') !== 'true') {
      return send(response, 400, { message: 'seed read asks for the value' });
    }
    seedReads.set(name, (seedReads.get(name) ?? 0) + 1);
    const seed = seedFolder.get(name);
    return seed === undefined
      ? send(response, 404, { message: 'Secret not found' })
      : send(response, 200, { secret: { id: name, secretKey: name, secretValue: seed } });
  }
  if (
    url.searchParams.get('secretPath') !== '/admin/identity-store' ||
    url.searchParams.get('viewSecretValue') !== 'false'
  ) {
    return send(response, 403, { message: 'describe only' });
  }
  return managerSecrets.has(name)
    ? send(response, 200, { secret: { id: name, secretKey: name } })
    : send(response, 404, { message: 'Secret not found' });
}

/** A secret admin approves each change request a second after it opened. */
function approveChangeRequests(): void {
  for (const [name, request] of changeRequests) {
    if (Date.now() - request.openedAt < 1000) continue;
    managerSecrets.set(name, request.value);
    changeRequests.delete(name);
  }
}

// ---- stand-in Cloudflare API -----------------------------------------------------------------

type Config = { user: LoginName; password: string };
const configs = new Map<string, Config>();
const switches: { pool: RotationPool; user: LoginName }[] = [];
const configPool = new Map<string, RotationPool>(
  ROTATION_POOLS.map(pool => [HYPERDRIVE_CONFIG_IDS.development[pool], pool])
);
const PatchSchema = z.strictObject({
  origin: z.strictObject({
    scheme: z.literal('postgres'),
    host: z.literal('127.0.0.1'),
    port: z.number(),
    database: z.literal(DATABASE),
    user: z.enum(LOGIN_NAMES),
    password: z.string().min(1),
  }),
});
let storePort = 0;

async function cloudflare(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.headers.authorization !== `Bearer ${SWITCH_TOKEN}`) {
    return send(response, 403, { success: false });
  }
  const match = (request.url ?? '').match(
    /^\/client\/v4\/accounts\/([a-f0-9]+)\/hyperdrive\/configs\/([a-z-]+)$/
  );
  const id = match?.[2];
  const pool = id === undefined ? undefined : configPool.get(id);
  const config = id === undefined ? undefined : configs.get(id);
  if (
    match?.[1] !== CLOUDFLARE_ACCOUNT_ID ||
    id === undefined ||
    pool === undefined ||
    config === undefined
  ) {
    return send(response, 404, { success: false });
  }
  if (request.method === 'PATCH') {
    const patch = PatchSchema.safeParse(await body(request));
    if (
      !patch.success ||
      !POOL_LOGINS[pool].includes(patch.data.origin.user) ||
      patch.data.origin.port !== storePort
    ) {
      return send(response, 400, { success: false });
    }
    configs.set(id, { user: patch.data.origin.user, password: patch.data.origin.password });
    switches.push({ pool, user: patch.data.origin.user });
  } else if (request.method !== 'GET') {
    return send(response, 405, { success: false });
  }
  const current = configs.get(id) ?? config;
  return send(response, 200, {
    success: true,
    result: {
      id,
      origin: {
        scheme: 'postgres',
        host: '127.0.0.1',
        port: storePort,
        database: DATABASE,
        user: current.user,
      },
    },
  });
}

// ---- clients that loop queries ---------------------------------------------------------------

type Loop = { queries: number; failures: string[]; stop: () => Promise<void> };

/** Opens a new connection per query with the pool's current config, as Hyperdrive would. */
function connectionPerQuery(pool: RotationPool): Loop {
  const loop: Loop = { queries: 0, failures: [], stop: async () => undefined };
  let running = true;
  const done = (async () => {
    while (running) {
      const config = configs.get(HYPERDRIVE_CONFIG_IDS.development[pool]);
      if (config === undefined) throw new Error('no config');
      const client = new pg.Client({
        host: '127.0.0.1',
        port: storePort,
        database: DATABASE,
        user: config.user,
        password: config.password,
      });
      try {
        await client.connect();
        await client.query('SELECT 1');
        loop.queries += 1;
      } catch (error) {
        loop.failures.push(
          `${pool} as ${config.user}: ${error instanceof Error ? error.message : 'error'}`
        );
      } finally {
        await client.end().catch(() => undefined);
      }
      await sleep(25);
    }
  })();
  loop.stop = async () => {
    running = false;
    await done;
  };
  return loop;
}

/** Keeps the one session it opened before the first rotation and queries on it. */
async function persistentSession(user: LoginName, password: string): Promise<Loop> {
  const client = new pg.Client({
    host: '127.0.0.1',
    port: storePort,
    database: DATABASE,
    user,
    password,
  });
  await client.connect();
  const loop: Loop = { queries: 0, failures: [], stop: async () => undefined };
  let running = true;
  const done = (async () => {
    while (running) {
      try {
        await client.query('SELECT 1');
        loop.queries += 1;
      } catch (error) {
        loop.failures.push(`session ${user}: ${error instanceof Error ? error.message : 'error'}`);
      }
      await sleep(25);
    }
  })();
  loop.stop = async () => {
    running = false;
    await done;
    await client.end();
  };
  return loop;
}

async function logsIn(user: LoginName, password: string): Promise<boolean> {
  const client = new pg.Client({
    host: '127.0.0.1',
    port: storePort,
    database: DATABASE,
    user,
    password,
  });
  try {
    await client.connect();
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

// ---- the run ---------------------------------------------------------------------------------

let worker: ChildProcess | undefined;

async function waitForHttp(url: string): Promise<void> {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    if (
      await fetch(url).then(
        () => true,
        () => false
      )
    )
      return;
    if (worker?.exitCode !== null && worker?.exitCode !== undefined) {
      throw new Error(`the mint Worker exited with ${worker.exitCode}; see ${WORK}/mint.log`);
    }
    await sleep(1000);
  }
  throw new Error(`no answer at ${url}`);
}

const PhaseSchema = z.object({ phase: z.string(), switchedAt: z.record(z.string(), z.number()) });

async function main(): Promise<void> {
  const store = await openE2eStore(DATABASE);
  storePort = Number(new URL(store.urls.app).port || 5432);
  const seeds = z
    .record(z.enum(LOGIN_NAMES), z.string())
    .parse(
      Object.fromEntries(LOGIN_NAMES.map(login => [login, randomBytes(24).toString('base64url')]))
    );
  for (const login of LOGIN_NAMES) {
    await store.admin.query(
      `ALTER ROLE ${pg.escapeIdentifier(login)} PASSWORD ${pg.escapeLiteral(seeds[login])}`
    );
  }
  for (const pool of ROTATION_POOLS) {
    const user = POOL_LOGINS[pool][0];
    configs.set(HYPERDRIVE_CONFIG_IDS.development[pool], { user, password: seeds[user] });
  }
  const managerServer = await listen(MANAGER_PORT, manager);
  const cloudflareServer = await listen(CLOUDFLARE_PORT, cloudflare);

  const loops = [
    ...ROTATION_POOLS.map(connectionPerQuery),
    await persistentSession('uts_app_a', seeds.uts_app_a),
  ];

  const localUrl = (user: LoginName) => {
    const url = new URL(store.urls.app);
    url.username = user;
    url.password = seeds[user];
    return url.toString();
  };
  // An env file's values are Worker secrets to wrangler dev, which never prints them; a `--var`
  // value is printed in the binding list.
  const envFile = join(WORK, 'rotation.env');
  const localSecrets = JSON.stringify({ UTS_HYPERDRIVE_SWITCH_TOKEN: SWITCH_TOKEN });
  for (const login of LOGIN_NAMES) seedFolder.set(login, seeds[login]);
  writeFileSync(envFile, `UTS_LOCAL_SECRETS='${localSecrets}'\n`, { mode: 0o600 });
  const log = createWriteStream(join(WORK, 'mint.log'));
  worker = spawn(
    './node_modules/.bin/wrangler',
    [
      'dev',
      '-c',
      'wrangler.dev.jsonc',
      '--ip',
      '127.0.0.1',
      '--port',
      String(PORT),
      '--inspector-port',
      String(PORT + 1),
      '--persist-to',
      join(WORK, 'state'),
      '--test-scheduled',
      '--var',
      `WEBAUTHN_ORIGINS:http://localhost:${PORT}`,
      '--var',
      `MANAGER_BASE_URL:http://127.0.0.1:${MANAGER_PORT}`,
      '--var',
      `CLOUDFLARE_API_BASE_URL:http://127.0.0.1:${CLOUDFLARE_PORT}`,
      '--var',
      'LOGIN_ROTATION:on',
      '--var',
      `LOGIN_ROTATION_PERIOD_SECONDS:${PERIOD_SECONDS}`,
      '--env-file',
      envFile,
    ],
    {
      cwd: UTS_DIR,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        WRANGLER_SEND_METRICS: 'false',
        XDG_CONFIG_HOME: join(WORK, 'xdg'),
        CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_IDENTITY_STORE: localUrl('uts_app_a'),
        CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_IDENTITY_STORE_PAT: localUrl('uts_pat_a'),
        CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_IDENTITY_STORE_REPLICA:
          localUrl('uts_reader_a'),
      },
    }
  );
  worker.stdout?.pipe(log);
  worker.stderr?.pipe(log);
  try {
    await waitForHttp(`${MINT}${MANAGER_JWKS_PATH}`);
    const started = Date.now();
    const target = [
      { pool: 'app', user: 'uts_app_b' },
      { pool: 'pat', user: 'uts_pat_b' },
      { pool: 'reader', user: 'uts_reader_b' },
      { pool: 'app', user: 'uts_app_a' },
    ];
    while (switches.length < target.length && Date.now() - started < DEADLINE_MS) {
      approveChangeRequests();
      const cron = await fetch(`${MINT}/__scheduled?cron=*+*+*+*+*`);
      await cron.body?.cancel();
      await sleep(1000);
    }
    console.log(
      `   switches after ${Math.round((Date.now() - started) / 1000)} s: ${JSON.stringify(switches)}`
    );
    check(
      JSON.stringify(switches.slice(0, target.length)) === JSON.stringify(target),
      '1. app, pat and reader moved to _b, then app moved back to _a (a -> b -> a)'
    );

    // Keep the clients looping a little past the last switch.
    await sleep(2000);
    for (const loop of loops) await loop.stop();
    const queries = loops.map(loop => loop.queries);
    const clientFailures = loops.flatMap(loop => loop.failures);
    console.log(`   client queries per loop (app, pat, reader, session): ${queries.join(', ')}`);
    check(
      queries.every(count => count > 0),
      '2. every client looped queries throughout'
    );
    check(
      clientFailures.length === 0,
      `2. no client query or connection failed (${clientFailures.length} failures)`
    );
    for (const failure of clientFailures.slice(0, 5)) console.log(`   ${failure}`);

    const rotated: LoginName[] = ['uts_app_b', 'uts_pat_b', 'uts_reader_b', 'uts_app_a'];
    for (const login of rotated) {
      const [name, value] =
        [...managerSecrets].filter(([secret]) => secret.startsWith(`${login}_`)).at(-1) ?? [];
      const config = [...configs.values()].find(entry => entry.user === login);
      check(
        name !== undefined &&
          value !== undefined &&
          (await logsIn(login, value)) &&
          !(await logsIn(login, seeds[login])),
        `3. ${login}: the manager secret ${name} logs in, the seed no longer does`
      );
      if (config !== undefined) {
        check(config.password === value, `3. ${login}: the config holds the stored password`);
      }
    }
    check(
      changeRequestCount === rotated.length,
      `3. ${changeRequestCount} change requests for ${rotated.length} rotations`
    );
    const reads = Object.fromEntries(seedReads);
    console.log(`   seed reads from /db-switch/uts: ${JSON.stringify(reads)}`);
    check(
      JSON.stringify(Object.keys(reads).sort()) === JSON.stringify([...rotated].sort()) &&
        Object.values(reads).every(count => count === 1),
      '3. each rotated login read its seed from /db-switch/uts once, and no other login read one'
    );

    const phase = PhaseSchema.parse(await (await fetch(`${MINT}/__dev/rotation`)).json());
    console.log(`   rotation object: ${JSON.stringify(phase)}`);
    check(phase.phase !== 'lost', '4. the rotation object holds every login');
    const mintLog = readFileSync(join(WORK, 'mint.log'), 'utf8');
    const values = [...Object.values(seeds), ...managerSecrets.values(), SWITCH_TOKEN];
    check(
      values.every(value => !mintLog.includes(value)),
      '4. no password or token in the Worker log'
    );
    check(
      mintLog.includes('uts.login_rotation.approval_pending'),
      '4. the log records each approval wait'
    );
  } finally {
    for (const loop of loops) await loop.stop().catch(() => undefined);
    if (worker.pid !== undefined) {
      try {
        process.kill(-worker.pid, 'SIGTERM');
      } catch {
        // The Worker already exited.
      }
    }
    managerServer.close();
    cloudflareServer.close();
    await store.admin.end();
  }
  console.log(failures === 0 ? 'PASS rotation-e2e' : `FAIL rotation-e2e: ${failures} failed`);
  process.exitCode = failures === 0 ? 0 : 1;
}

await main();
