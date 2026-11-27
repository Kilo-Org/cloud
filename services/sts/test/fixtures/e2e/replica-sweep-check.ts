// Local end-to-end check of the replica session sweeper (README "Tests"). Self-contained, with
// Docker and psql on the machine and ports 8827 and 8830 free:
//   PG_IMAGE=postgres:16 ../../node_modules/.bin/tsx test/fixtures/e2e/replica-sweep-check.ts
// It starts a throwaway PostgreSQL primary and a streaming hot standby of it in Docker (Supabase's
// role shape, as sql/leases/check.sh), runs setup.sql, setup-replica-sweeper.sql and
// setup-ci-migration.sql, and serves a fake Infisical on port 8830 whose lease API runs the real
// statement files on the primary as `kilo_lease_replica_admin`, the way Infisical does, and runs
// its own expiry revocation at the lease's expiry without telling STS. It then starts the test
// build of STS with the probe (`wrangler dev`, port 8827), sweeping the replica through the
// `LEASE_SWEEP_REPLICA_E2E` Hyperdrive binding as `kilo_lease_sweeper`. It checks that a replica
// session of a lease is ended within the sweep bound after a revocation through STS, after an
// expiry Infisical revoked, and after an expiry whose revocation failed; that the sessions of an
// application login, `postgres`, a live lease and a dropped role that was never a lease survive
// every sweep; that a replica outage is audited as `failed` and its end as `ended`; and that no
// audit row carries a lease username, a password or a host. Every credential is generated here.
// Exits 1 on the first failure.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomInt } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { LeaseResultSchema, type IssuedLease } from '@kilocode/sts-contracts';
import pg from 'pg';

const HERE = new URL('.', import.meta.url).pathname;
const SQL = join(HERE, '../../../sql/leases');
const BASE = 'http://localhost:8827';
const IMAGE = process.env.PG_IMAGE ?? 'postgres:16';
const PORT = Number(process.env.PG_PORT ?? 55442);
const REPLICA_PORT = PORT + 1;
const NAME = `sts-replica-sweep-check-${PORT}`;
const DB = 'postgres';
/** The sweep interval (60 s), a sweep's own bound (10 s) and room for replication and the alarm. */
const BOUND_MS = 80_000;

const secret = () => randomBytes(24).toString('hex');
const SUPER_PW = secret();
const OWNER_PW = secret();
const APP_PW = secret();
const REPLICA_ADMIN_PW = secret();
const MIGRATION_ADMIN_PW = secret();
const SWEEPER_PW = secret();
const work = mkdtempSync(join(tmpdir(), 'sts-replica-sweep-'));
const stsConfig = join(HERE, 'wrangler.sts-sweep.tmp.jsonc');
let wrangler: ChildProcess | null = null;
const clients: pg.Client[] = [];

function cleanup(): void {
  wrangler?.kill('SIGTERM');
  for (const client of clients) void client.end().catch(() => undefined);
  spawnSync('docker', ['rm', '-f', NAME, `${NAME}-replica`], { stdio: 'ignore' });
  spawnSync('docker', ['network', 'rm', NAME], { stdio: 'ignore' });
  rmSync(stsConfig, { force: true });
  rmSync(work, { recursive: true, force: true });
}

function check(condition: boolean, what: string, detail: unknown = ''): void {
  console.log(
    `${condition ? 'PASS' : 'FAIL'} ${what}`,
    detail === '' ? '' : JSON.stringify(detail)
  );
  if (!condition) {
    const log = join(work, 'wrangler.log');
    if (existsSync(log)) {
      console.log(
        readFileSync(log, 'utf8')
          .split('\n')
          .filter(line => line.includes('sts:'))
          .slice(-40)
          .join('\n')
      );
    }
    cleanup();
    process.exit(1);
  }
}

function run(command: string, args: string[], env: Record<string, string> = {}): string {
  const result = spawnSync(command, args, { env: { ...process.env, ...env }, encoding: 'utf8' });
  if (result.status !== 0) {
    check(false, `${command} ${args.slice(0, 3).join(' ')} succeeds`, result.stderr.slice(-2000));
  }
  return result.stdout;
}

function psql(port: number, user: string, password: string, ...args: string[]): string {
  return run(
    'psql',
    [
      '-h',
      '127.0.0.1',
      '-p',
      String(port),
      '-U',
      user,
      '-d',
      DB,
      '-v',
      'ON_ERROR_STOP=1',
      '-qtA',
      ...args,
    ],
    { PGPASSWORD: password }
  );
}

