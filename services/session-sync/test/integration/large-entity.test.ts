import { SELF, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';

import { getSessionSyncDOStub } from '../../src/dos/SessionSyncDO';
import {
  LIMITS,
  batchJsonWithinBudget,
  changeSchema,
  isBoundedJson,
  pageSchema,
  type Change,
  type Json,
} from '../../src/protocol';
import { batch, client, newSessionID, personal, sha256, testEnv } from '../helpers';

async function setup() {
  const api = client(personal(`bounds-${crypto.randomUUID()}`));
  const id = newSessionID();
  const source = crypto.randomUUID();
  expect((await api.register(id, source)).status).toBe(201);
  return { api, id, source };
}

function nested(levels: number): Json {
  let value: Json = null;
  for (let index = 0; index < levels; index++) value = [value];
  return value;
}

/** The optional Node-side CDP harness measures the real Workers-pool isolate. */
async function measure<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const url = process.env.SESSION_SYNC_MEASURE_URL;
  if (!url) return fn();
  // workerd processes forced-GC inspector commands at request safepoints.
  // Issue local no-auth requests until the actual profiler-ready signal arrives.
  let ready = false;
  try {
    const starting = fetch(`${url}/start/${name}`, { signal: AbortSignal.timeout(10_000) })
      .then(
        response => ({ response }),
        (error: unknown) => ({ error })
      )
      .finally(() => {
        ready = true;
      });
    while (!ready) {
      const wakeup = await SELF.fetch('https://session-sync.test/__bounds-inspector-wakeup');
      await wakeup.arrayBuffer();
    }
    const start = await starting;
    if ('error' in start) throw start.error;
    expect(start.response.ok).toBe(true);
    await start.response.text();
    return await fn();
  } finally {
    const stopped = await fetch(`${url}/stop`, { signal: AbortSignal.timeout(10_000) });
    expect(stopped.ok).toBe(true);
    await stopped.text();
  }
}

it('accepts message envelopes and independent parts without imposing lexical ordinal order', async () => {
  const { api, id, source } = await setup();
  const changes: Change[] = [
    {
      op: 'put',
      kind: 'message',
      id: 'msg',
      value: { seq: 1, message: { role: 'assistant' }, parts: { count: 12, through: 13 } },
    },
    ...Array.from({ length: 12 }, (_, ordinal): Change => ({
      op: 'put',
      kind: 'message-part',
      id: `msg/${ordinal}`,
      value: {
        messageID: 'msg',
        ordinal,
        position: ordinal + 1,
        part: { type: 'text', text: `part-${ordinal}` },
      },
    })),
  ];
  expect((await api.apply(id, batch(source, 0, 13, changes))).status).toBe(200);
  const page = pageSchema.parse(await (await api.entities(id)).json());
  const parts = page.entities
    .flatMap(entity => {
      if (entity.kind !== 'message-part' || !('value' in entity)) return [];
      return [entity.value as { ordinal: number; part: { text: string } }];
    })
    .sort((left, right) => left.ordinal - right.ordinal);
  expect(parts.map(part => part.part.text)).toEqual(
    Array.from({ length: 12 }, (_, index) => `part-${index}`)
  );
  expect(
    (
      await api.apply(
        id,
        batch(source, 13, 14, [
          { op: 'remove', kind: 'message-part', id: 'msg/11', cause: 'part-removed' },
        ])
      )
    ).status
  ).toBe(200);
  expect(
    changeSchema.safeParse({ op: 'remove', kind: 'message', id: 'msg', cause: 'part-removed' })
      .success
  ).toBe(false);
});

