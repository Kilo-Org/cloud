import { randomUUID } from 'node:crypto';
import {
  AUDIT_BATCH_MAX_COMPRESSED_BYTES,
  AUDIT_BATCH_MAX_EVENTS,
  AuditBatchSchema,
  AuditBatchTooLargeError,
  type AuditEvent,
  AuditEventSchema,
  decodeAuditBatch,
  encodeAuditBatch,
} from '@kilocode/sts-contracts';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withIdentityStore } from '../../src/db/client';
import { RelayReadRowSchema } from '../../src/audit/outbox';
import { RELAY_READ, TestDatabase, auditEvent, insertAudit, sqlStateOf } from './harness';

const CHECK_VIOLATION = '23514';

let db: TestDatabase;
let app: pg.Client;

beforeAll(async () => {
  db = await TestDatabase.create();
  app = await db.connect('uts_app_a');
});
afterAll(() => db.drop());

async function relayRead(client: pg.Client, shard: number) {
  const result = await client.query<{ id: bigint }>(RELAY_READ, [shard, AUDIT_BATCH_MAX_EVENTS]);
  return result.rows.map(row => row.id);
}

/** An event whose attributes hold `count` strings of 500 characters. */
function paddedEvent(count: number): AuditEvent {
  const base = auditEvent();
  const attributes = Object.fromEntries(
    Array.from({ length: count }, (_, index) => [`pad${index}`, 'x'.repeat(500)])
  );
  return { ...base, data: { ...base.data, attributes } };
}

const CLIENTS = ['kilo-cli', 'kilo-vscode', 'kilo-jetbrains', 'kilo-mobile'];
const AUDIENCES = ['gateway', 'kilo-chat', 'session-ingest', 'mcp'];
const PLACES = [
  ['DE', 'Berlin'],
  ['US', 'Seattle'],
  ['BR', 'Sao Paulo'],
  ['IN', 'Bengaluru'],
  ['JP', 'Osaka'],
];

/**
 * A mint event shaped like real traffic: requester and version, subject, grant family, optional
 * organization, latency, network fields (documentation addresses and ASNs) and `tokens` minted
 * tokens with their ids, audiences and scopes. Every value varies with `index`, so gzip sees no
 * more repetition than real rows give it.
 */
function mintEvent(index: number, tokens: number): AuditEvent {
  const base = auditEvent();
  const [country, city] = PLACES[index % PLACES.length];
  const audiences = AUDIENCES.slice(0, tokens);
  return {
    ...base,
    time: new Date(Date.now() - index * 997).toISOString(),
    data: {
      ...base.data,
      actor: { kind: 'user', id: `oauth/github:${1_000_000 + index * 7_919}` },
      attributes: {
        requestingService: CLIENTS[index % CLIENTS.length],
        clientVersion: `7.${index % 40}.${(index * 7) % 13}`,
        grantFamily: randomUUID(),
        ...(index % 3 === 0 ? { orgId: randomUUID() } : {}),
        latencyMs: 18 + ((index * 37) % 190),
        clientIp: `198.51.100.${(index % 254) + 1}`,
        asn: 64_496 + (index % 16),
        country,
        city,
        tokenIds: Array.from({ length: tokens }, () => randomUUID()),
        audiences,
        scopes: audiences.map(audience => `${audience}:read`),
      },
    },
  };
}

/**
 * The relay's split rule (as `sendRows` in the STS audit relay): send the batch as one message,
 * and halve any batch the encoder refuses. Returns the encoded messages in order.
 */
async function encodeWithSplits(events: AuditEvent[], fromSeq = 1): Promise<Uint8Array[]> {
  try {
    return [
      await encodeAuditBatch(
        AuditBatchSchema.parse({
          schemaVersion: 1,
          stream: 'uts-development-shard-3',
          fromSeq,
          toSeq: fromSeq + events.length - 1,
          events,
        })
      ),
    ];
  } catch (error) {
    if (!(error instanceof AuditBatchTooLargeError) || events.length === 1) throw error;
    const middle = Math.ceil(events.length / 2);
    return [
      ...(await encodeWithSplits(events.slice(0, middle), fromSeq)),
      ...(await encodeWithSplits(events.slice(middle), fromSeq + middle)),
    ];
  }
}

