/**
 * Local end-to-end run of the UTS audit outbox relay: the 8 shard relays, the local audit queue
 * and the audit relay consumer's R2 archive, in one `wrangler dev` over two configs, on a fresh
 * identity-store database.
 *
 * 1. 400 rows seed every shard; the mint Worker's cron arms the 8 relays.
 * 2. A transaction held open for 7 seconds holds every shard's watermark; 200 later rows commit
 *    but no shard moves past the open transaction.
 * 3. With the app login unable to move a watermark, 600 inserted rows move nothing; after the
 *    grant returns, 6,000 more rows follow.
 * 4. The relay sessions are terminated mid-flow; the watermark keeps its position, so the next
 *    runs resend rather than skip.
 * 5. Every shard relays, and the archive holds every row once, contiguous, in transaction order.
 * 6. A cron run after the drain logs no lag alert and no gap or duplicate.
 *
 * Synthetic data only: every event id is random, the identity-store passwords are random per run,
 * and the audit relay's Axiom token and Slack webhook are local values that reach no listener. The
 * run writes both, with a loopback Axiom URL, to `services/audit-relay/.dev.vars` (the file its
 * local run reads), then deletes it or restores the one it found.
 *
 *   UTS_E2E_ADMIN_URL  admin login to the identity-store database (loopback only)
 *   UTS_E2E_PORT       first of the run's ports (default 9310): the Worker and its inspector
 *
 * The run drops and recreates the database `uts_relay_e2e`, applies the migrations and writes its
 * log under a new temporary directory, whose path it prints.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  createWriteStream,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import pg from 'pg';
import { z } from 'zod';
import { openE2eStore } from './e2e-store';

const PORT = z.coerce
  .number()
  .int()
  .positive()
  .parse(process.env.UTS_E2E_PORT ?? '9310');
const BASE = `http://127.0.0.1:${PORT}`;
const SYNTHETIC_ORIGIN = `http://127.0.0.1:${PORT + 9}`;
const UTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORK = mkdtempSync(join(tmpdir(), 'uts-relay-e2e-'));
const STATE = join(WORK, 'state');

const WatermarkSchema = z.object({
  shard: z.number(),
  seq: z.string(),
  txid: z.string(),
  total: z.number(),
});
type Watermark = z.infer<typeof WatermarkSchema>;

const ArchivedBatchSchema = z.object({
  batch: z.looseObject({
    stream: z.string(),
    fromSeq: z.number(),
    events: z.array(z.looseObject({ id: z.string() })),
  }),
});

let failures = 0;

function log(step: string, detail: unknown): void {
  console.log(`${step.padEnd(52)} ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
}

function check(condition: boolean, message: string): void {
  if (condition) {
    console.log(`PASS ${message}`);
    return;
  }
  failures += 1;
  console.log(`FAIL ${message}`);
}

const lines: string[] = [];

function startWrangler(appUrl: string): ChildProcess {
  const file = createWriteStream(join(WORK, 'wrangler.log'), { flags: 'a' });
  const child = spawn(
    './node_modules/.bin/wrangler',
    [
      'dev',
      '-c',
      'wrangler.dev.jsonc',
      '-c',
      '../audit-relay/wrangler.jsonc',
      '--env',
      'local',
      '--port',
      String(PORT),
      '--inspector-port',
      String(PORT + 1),
      '--ip',
      '127.0.0.1',
      '--test-scheduled',
      '--persist-to',
      STATE,
    ],
    {
      cwd: UTS_DIR,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        WRANGLER_REGISTRY_PATH: join(WORK, 'registry'),
        XDG_CONFIG_HOME: join(WORK, 'xdg'),
        WRANGLER_SEND_METRICS: 'false',
        // This run reads only the app binding; Wrangler still checks that each local URL has a
        // password, so the PAT and replica bindings take the same app login.
        CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_IDENTITY_STORE: appUrl,
        CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_IDENTITY_STORE_PAT: appUrl,
        CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_IDENTITY_STORE_REPLICA: appUrl,
      },
    }
  );
  const collect = (chunk: Buffer) => {
    lines.push(chunk.toString());
    file.write(chunk);
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);
  child.once('exit', () => file.end());
  return child;
}

function waitForExit(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const onExit = () => {
    clearTimeout(timer);
    resolve(true);
  };
  const timer = setTimeout(() => {
    child.off('exit', onExit);
    resolve(false);
  }, ms);
  child.once('exit', onExit);
  return promise;
}

async function stop(child: ChildProcess | undefined): Promise<void> {
  if (child === undefined) return;
  if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      // The Worker exited between the check and the signal.
    }
  }
  if (!(await waitForExit(child, 10_000)) && child.pid !== undefined) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // The Worker exited between the check and the signal.
    }
    await waitForExit(child, 5000);
  }
}

async function waitForHttp(url: string): Promise<void> {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const answered = await fetch(url).then(
      () => true,
      () => false
    );
    if (answered) return;
    await sleep(1000);
  }
  throw new Error(`the Worker did not answer at ${url}`);
}

function auditEvent(): Record<string, unknown> {
  return {
    specversion: '1.0',
    id: randomUUID(),
    source: 'kilo:uts:development',
    type: 'ai.kilo.uts.token.issued',
    time: new Date().toISOString(),
    datacontenttype: 'application/json',
    data: {
      classUid: 6003,
      activityId: 1,
      outcome: 'success',
      actor: { kind: 'user', id: 'oauth/e2e' },
      attributes: {
        requestingService: 'kilo-cli',
        tokenRef: randomUUID(),
        filler: randomUUID().repeat(4),
      },
    },
  };
}

async function insert(client: pg.Client, count: number): Promise<void> {
  const events = Array.from({ length: count }, auditEvent);
  await client.query(
    `INSERT INTO uts.audit_events (event_id, event_type, event)
     SELECT (item ->> 'id')::uuid, item ->> 'type', item
     FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS input(item, position)
     ORDER BY position`,
    [JSON.stringify(events)]
  );
}

async function watermarks(client: pg.Client): Promise<Watermark[]> {
  const result = await client.query(
    `SELECT watermark.shard, watermark.last_seq::text AS seq, watermark.last_txid::text AS txid,
       (SELECT count(*) FROM uts.audit_events AS event WHERE event.shard = watermark.shard)::int AS total
     FROM uts.audit_relay_watermarks AS watermark ORDER BY watermark.shard`
  );
  return z.array(WatermarkSchema).parse(result.rows);
}

async function triggerCron(): Promise<void> {
  const url = new URL('/__scheduled', `${BASE}/`);
  url.searchParams.set('cron', '* * * * *');
  const response = await fetch(url);
  log('cron', String(response.status));
}

type Archived = { archived: Map<string, Map<number, string>>; objects: number; conflicts: number };

/** Reads the miniflare R2 blobs of the archive, keeping each stream's sequence to event id. */
function readArchive(): Archived {
  const archived = new Map<string, Map<number, string>>();
  let objects = 0;
  let conflicts = 0;
  const walk = (dir: string): string[] => {
    const files: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) files.push(...walk(path));
      else files.push(path);
    }
    return files;
  };
  const root = join(STATE, 'v3', 'r2');
  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    return { archived, objects, conflicts };
  }
  for (const path of walk(root)) {
    let body: unknown;
    try {
      body = JSON.parse(gunzipSync(readFileSync(path)).toString('utf8'));
    } catch {
      continue;
    }
    const parsed = ArchivedBatchSchema.safeParse(body);
    if (!parsed.success || !parsed.data.batch.stream.startsWith('uts:')) continue;
    const { stream, fromSeq, events } = parsed.data.batch;
    objects += 1;
    let seqs = archived.get(stream);
    if (seqs === undefined) {
      seqs = new Map();
      archived.set(stream, seqs);
    }
    for (const [offset, event] of events.entries()) {
      const seq = fromSeq + offset;
      const held = seqs.get(seq);
      if (held !== undefined) {
        conflicts += 1;
        if (held !== event.id) console.log(`MISMATCH ${stream} seq ${seq}`);
      }
      seqs.set(seq, event.id);
    }
  }
  return { archived, objects, conflicts };
}