async function connect(port: number, user: string, password: string): Promise<pg.Client> {
  const client = new pg.Client({ host: '127.0.0.1', port, user, password, database: DB });
  client.on('error', () => undefined);
  await client.connect();
  clients.push(client);
  return client;
}

// 1. A primary and a streaming hot standby of it.
spawnSync('docker', ['rm', '-f', NAME, `${NAME}-replica`], { stdio: 'ignore' });
spawnSync('docker', ['network', 'rm', NAME], { stdio: 'ignore' });
run('docker', ['network', 'create', NAME]);
run('docker', [
  'run',
  '-d',
  '--rm',
  '--name',
  NAME,
  '--network',
  NAME,
  '--network-alias',
  'primary',
  '-p',
  `127.0.0.1:${PORT}:5432`,
  '-e',
  'POSTGRES_USER=supabase_admin',
  '-e',
  `POSTGRES_PASSWORD=${SUPER_PW}`,
  '-e',
  `POSTGRES_DB=${DB}`,
  IMAGE,
]);
const isUp = (port: number, query: string, expected: string) =>
  spawnSync(
    'psql',
    ['-h', '127.0.0.1', '-p', String(port), '-U', 'supabase_admin', '-d', DB, '-qtAc', query],
    {
      env: { ...process.env, PGPASSWORD: SUPER_PW },
      encoding: 'utf8',
    }
  ).stdout.trim() === expected;
for (let attempt = 0; !isUp(PORT, 'select 1', '1'); attempt += 1) {
  if (attempt === 60) check(false, 'the primary starts');
  await sleep(1_000);
}
run('docker', [
  'exec',
  NAME,
  'sh',
  '-c',
  'echo "host replication all all scram-sha-256" >>"$PGDATA/pg_hba.conf"',
]);
psql(PORT, 'supabase_admin', SUPER_PW, '-c', 'select pg_reload_conf()');
run('docker', [
  'run',
  '-d',
  '--rm',
  '--name',
  `${NAME}-replica`,
  '--network',
  NAME,
  '-p',
  `127.0.0.1:${REPLICA_PORT}:5432`,
  '--user',
  'postgres',
  '-e',
  `PGPASSWORD=${SUPER_PW}`,
  '--entrypoint',
  'bash',
  IMAGE,
  '-c',
  'pg_basebackup -h primary -U supabase_admin -D /tmp/standby -R -X stream && chmod 700 /tmp/standby && exec postgres -D /tmp/standby',
]);
for (let attempt = 0; !isUp(REPLICA_PORT, 'select pg_is_in_recovery()', 't'); attempt += 1) {
  if (attempt === 60) check(false, 'the replica starts as a hot standby');
  await sleep(1_000);
}
console.log(
  `PostgreSQL ${psql(PORT, 'supabase_admin', SUPER_PW, '-c', 'show server_version').trim()}, primary and streaming replica`
);

// 2. Supabase's role shape, then the lease setup files.
psql(
  PORT,
  'supabase_admin',
  SUPER_PW,
  '-c',
  `create role postgres login createrole password '${OWNER_PW}'`,
  '-c',
  `alter database ${DB} owner to postgres`,
  '-c',
  'alter schema public owner to postgres',
  '-c',
  'grant pg_signal_backend, pg_monitor, pg_read_all_data to postgres',
  '-c',
  'grant set on parameter log_statement, log_min_duration_statement, log_min_error_statement to postgres',
  '-c',
  `create role app_pool login password '${APP_PW}'`,
  '-c',
  `create role app_gone login password '${APP_PW}'`
);
psql(PORT, 'postgres', OWNER_PW, '-c', 'create table public.accounts (id int primary key)');
psql(
  PORT,
  'postgres',
  OWNER_PW,
  '-v',
  `replica_admin_password=${REPLICA_ADMIN_PW}`,
  '-f',
  join(SQL, 'setup.sql')
);
psql(
  PORT,
  'postgres',
  OWNER_PW,
  '-v',
  `sweeper_password=${SWEEPER_PW}`,
  '-f',
  join(SQL, 'setup-replica-sweeper.sql')
);
psql(
  PORT,
  'supabase_admin',
  SUPER_PW,
  '-v',
  `migration_admin_password=${MIGRATION_ADMIN_PW}`,
  '-f',
  join(SQL, 'setup-ci-migration.sql')
);

const primary = await connect(PORT, 'supabase_admin', SUPER_PW);
const replica = await connect(REPLICA_PORT, 'supabase_admin', SUPER_PW);