/** Checks that `messages` fit the queue limit and carry exactly `events`, in order. */
async function expectMessagesCarry(messages: Uint8Array[], events: AuditEvent[]) {
  for (const message of messages) {
    expect(message.byteLength).toBeLessThanOrEqual(AUDIT_BATCH_MAX_COMPRESSED_BYTES);
  }
  const decoded = await Promise.all(messages.map(message => decodeAuditBatch(message)));
  expect(decoded.flatMap(batch => batch.events.map(event => event.id))).toEqual(
    events.map(event => event.id)
  );
}

describe('audit outbox rows', () => {
  it('capture the inserting transaction id', async () => {
    await app.query('BEGIN');
    const row = await insertAudit(app);
    const current = await app.query<{ txid: bigint }>('SELECT pg_current_xact_id() AS txid');
    await app.query('COMMIT');
    expect(row.txid).toBe(current.rows[0].txid);
  });

  it('derive the shard from the row id modulo 8', async () => {
    const rows = [];
    for (let index = 0; index < 16; index++) rows.push(await insertAudit(app));
    for (const row of rows) expect(row.shard).toBe(Number(row.id % 8n));
    expect(new Set(rows.map(row => row.shard)).size).toBe(8);
  });

  it('reject an envelope whose id or type differs from the row', async () => {
    const insert = (eventId: string, eventType: string, event: AuditEvent) =>
      app.query('INSERT INTO uts.audit_events (event_id, event_type, event) VALUES ($1, $2, $3)', [
        eventId,
        eventType,
        event,
      ]);
    const event = auditEvent();
    expect(await sqlStateOf(() => insert(randomUUID(), event.type, event))).toBe(CHECK_VIOLATION);
    expect(await sqlStateOf(() => insert(event.id, 'ai.kilo.uts.other', event))).toBe(
      CHECK_VIOLATION
    );
  });

  it('start with one zero watermark per shard', async () => {
    const result = await app.query<{ shard: number; last_txid: bigint; last_id: bigint }>(
      'SELECT shard, last_txid, last_id FROM uts.audit_relay_watermarks ORDER BY shard'
    );
    expect(result.rows).toEqual(
      Array.from({ length: 8 }, (_, shard) => ({ shard, last_txid: 0n, last_id: 0n }))
    );
  });

  it('stay out of the relay read while an older transaction is open', async () => {
    const early = await db.connect('uts_app_a');
    const late = await db.connect('uts_app_b');
    const relay = await db.connect('uts_app_a');

    await early.query('BEGIN');
    const earlyRow = await insertAudit(early);
    const lateRow = await insertAudit(late);
    expect(lateRow.txid > earlyRow.txid).toBe(true);

    expect(await relayRead(relay, lateRow.shard)).not.toContain(lateRow.id);

    await early.query('COMMIT');
    // Transactions of other test files share the server's oldest-open-transaction horizon, so
    // wait for any of them to finish too. Up to 30 seconds: a seed insert of 100,000 rows in
    // `audit-maintenance.test.ts` holds the horizon for several seconds.
    await vi.waitFor(
      async () => {
        expect(await relayRead(relay, earlyRow.shard)).toContain(earlyRow.id);
        expect(await relayRead(relay, lateRow.shard)).toContain(lateRow.id);
      },
      { timeout: 30_000, interval: 100 }
    );
  }, 35_000);
});

type Mutation = (event: Record<string, unknown> & { data: Record<string, unknown> }) => unknown;

function withData(change: (data: Record<string, unknown>) => void): Mutation {
  return event => {
    change(event.data);
    return event;
  };
}

function withAttributes(attributes: Record<string, unknown>): Mutation {
  return withData(data => {
    data.attributes = attributes;
  });
}

function withField(field: string, value: unknown): Mutation {
  return event => ({ ...event, [field]: value });
}