it('enforces exact depth and node boundaries, counting object keys and respecting escaped strings', () => {
  expect(isBoundedJson(nested(LIMITS.jsonDepth))).toBe(true);
  expect(isBoundedJson(nested(LIMITS.jsonDepth + 1))).toBe(false);
  expect(isBoundedJson(Array(LIMITS.jsonValueNodes - 1).fill(null))).toBe(true);
  expect(isBoundedJson(Array(LIMITS.jsonValueNodes).fill(null))).toBe(false);
  expect(
    isBoundedJson(
      Object.fromEntries(
        Array.from({ length: LIMITS.jsonValueNodes / 2 }, (_, index) => [String(index), null])
      )
    )
  ).toBe(false);
  expect(batchJsonWithinBudget(JSON.stringify(Array(LIMITS.jsonBatchNodes - 1).fill(null)))).toBe(
    true
  );
  expect(batchJsonWithinBudget(JSON.stringify(Array(LIMITS.jsonBatchNodes).fill(null)))).toBe(
    false
  );
  expect(
    batchJsonWithinBudget(
      '['.repeat(LIMITS.jsonBatchDepth) + '0' + ']'.repeat(LIMITS.jsonBatchDepth)
    )
  ).toBe(true);
  expect(
    batchJsonWithinBudget(
      '['.repeat(LIMITS.jsonBatchDepth + 1) + '0' + ']'.repeat(LIMITS.jsonBatchDepth + 1)
    )
  ).toBe(false);
  expect(batchJsonWithinBudget(JSON.stringify({ text: '[{"\\\"'.repeat(1000) }))).toBe(true);
});

it('rejects depth and node bombs with a typed error without advancing the receipt position', async () => {
  const { api, id, source } = await setup();
  const cases = [
    [{ op: 'put', kind: 'message', id: 'deep', value: nested(LIMITS.jsonDepth + 1) }],
    [{ op: 'put', kind: 'message', id: 'wide', value: Array(LIMITS.jsonValueNodes).fill(0) }],
    Array.from({ length: 5 }, (_, index) => ({
      op: 'put',
      kind: 'message',
      id: `wide-${index}`,
      value: Array(LIMITS.jsonValueNodes - 1).fill(0),
    })),
  ];
  for (const [index, changes] of cases.entries()) {
    const response = await measure(`reject-json-${index}`, () =>
      api.apply(id, {
        version: 1,
        sourceID: source,
        batchID: crypto.randomUUID(),
        after: 0,
        through: 1,
        changes,
      })
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: 'json_budget_exceeded' } });
  }
  const nonFinite = await api.send('POST', `/v1/sessions/${id}/batches`, {
    body: JSON.stringify(
      batch(source, 0, 1, [{ op: 'put', kind: 'message', id: 'number', value: 1 }])
    ).replace('"value":1', '"value":1e400'),
    headers: { 'content-type': 'application/json' },
  });
  expect(nonFinite.status).toBe(400);
  expect(await nonFinite.json()).toMatchObject({ error: { code: 'invalid_request' } });
  const deeplyNested = await measure('reject-preparse-depth', () =>
    api.send('POST', `/v1/sessions/${id}/batches`, {
      body: '{"value":' + '['.repeat(10_000) + '0' + ']'.repeat(10_000) + '}',
      headers: { 'content-type': 'application/json' },
    })
  );
  expect(deeplyNested.status).toBe(413);
  expect(await deeplyNested.json()).toMatchObject({ error: { code: 'json_budget_exceeded' } });
  const malformed = await api.send('POST', `/v1/sessions/${id}/batches`, {
    body: '{"changes":[',
    headers: { 'content-type': 'application/json' },
  });
  expect(malformed.status).toBe(400);
  expect(await malformed.json()).toMatchObject({ error: { code: 'invalid_request' } });
  expect(await (await api.state(id)).json()).toMatchObject({
    position: 0,
    revision: 0,
    lastReceipt: null,
  });
});