async function caughtUp(): Promise<void> {
  const { rows } = await primary.query<{ lsn: string }>('select pg_current_wal_lsn() as lsn');
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const replay = await replica.query<{ done: boolean }>(
      'select pg_last_wal_replay_lsn() >= $1::pg_lsn as done',
      [rows[0].lsn]
    );
    if (replay.rows[0].done) return;
    await sleep(100);
  }
  check(false, 'the replica caught up with the primary');
}

async function replicaAlive(pid: number): Promise<boolean> {
  const { rows } = await replica.query<{ n: number }>(
    'select count(*)::int as n from pg_stat_activity where pid = $1',
    [pid]
  );
  return rows[0].n === 1;
}

/** An idle session on the replica; returns its backend pid. */
async function replicaSession(user: string, password: string): Promise<number> {
  const client = await connect(REPLICA_PORT, user, password);
  const { rows } = await client.query<{ pid: number }>('select pg_backend_pid() as pid');
  return rows[0].pid;
}

/** Waits until the replica session ends; returns when, or null after `limitMs`. */
async function endedWithin(pid: number, limitMs: number): Promise<number | null> {
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline) {
    if (!(await replicaAlive(pid))) return Date.now();
    await sleep(500);
  }
  return null;
}

// 3. A fake Infisical whose lease API runs the real statement files on the primary.
type FakeLease = {
  username: string;
  expireAt: number;
  expiryFails: boolean;
  timer: NodeJS.Timeout;
};
const fakeLeases = new Map<string, FakeLease>();
const deletes: string[] = [];
const expiryRevocations: string[] = [];
let nextExpiryFails = false;

async function asInfisical(file: string, values: Record<string, string>): Promise<void> {
  let text = readFileSync(join(SQL, file), 'utf8');
  for (const [name, value] of Object.entries(values)) text = text.replaceAll(`{{${name}}}`, value);
  const admin = new pg.Client({
    host: '127.0.0.1',
    port: PORT,
    user: 'kilo_lease_replica_admin',
    password: REPLICA_ADMIN_PW,
    database: DB,
  });
  await admin.connect();
  try {
    await admin.query('BEGIN');
    for (const part of text
      .split(';')
      .map(piece => piece.trim())
      .filter(piece => piece !== '')) {
      await admin.query(part);
    }
    await admin.query('COMMIT');
  } finally {
    await admin.end();
  }
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString('utf8');
}

const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1:8830');
    const json = (body: unknown, status = 200) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    const text = await readBody(request);
    if (url.pathname === '/manager/api/v1/auth/jwt-auth/login') {
      return json({ accessToken: 'e2e-manager-token', expiresIn: 600, tokenType: 'Bearer' });
    }
    if (url.pathname === '/manager/api/v4/secrets') return json({ secrets: [], imports: [] });
    const path = url.pathname.replace(/^\/manager/, '');
    if (request.method === 'POST' && path === '/api/v1/dynamic-secrets/leases') {
      const body = JSON.parse(text) as { ttl: string; dynamicSecretName: string };
      const ttlSeconds = Number(body.ttl.replace(/s$/, ''));
      const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
      const username = `lease_rr_${Array.from({ length: 20 }, () => alphabet[randomInt(alphabet.length)]).join('')}`;
      const password = secret();
      const expireAt = Date.now() + ttlSeconds * 1000;
      await asInfisical('replica-read.create.sql', {
        username,
        password,
        expiration: new Date(expireAt).toISOString(),
      });
      const id = crypto.randomUUID();
      const expiryFails = nextExpiryFails;
      // Infisical's own expiry: the revocation statement at expireAt, with no call to STS.
      const timer = setTimeout(() => {
        if (expiryFails) return;
        expiryRevocations.push(id);
        void asInfisical('revoke.sql', { username });
      }, expireAt - Date.now());
      fakeLeases.set(id, { username, expireAt, expiryFails, timer });
      return json({
        lease: {
          id,
          version: 1,
          externalEntityId: username,
          expireAt: new Date(expireAt).toISOString(),
          dynamicSecretId: crypto.randomUUID(),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        dynamicSecret: { name: body.dynamicSecretName, defaultTTL: '1h', maxTTL: '8h' },
        data: { DB_USERNAME: username, DB_PASSWORD: password },
      });
    }
    if (request.method === 'DELETE' && path.startsWith('/api/v1/dynamic-secrets/leases/')) {
      const id = path.split('/').pop() ?? '';
      const lease = fakeLeases.get(id);
      if (lease === undefined) {
        return json({ error: `Dynamic secret lease with ID '${id}' not found` }, 404);
      }
      deletes.push(id);
      clearTimeout(lease.timer);
      await asInfisical('revoke.sql', { username: lease.username });
      fakeLeases.delete(id);
      return json({ lease: { id, status: null } });
    }
    json({ error: 'not found' }, 404);
  })().catch(error => {
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: String(error) }));
  });
});
const listening = Promise.withResolvers<void>();
server.listen(8830, '127.0.0.1', listening.resolve);
await listening.promise;