/** Each case: what the database check and `AuditEventSchema` answer for the changed event. */
const CONTRACT_CASES: [string, Mutation, { database: boolean; schema: boolean }][] = [
  ['the base event', event => event, { database: true, schema: true }],
  [
    'an outcome detail',
    withData(data => {
      data.outcomeDetail = 'scope outside the grant';
    }),
    { database: true, schema: true },
  ],
  [
    'an authentication event',
    withData(data => {
      data.classUid = 3002;
    }),
    { database: true, schema: true },
  ],
  [
    'an account change event',
    withData(data => {
      data.classUid = 3001;
      data.activityId = 99;
    }),
    { database: true, schema: true },
  ],
  [
    'attributes of every allowed type',
    withAttributes({ service: 'gateway', latencyMs: 12.5, privileged: true, scopes: ['a:b'] }),
    { database: true, schema: true },
  ],
  ['a staging source', withField('source', 'kilo:uts:staging'), { database: true, schema: true }],
  [
    'a time without fractional seconds',
    withField('time', '2026-02-28T23:59:59Z'),
    { database: true, schema: true },
  ],
  [
    'a leap day',
    withField('time', '2028-02-29T12:00:00.123456Z'),
    { database: true, schema: true },
  ],
  [
    'a system actor',
    withData(data => {
      data.actor = { kind: 'system', id: 'uts-cron' };
    }),
    { database: true, schema: true },
  ],
  ['an unknown top-level key', withField('extra', 1), { database: false, schema: false }],
  [
    'an unknown data key',
    withData(data => {
      data.extra = 1;
    }),
    { database: false, schema: false },
  ],
  [
    'an unknown actor key',
    withData(data => {
      data.actor = { kind: 'user', id: 'oauth/test', email: 'x' };
    }),
    { database: false, schema: false },
  ],
  ['no source', ({ source: _source, ...event }) => event, { database: false, schema: false }],
  ['spec version 1.1', withField('specversion', '1.1'), { database: false, schema: false }],
  ['a numeric spec version', withField('specversion', 1), { database: false, schema: false }],
  ['an id that is not a UUID', withField('id', 'not-a-uuid'), { database: false, schema: false }],
  [
    'a time with an offset',
    withField('time', '2026-01-01T00:00:00+01:00'),
    { database: false, schema: false },
  ],
  [
    'a time without seconds',
    withField('time', '2026-01-01T00:00Z'),
    { database: false, schema: false },
  ],
  ['February 30', withField('time', '2026-02-30T00:00:00Z'), { database: false, schema: false }],
  [
    'February 29 of a common year',
    withField('time', '2027-02-29T00:00:00Z'),
    { database: false, schema: false },
  ],
  [
    'February 29 of a century that is not a leap year',
    withField('time', '2100-02-29T00:00:00Z'),
    { database: false, schema: false },
  ],
  ['April 31', withField('time', '2026-04-31T00:00:00Z'), { database: false, schema: false }],
  [
    'another content type',
    withField('datacontenttype', 'text/plain'),
    { database: false, schema: false },
  ],
  [
    'a class id as a string',
    withData(data => {
      data.classUid = '6003';
    }),
    { database: false, schema: false },
  ],
  [
    'a fractional activity id',
    withData(data => {
      data.activityId = 1.5;
    }),
    { database: false, schema: false },
  ],
  [
    'a negative activity id',
    withData(data => {
      data.activityId = -1;
    }),
    { database: false, schema: false },
  ],
  [
    'an unknown outcome',
    withData(data => {
      data.outcome = 'ok';
    }),
    { database: false, schema: false },
  ],
  [
    'an outcome detail over 512 characters',
    withData(data => {
      data.outcomeDetail = 'x'.repeat(513);
    }),
    { database: false, schema: false },
  ],
  [
    'an unknown actor kind',
    withData(data => {
      data.actor = { kind: 'robot', id: 'x' };
    }),
    { database: false, schema: false },
  ],
  [
    'an empty actor id',
    withData(data => {
      data.actor = { kind: 'user', id: '' };
    }),
    { database: false, schema: false },
  ],
  [
    'an attribute key with a dash',
    withAttributes({ 'bad-key': 1 }),
    { database: false, schema: false },
  ],
  ['an object attribute', withAttributes({ nested: { a: 1 } }), { database: false, schema: false }],
  [
    'a number in a list attribute',
    withAttributes({ list: [1] }),
    { database: false, schema: false },
  ],
  ['a null attribute', withAttributes({ empty: null }), { database: false, schema: false }],
  [
    'an attribute string over 512 characters',
    withAttributes({ long: 'x'.repeat(513) }),
    { database: false, schema: false },
  ],
  ['an array as data', withField('data', []), { database: false, schema: false }],
  ['an array as the event', () => [], { database: false, schema: false }],
  // The database is narrower than the shared contract: UTS events only, and byte-counted limits.
  [
    'another producer source',
    withField('source', 'kilo:sts:production'),
    { database: false, schema: true },
  ],
  [
    'another producer type',
    withField('type', 'ai.kilo.sts.bundle.delivered'),
    { database: false, schema: true },
  ],
  [
    'an OCSF class UTS does not use',
    withData(data => {
      data.classUid = 4001;
    }),
    { database: false, schema: true },
  ],
  [
    'an outcome detail of 300 two-byte characters',
    withData(data => {
      data.outcomeDetail = 'é'.repeat(300);
    }),
    { database: false, schema: true },
  ],
];