function countMatches(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

const SYNTHETIC_SECRETS = JSON.stringify({
  AUDIT_RELAY_AXIOM_TOKEN: 'synthetic-local-token',
  AUDIT_RELAY_SLACK_WEBHOOK_PAGE: `${SYNTHETIC_ORIGIN}/page`,
});

async function main(): Promise<void> {
  const store = await openE2eStore('uts_relay_e2e');
  const admin = store.admin;
  const varsFile = resolve(UTS_DIR, '../audit-relay/.dev.vars');
  let previousVars: Buffer | null = null;
  let wroteVars = false;
  let worker: ChildProcess | undefined;
  let app: pg.Client | undefined;
  try {
    if (statSync(varsFile, { throwIfNoEntry: false }) !== undefined) {
      previousVars = readFileSync(varsFile);
    }
    writeFileSync(
      varsFile,
      `AXIOM_URL=${SYNTHETIC_ORIGIN}\nAUDIT_RELAY_LOCAL_SECRETS=${SYNTHETIC_SECRETS}\n`,
      {
        mode: 0o600,
      }
    );
    wroteVars = true;
    worker = startWrangler(store.urls.app);
    await waitForHttp(`${BASE}/`);
    log('wrangler dev', `up on ${BASE}`);

    app = new pg.Client({ connectionString: store.urls.app });
    await app.connect();
    await admin.query('SET ROLE uts_owner');
    // The migration creates no partition; the UTS cron creates them one per call. Bring the
    // partitions up as a fresh deployment's first cron does, before the first row.
    for (;;) {
      const { rows } = await admin.query<{ action: string }>(
        'SELECT action FROM uts.maintain_audit_partitions()'
      );
      if (!rows.some(row => row.action === 'created')) break;
    }

    await insert(app, 400);
    log('seed', '400 rows');
    await triggerCron();
    log('cron', 'arms 8 relays');

    const early = new pg.Client({ connectionString: store.urls.app });
    await early.connect();
    try {
      await early.query('BEGIN');
      await insert(early, 24);
      const { rows } = await early.query<{ txid: string }>(
        'SELECT pg_current_xact_id()::text AS txid'
      );
      const held = BigInt(rows[0].txid);
      await insert(app, 200);
      log('inflight', `open transaction ${held} holds 24 rows; 200 later rows committed`);
      await sleep(7000);
      const marks = await watermarks(admin);
      const passed = marks.filter(mark => BigInt(mark.txid) >= held);
      log('inflight watermarks', marks);
      check(
        passed.length === 0,
        'after 7 s with the transaction open, no shard watermark reached it'
      );
      await early.query('COMMIT');
      log('inflight', 'committed the held transaction');
    } finally {
      await early.end().catch(() => undefined);
    }

    await admin.query(
      'REVOKE EXECUTE ON FUNCTION uts.advance_audit_watermark(smallint, bigint, xid8, bigint, bigint) FROM uts_app'
    );
    const before = await watermarks(admin);
    await insert(app, 600);
    log('crash', 'watermark writes refused; inserted 600 rows');
    await sleep(8000);
    const during = await watermarks(admin);
    check(
      JSON.stringify(before.map(mark => mark.seq)) === JSON.stringify(during.map(mark => mark.seq)),
      'watermarks unchanged while the app login cannot move them'
    );
    await admin.query(
      'GRANT EXECUTE ON FUNCTION uts.advance_audit_watermark(smallint, bigint, xid8, bigint, bigint) TO uts_app'
    );
    log('crash', 'watermark writes allowed again');
    await insert(app, 6000);
    log('crash', 'inserted 6000 rows');

    let killed = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const { rows } = await admin.query<{ killed: number }>(
        `SELECT count(pg_terminate_backend(pid))::int AS killed
         FROM pg_stat_activity
         WHERE usename = 'uts_app_a' AND state = 'active'`
      );
      killed += rows[0].killed;
      await sleep(50);
    }
    log('terminated active relay sessions mid-flow', killed);

    let marks: Watermark[] = [];
    let relayed = false;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      marks = await watermarks(admin);
      if (marks.every(mark => Number(mark.seq) === mark.total)) {
        relayed = true;
        break;
      }
      await sleep(2000);
    }
    log(
      'relayed',
      marks.map(mark => [mark.shard, mark.seq, mark.total])
    );
    check(relayed, 'every shard relayed every row');

    log('drain', 'waiting 40 s for the consumer');
    await sleep(40_000);

    const expected = await admin.query<{ shard: number; event_id: string }>(
      'SELECT shard, event_id::text FROM uts.audit_events ORDER BY shard, txid, id'
    );
    const expectedRows = new Map<string, string[]>();
    for (const row of expected.rows) {
      const stream = `uts:development:${row.shard}`;
      expectedRows.set(stream, [...(expectedRows.get(stream) ?? []), row.event_id]);
    }

    const { archived, objects, conflicts } = readArchive();
    let matched = true;
    for (const [stream, ids] of expectedRows) {
      const seqs = archived.get(stream) ?? new Map<number, string>();
      const got = Array.from({ length: seqs.size }, (_, index) => seqs.get(index + 1));
      const sameOrder = got.length === ids.length && got.every((id, index) => id === ids[index]);
      const unique = new Set(got).size === got.length;
      log(
        stream,
        `rows ${ids.length}, archived seqs ${seqs.size}, contiguous and in order ${sameOrder}, each event once ${unique}`
      );
      check(sameOrder && unique, `${stream}: no gap, no duplicate, transaction order`);
      matched &&= sameOrder && unique;
    }
    log(
      'archive objects',
      `${objects}, objects overlapping an earlier object ${conflicts === 0 ? 0 : `${conflicts} seqs`}`
    );
    check(conflicts === 0, 'no archive object repeats a sequence number of an earlier one');
    if (matched) console.log('ARCHIVE MATCHES: no gap, no duplicate, transaction order');
    else console.log('ARCHIVE MISMATCH');

    await triggerCron();
    await sleep(3000);
    const text = lines.join('');
    const eventNames = [
      ...new Set(
        [...text.matchAll(/"event":"((?:uts\.)?audit_relay\.[a-z_.]+)"/g)].map(match => match[1])
      ),
    ].sort();
    log(
      'relay events',
      Object.fromEntries(
        eventNames.map(name => [
          name,
          countMatches(text, new RegExp(`"event":"${name.replaceAll('.', '\\.')}"`, 'g')),
        ])
      )
    );
    const failureReasons = [
      ...new Set([...text.matchAll(/"reason":"(gap|duplicate[a-z_]*)"/g)].map(match => match[1])),
    ];
    log(
      'consumer failures',
      Object.fromEntries(
        failureReasons.map(name => [
          name,
          countMatches(text, new RegExp(`"reason":"${name}"`, 'g')),
        ])
      )
    );
    check(
      countMatches(text, /"event":"uts\.audit_relay\.lagging"/g) === 0,
      'a cron run after the drain logs no lag alert'
    );
    check(
      countMatches(text, /"reason":"(gap|duplicate[a-z_]*)"/g) === 0,
      'the consumer logged no gap and no duplicate'
    );

    if (failures === 0) console.log('relay e2e: all checks passed');
    else {
      console.log(`relay e2e: ${failures} check(s) failed`);
      process.exitCode = 1;
    }
  } finally {
    await stop(worker);
    if (wroteVars) {
      if (previousVars === null) rmSync(varsFile, { force: true });
      else writeFileSync(varsFile, previousVars, { mode: 0o600 });
    }
    await app?.end().catch(() => undefined);
    await admin.end().catch(() => undefined);
    console.log(`run directory: ${WORK}`);
  }
}

await main();