// 4. The test build of STS, sweeping the replica as kilo_lease_sweeper.
writeFileSync(
  stsConfig,
  readFileSync(join(HERE, 'wrangler.sts.jsonc'), 'utf8')
    .replace(
      '"LEASE_REPLICA_SWEEP_BINDINGS": ""',
      '"LEASE_REPLICA_SWEEP_BINDINGS": "LEASE_SWEEP_REPLICA_E2E"'
    )
    .replace(
      'postgres://kilo_lease_sweeper:unused@127.0.0.1:1/postgres',
      `postgres://kilo_lease_sweeper:${SWEEPER_PW}@127.0.0.1:${REPLICA_PORT}/postgres`
    )
);
const wranglerLog = join(work, 'wrangler.log');
wrangler = spawn(
  join(HERE, '../../../node_modules/.bin/wrangler'),
  [
    'dev',
    '-c',
    join(HERE, 'wrangler.probe.jsonc'),
    '-c',
    stsConfig,
    '--persist-to',
    join(work, 'state'),
  ],
  { cwd: join(HERE, '../../..'), stdio: ['ignore', 'pipe', 'pipe'] }
);
const logStream = createWriteStream(wranglerLog);
wrangler.stdout?.pipe(logStream);
wrangler.stderr?.pipe(logStream);
for (let attempt = 0; ; attempt += 1) {
  try {
    if ((await fetch(`${BASE}/.well-known/jwks.json`)).status === 200) break;
  } catch {
    // Not up yet.
  }
  if (attempt === 120)
    check(false, 'STS answers within 4 minutes', readFileSync(wranglerLog, 'utf8').slice(-3000));
  await sleep(2_000);
}

async function probeLease(): Promise<IssuedLease> {
  const result = LeaseResultSchema.parse(
    await (await fetch(`${BASE}/probe/lease?grant=replica-read&ttl=300`)).json()
  );
  check(
    result.status === 'ok',
    'the probe gets a 5-minute replica-read lease through STS',
    result.status
  );
  if (result.status !== 'ok') throw new Error('unreachable');
  await caughtUp();
  return result;
}

// 5. Sessions no sweep may end.
const keep: Record<string, number> = {
  app_pool: await replicaSession('app_pool', APP_PW),
  postgres: await replicaSession('postgres', OWNER_PW),
  app_gone: await replicaSession('app_gone', APP_PW),
};
await primary.query('drop role app_gone');
await caughtUp();
async function keptAlive(when: string): Promise<void> {
  for (const [login, pid] of Object.entries(keep)) {
    check(await replicaAlive(pid), `${when}: the replica session of ${login} is open`);
  }
}

// 6. Revocation through STS: the role goes on the primary, its replica session at the next sweep.
const revoked = await probeLease();
const revokedPid = await replicaSession(revoked.username, revoked.password);
// The lease call started the sweep loop, and its first sweep runs about a second later; revoke
// after it, so the session must wait for a sweep that comes up to a minute later.
await sleep(5_000);
const revokeResult = (await (
  await fetch(`${BASE}/probe/revoke?leaseId=${encodeURIComponent(revoked.leaseId)}`)
).json()) as { status: string };
const revokedAt = Date.now();
check(revokeResult.status === 'revoked', 'the probe revokes its lease through STS', revokeResult);
await caughtUp();
const gone = await replica.query('select 1 from pg_roles where rolname = $1', [revoked.username]);
check(gone.rowCount === 0, 'the revocation dropped the role on the replica too');
check(
  await replicaAlive(revokedPid),
  'right after the revocation the replica session is still open (design decision Q63)'
);
const revokedEnded = await endedWithin(revokedPid, BOUND_MS);
check(
  revokedEnded !== null,
  `the sweep ends the replica session of the revoked lease within ${BOUND_MS / 1000} s`,
  revokedEnded === null ? '' : { seconds: Math.round((revokedEnded - revokedAt) / 1000) }
);