describe('the audit row check and AuditEventSchema', () => {
  it.each(CONTRACT_CASES)('agree on %s', async (_name, mutate, expected) => {
    const event = mutate(structuredClone(auditEvent()));
    const result = await app.query<{ ok: boolean }>('SELECT uts.is_audit_event($1::jsonb) AS ok', [
      JSON.stringify(event),
    ]);
    expect({
      database: result.rows[0].ok,
      schema: AuditEventSchema.safeParse(event).success,
    }).toEqual(expected);
  });
});

describe('the credential check on audit rows', () => {
  const insertWith = (event: AuditEvent, accountId: string | null = null) =>
    app.query(
      `INSERT INTO uts.audit_events (event_id, event_type, account_id, event)
       VALUES ($1, $2, $3, $4)`,
      [event.id, event.type, accountId, event]
    );
  const withAttribute = (value: string): AuditEvent => {
    const base = auditEvent();
    return { ...base, data: { ...base.data, attributes: { note: value } } };
  };

  it.each([
    ['a PAT', 'kilo_pat_0123456789abcdef'],
    ['a refresh grant', 'value kilo_rt_0123456789abcdef'],
    ['an org bot key', 'kilo_bot_0123456789abcdef'],
    // Built from parts: header `{"alg":"none"}`, payload `{"sub":"t"}`, a signature.
    ['a JWT', `Bearer ${['eyJhbGciOiJub25lIn0', 'eyJzdWIiOiJ0In0', 'c2ln'].join('.')}`],
  ])('refuse %s in an attribute', async (_name, value) => {
    expect(await sqlStateOf(() => insertWith(withAttribute(value)))).toBe(CHECK_VIOLATION);
  });

  it('refuse an email address as the account or the actor', async () => {
    expect(await sqlStateOf(() => insertWith(auditEvent(), 'someone@example.com'))).toBe(
      CHECK_VIOLATION
    );
    const base = auditEvent();
    const byAddress = {
      ...base,
      data: { ...base.data, actor: { kind: 'user' as const, id: 'someone@example.com' } },
    };
    expect(await sqlStateOf(() => insertWith(byAddress))).toBe(CHECK_VIOLATION);
  });

  it('accept an app user id, a token kind, a token id and a mention of a prefix', async () => {
    const base = auditEvent();
    const attributes = { tokenKind: 'kilo_pat', tokenRef: randomUUID() };
    await insertWith({ ...base, data: { ...base.data, attributes } }, 'oauth/github:12345');
    await insertWith({
      ...base,
      id: randomUUID(),
      data: { ...base.data, outcome: 'failure', outcomeDetail: 'malformed kilo_pat_ value' },
    });
  });
});