it('streams byte-identical pages for every JSON type, escaping, blobs, and empty pages', async () => {
  const { api, id, source } = await setup();
  expect(await (await api.entities(id)).text()).toBe(
    JSON.stringify({
      version: 1,
      sessionID: id,
      revision: 0,
      position: 0,
      entities: [],
      next: null,
    })
  );
  const bytes = new TextEncoder().encode('blob');
  const hash = await sha256(bytes);
  expect((await api.putBlob(id, hash, bytes)).status).toBe(201);
  const values: Json[] = [
    null,
    true,
    false,
    1.25,
    '界\\\"\n\u0000',
    [],
    {},
    { nested: ['value', { n: -1 }], __proto__: null },
  ];
  const changes: Change[] = values.map((value, index) => ({
    op: 'put',
    kind: 'asset',
    id: `${index}-\\"界`,
    value,
  }));
  changes.push({ op: 'put', kind: 'asset', id: 'z-blob', blob: { hash, bytes: bytes.byteLength } });
  expect((await api.apply(id, batch(source, 0, 1, changes))).status).toBe(200);
  const expected = {
    version: 1,
    sessionID: id,
    revision: 1,
    position: 1,
    entities: changes.map(change => ({
      kind: change.kind,
      id: change.id,
      revision: 1,
      ...('value' in change
        ? { value: change.value }
        : 'blob' in change
          ? { blob: change.blob }
          : {}),
    })),
    next: null,
  };
  const response = await api.entities(id);
  expect(response.headers.get('content-type')).toBe('application/json');
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.text()).toBe(JSON.stringify(expected));
});

it('exercises batch bytes, inline bytes, change count, JSON nodes, depth, and page bytes at their limits', async () => {
  const { api, id, source } = await setup();
  let position = 0;
  async function apply(name: string, changes: Change[], exactBytes = false) {
    const packet = batch(source, position, position + 1, changes);
    let body = JSON.stringify(packet);
    if (exactBytes)
      body += ' '.repeat(LIMITS.batchBytes - new TextEncoder().encode(body).byteLength);
    if (exactBytes) expect(new TextEncoder().encode(body).byteLength).toBe(LIMITS.batchBytes);
    const response = await measure(name, () =>
      api.send('POST', `/v1/sessions/${id}/batches`, {
        body,
        headers: { 'content-type': 'application/json' },
      })
    );
    expect(response.status).toBe(200);
    await response.arrayBuffer();
    position++;
  }
  const text = 'x'.repeat(LIMITS.inlineBytes - 2);
  expect(new TextEncoder().encode(JSON.stringify(text)).byteLength).toBe(LIMITS.inlineBytes);
  const maximumStrings: Change[] = Array.from({ length: 7 }, (_, index) => ({
    op: 'put',
    kind: 'message-part',
    id: `large/${index}`,
    value: text,
  }));
  // The 8th value fills all remaining body space except bounded metadata.
  maximumStrings.push({
    op: 'put',
    kind: 'message-part',
    id: 'large/7',
    value: 'x'.repeat(60 * 1024),
  });
  await apply('batch-inline-bytes', maximumStrings, true);
  await apply(
    'changes',
    Array.from({ length: LIMITS.changes }, (_, index) => ({
      op: 'put',
      kind: 'asset',
      id: `count-${index}`,
      value: index,
    }))
  );
  await apply('depth', [
    { op: 'put', kind: 'asset', id: 'depth', value: nested(LIMITS.jsonDepth) },
  ]);
  // Trim the last value until this packet reaches the exact whole-batch node
  // limit, including metadata, while every individual value stays admissible.
  const wide: Change[] = Array.from({ length: 4 }, (_, index) => ({
    op: 'put',
    kind: 'asset',
    id: `wide-${index}`,
    value: Array(LIMITS.jsonValueNodes - 1).fill(0),
  }));
  while (!batchJsonWithinBudget(JSON.stringify(batch(source, position, position + 1, wide)))) {
    const last = wide.at(-1);
    if (!last || !('value' in last) || !Array.isArray(last.value))
      throw new Error('Expected a wide value');
    last.value.pop();
  }
  await apply('json-nodes', wide);
  const last = wide.at(-1);
  if (!last || !('value' in last) || !Array.isArray(last.value))
    throw new Error('Expected a wide value');
  last.value.push(0);
  expect(batchJsonWithinBudget(JSON.stringify(batch(source, position, position + 1, wide)))).toBe(
    false
  );
  const pages = await setup();
  for (let index = 0; index < 5; index++) {
    const changes: Change[] = Array.from({ length: 7 }, (_, ordinal) => ({
      op: 'put',
      kind: 'message-part',
      id: `page-${index}/${ordinal}`,
      value: text,
    }));
    const seeded = await measure(`page-seed-${index}`, () =>
      pages.api.apply(pages.id, batch(pages.source, index, index + 1, changes))
    );
    expect(seeded.status).toBe(200);
    await seeded.arrayBuffer();
  }
  const response = await measure('page-bytes', async () => {
    const result = await pages.api.entities(pages.id, { limit: String(LIMITS.pageItems) });
    const body = await result.text();
    return { status: result.status, page: pageSchema.parse(JSON.parse(body)) };
  });
  expect(response.status).toBe(200);
  expect(response.page.next).not.toBeNull();
  const inlineBytes = response.page.entities.reduce(
    (sum, entity) =>
      sum +
      ('value' in entity ? new TextEncoder().encode(JSON.stringify(entity.value)).byteLength : 0),
    0
  );
  expect(inlineBytes).toBe(LIMITS.pageBytes);
}, 60_000);