// 7. Expiry without STS: one lease Infisical revokes at its expiry, one whose expiry revocation
// fails (the role stays, past VALID UNTIL).
const expiring = await probeLease();
nextExpiryFails = true;
const stuck = await probeLease();
const expiringPid = await replicaSession(expiring.username, expiring.password);
const stuckPid = await replicaSession(stuck.username, stuck.password);
const expireAt = Math.max(Date.parse(expiring.expiresAt), Date.parse(stuck.expiresAt));
await sleep(Math.max(0, Date.parse(expiring.expiresAt) - Date.now() - 5_000));
check(
  (await replicaAlive(expiringPid)) && (await replicaAlive(stuckPid)),
  'live leases keep their replica sessions through several sweeps'
);
await keptAlive('before the expiry');
const expiryEnded = await Promise.all([
  endedWithin(expiringPid, expireAt - Date.now() + BOUND_MS),
  endedWithin(stuckPid, expireAt - Date.now() + BOUND_MS),
]);
check(
  expiryEnded.every(at => at !== null),
  `the sweep ends both replica sessions within ${BOUND_MS / 1000} s of the expiry`,
  expiryEnded.map(at => (at === null ? null : Math.round((at - expireAt) / 1000)))
);
check(
  expiryRevocations.length === 1 &&
    !deletes.includes(expiring.leaseId) &&
    !deletes.includes(stuck.leaseId),
  'Infisical revoked one expired lease itself, and STS asked for neither',
  { expiryRevocations: expiryRevocations.length, deletes: deletes.length }
);
const stuckRole = await primary.query<{ expired: boolean }>(
  'select rolvaliduntil < now() as expired from pg_roles where rolname = $1',
  [stuck.username]
);
check(
  stuckRole.rows[0]?.expired === true,
  'the lease whose expiry revocation failed still exists, past VALID UNTIL'
);
await keptAlive('after the expiry sweeps');

// 8. A replica outage: the first failed sweep is audited, and so is the first sweep after it.
run('docker', ['pause', `${NAME}-replica`]);
type SeenEvent = { stream: string; type: string; attributes: Record<string, unknown> };
async function sweptRows(): Promise<SeenEvent[]> {
  const events = (await (await fetch(`${BASE}/probe/audit`)).json()) as SeenEvent[];
  return events.filter(event => event.type === 'ai.kilo.sts.lease.replica_swept');
}
async function waitForRow(what: string, match: (event: SeenEvent) => boolean): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if ((await sweptRows()).some(match)) return;
    await sleep(2_000);
  }
  check(false, what, await sweptRows());
}
await waitForRow(
  'a sweep of the paused replica is audited as failed',
  event => event.attributes.result === 'failed'
);
run('docker', ['unpause', `${NAME}-replica`]);
await waitForRow(
  'the first sweep after the outage is audited as ended, with the failures before it',
  event => event.attributes.result === 'ended' && Number(event.attributes.afterFailures) >= 1
);
check(true, 'a replica outage is audited as failed, then as ended once the replica answers again');
await keptAlive('after the outage');

// 9. The audit rows.
const rows = await sweptRows();
const ended = rows.filter(event => event.attributes.result === 'ended');
check(
  ended.reduce((sum, event) => sum + Number(event.attributes.sessions), 0) === 3,
  'the ended rows count the three lease sessions',
  rows.map(event => event.attributes)
);
check(
  rows.every(
    event =>
      event.stream === 'sts:development:leases' &&
      event.attributes.replica === 'LEASE_SWEEP_REPLICA_E2E'
  ),
  'every sweep row comes from the lease stream and names the replica by its binding'
);
const all = JSON.stringify(rows);
check(
  ![revoked, expiring, stuck].some(
    lease => all.includes(lease.username) || all.includes(lease.password)
  ) &&
    !all.includes(SWEEPER_PW) &&
    !all.includes('127.0.0.1'),
  'no sweep row carries a lease username, a password or a host'
);
const log = readFileSync(wranglerLog, 'utf8');
check(
  log.includes('sts: replica sweep ended sessions of ended leases') &&
    log.includes('sts: replica sweep failed; the next sweep retries it') &&
    !log.includes(SWEEPER_PW),
  'the Worker logged the ended sessions and the failed sweep as a warning, without the password'
);
console.log('sweep rows', JSON.stringify(rows.map(event => event.attributes)));

server.close();
cleanup();
console.log('ALL PASS');
process.exit(0);