describe('relay batches', () => {
  it('split a 500-row read of realistic mint events into messages under 60 KB', async () => {
    // Start shard 3 after the rows that earlier tests wrote; only the owner moves a watermark
    // outside `uts.advance_audit_watermark`.
    const owner = await db.connectAsOwner();
    await owner.query(
      `UPDATE uts.audit_relay_watermarks AS watermark
       SET last_txid = newest.txid, last_id = newest.id
       FROM (SELECT txid, id FROM uts.audit_events WHERE shard = 3
             ORDER BY txid DESC, id DESC LIMIT 1) AS newest
       WHERE watermark.shard = 3`
    );
    // 1 to 4 tokens per mint, changing every 8 rows so that every shard sees each count.
    const events = Array.from({ length: AUDIT_BATCH_MAX_EVENTS * 8 + 8 }, (_, index) =>
      mintEvent(index, 1 + (Math.floor(index / 8) % 4))
    );
    await app.query(
      `INSERT INTO uts.audit_events (event_id, event_type, event)
       SELECT (item ->> 'id')::uuid, item ->> 'type', item
       FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS input(item, position)
       ORDER BY position`,
      [JSON.stringify(events)]
    );
    // Other test files' writes hold back the server-wide horizon, a seed insert of 100,000 rows
    // for several seconds, so the read may wait up to 30 seconds.
    const rows = await vi.waitFor(
      async () => {
        const read = await withIdentityStore(
          db.url('uts_app_b'),
          { waitUntil: () => undefined },
          store =>
            store.rows(
              { text: RELAY_READ, values: [3, AUDIT_BATCH_MAX_EVENTS] },
              RelayReadRowSchema
            )
        );
        expect(read).toHaveLength(AUDIT_BATCH_MAX_EVENTS);
        return read;
      },
      { timeout: 30_000, interval: 100 }
    );
    expect(rows.every(row => row.shard === 3)).toBe(true);

    const read = rows.map(row => row.event);
    const messages = await encodeWithSplits(read);
    await expectMessagesCarry(messages, read);
    console.info(
      `500 mixed mint rows -> ${messages.length} messages of ${messages
        .map(message => message.byteLength)
        .join(', ')} bytes`
    );
  }, 35_000);

  it('split 500 four-token mint events, which one message cannot hold', async () => {
    const events = Array.from({ length: AUDIT_BATCH_MAX_EVENTS }, (_, index) =>
      mintEvent(index, 4)
    );
    await expect(
      encodeAuditBatch({
        schemaVersion: 1,
        stream: 'uts-development-shard-3',
        fromSeq: 1,
        toSeq: events.length,
        events,
      })
    ).rejects.toThrow(AuditBatchTooLargeError);
    const messages = await encodeWithSplits(events);
    expect(messages.length).toBeGreaterThan(1);
    await expectMessagesCarry(messages, events);
    console.info(
      `500 four-token mint events -> ${messages.length} messages of ${messages
        .map(message => message.byteLength)
        .join(', ')} bytes`
    );
  });

  it('accept a row near the 8 KB cap, which fits one message alone, and refuse a larger one', async () => {
    const nearCap = paddedEvent(15);
    const overCap = paddedEvent(16);
    const sizes = await app.query<{ near: number; over: number }>(
      'SELECT octet_length($1::jsonb::text) AS near, octet_length($2::jsonb::text) AS over',
      [nearCap, overCap]
    );
    expect(sizes.rows[0].near).toBeGreaterThan(7_900);
    expect(sizes.rows[0].near).toBeLessThanOrEqual(8_192);
    expect(sizes.rows[0].over).toBeGreaterThan(8_192);

    await insertAudit(app, nearCap);
    expect(await sqlStateOf(() => insertAudit(app, overCap))).toBe(CHECK_VIOLATION);

    const alone = await encodeAuditBatch({
      schemaVersion: 1,
      stream: 'uts-development-shard-0',
      fromSeq: 1,
      toSeq: 1,
      events: [nearCap],
    });
    expect(alone.byteLength).toBeLessThanOrEqual(AUDIT_BATCH_MAX_COMPRESSED_BYTES);
  });

  it('need a split when 500 rows near the cap exceed one message', async () => {
    const events = Array.from({ length: AUDIT_BATCH_MAX_EVENTS }, () => ({
      ...paddedEvent(15),
      id: randomUUID(),
    }));
    await expect(
      encodeAuditBatch({
        schemaVersion: 1,
        stream: 'uts-development-shard-0',
        fromSeq: 1,
        toSeq: events.length,
        events,
      })
    ).rejects.toThrow(AuditBatchTooLargeError);
  });
});