it('caps a page at exactly the item limit independently of its byte budget', async () => {
  const { api, id, source } = await setup();
  const values: Change[] = Array.from({ length: LIMITS.pageItems + 1 }, (_, index) => ({
    op: 'put',
    kind: 'asset',
    id: String(index).padStart(3, '0'),
    value: index,
  }));
  expect((await api.apply(id, batch(source, 0, 1, values.slice(0, LIMITS.changes)))).status).toBe(
    200
  );
  expect((await api.apply(id, batch(source, 1, 2, values.slice(LIMITS.changes)))).status).toBe(200);
  const page = await measure('page-items', async () =>
    pageSchema.parse(await (await api.entities(id, { limit: String(LIMITS.pageItems) })).json())
  );
  expect(page.entities).toHaveLength(LIMITS.pageItems);
  expect(page.next).not.toBeNull();
  expect(page.position).toBe(2);
});

it('caps queued batch strings and tiny requests, releasing admission after success and rejection', async () => {
  const principal = personal(`queue-${crypto.randomUUID()}`);
  const api = client(principal);
  const id = newSessionID();
  const source = crypto.randomUUID();
  expect((await api.register(id, source)).status).toBe(201);
  const stub = getSessionSyncDOStub(testEnv, { tenant: principal.tenant, sessionID: id });
  await runInDurableObject(stub, async instance => {
    // Stall the same serialization gate that waits on tenant quota RPCs, without
    // timing assumptions or a fake implementation of batch application.
    const mutable = instance as unknown as { quotaGate: Promise<void> };
    for (const large of [true, false]) {
      const gate = Promise.withResolvers<void>();
      mutable.quotaGate = gate.promise;
      const packet = batch(source, large ? 0 : 1, large ? 1 : 2, []);
      let body = JSON.stringify(packet);
      if (large) body += ' '.repeat(LIMITS.batchBytes - body.length);
      const capacity = large
        ? LIMITS.batchQueueBytes / (body.length * 2)
        : LIMITS.batchQueueRequests;
      const pending = Array.from({ length: capacity }, () =>
        instance.applyBatch({ principal, sessionID: id, body })
      );
      try {
        const denied = await measure(large ? 'queue-bytes' : 'queue-requests', () =>
          instance.applyBatch({ principal, sessionID: id, body })
        );
        expect(denied).toMatchObject({ ok: false, error: { code: 'service_overloaded' } });
        if (!denied.ok) expect(denied.error.details?.retryAt).toBeTypeOf('number');
      } finally {
        gate.resolve();
        const applied = await Promise.all(pending);
        expect(applied.every(result => result.ok)).toBe(true);
      }
    }
    const invalid = await instance.applyBatch({ principal, sessionID: id, body: 'invalid' });
    expect(invalid).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    const next = await instance.applyBatch({
      principal,
      sessionID: id,
      body: JSON.stringify(batch(source, 2, 3, [])),
    });
    expect(next.ok).toBe(true);
  });
  expect(await (await api.state(id)).json()).toMatchObject({ position: 3 });
});