describe('uts.advance_audit_watermark', () => {
  const INVALID_PARAMETER = '22023';
  const ADVANCE = `SELECT uts.advance_audit_watermark($1, $2, $3::text::xid8, $4, $5) AS advanced`;

  async function insertIntoShard(shard: number, count: number) {
    let inserted = 0;
    while (inserted < count) {
      if ((await insertAudit(app)).shard === shard) inserted++;
    }
  }

  /**
   * Every row of `shard` past its watermark, oldest first, once all of them are below the horizon.
   * Earlier tests leave rows in every shard, so the count is read, not assumed.
   */
  async function finalRows(shard: number) {
    return await vi.waitFor(
      async () => {
        const result = await app.query<{ txid: bigint; id: bigint; final: boolean }>(
          `SELECT event.txid, event.id,
             event.txid < pg_snapshot_xmin(pg_current_snapshot()) AS final
           FROM uts.audit_relay_watermarks AS watermark
           JOIN uts.audit_events AS event ON event.shard = watermark.shard
             AND (event.txid, event.id) > (watermark.last_txid, watermark.last_id)
           WHERE watermark.shard = $1
           ORDER BY event.txid, event.id`,
          [shard]
        );
        expect(result.rows.every(row => row.final)).toBe(true);
        return result.rows;
      },
      { timeout: 30_000, interval: 200 }
    );
  }

  async function advance(
    shard: number,
    fromSeq: number,
    to: { txid: bigint; id: bigint },
    toSeq: number
  ) {
    return await app.query<{ advanced: boolean }>(ADVANCE, [
      shard,
      fromSeq,
      to.txid.toString(),
      to.id,
      toSeq,
    ]);
  }

  it('refuse a move that skips a row, goes back, targets no final row or moves too far', async () => {
    const shard = 6;
    await insertIntoShard(shard, 3);
    const [first, second, third] = await finalRows(shard);

    // Past two rows numbered as one: the skipped row would never be sent.
    expect(await sqlStateOf(() => advance(shard, 0, second, 1))).toBe(INVALID_PARAMETER);
    // A row that does not exist in the shard.
    expect(
      await sqlStateOf(() => advance(shard, 0, { txid: third.txid, id: third.id + 1_000_000n }, 3))
    ).toBe(INVALID_PARAMETER);
    // More than one batch.
    expect(await sqlStateOf(() => advance(shard, 0, third, 501))).toBe(INVALID_PARAMETER);

    expect((await advance(shard, 0, first, 1)).rows).toEqual([{ advanced: true }]);
    // Back to the old position, and a stale starting sequence.
    expect(await sqlStateOf(() => advance(shard, 1, first, 2))).toBe(INVALID_PARAMETER);
    expect((await advance(shard, 0, second, 2)).rows).toEqual([{ advanced: false }]);
    expect((await advance(shard, 1, second, 2)).rows).toEqual([{ advanced: true }]);

    const watermark = await app.query(
      'SELECT last_txid, last_id, last_seq FROM uts.audit_relay_watermarks WHERE shard = $1',
      [shard]
    );
    expect(watermark.rows).toEqual([{ last_txid: second.txid, last_id: second.id, last_seq: 2n }]);
  }, 35_000);

  it('refuse a row whose transaction is still open', async () => {
    const shard = 7;
    const open = await db.connect('uts_app_b');
    await open.query('BEGIN');
    try {
      let row = await insertAudit(open);
      while (row.shard !== shard) row = await insertAudit(open);
      expect(await sqlStateOf(() => advance(shard, 0, row, 1))).toBe(INVALID_PARAMETER);
    } finally {
      await open.query('ROLLBACK');
    }
  });
});
