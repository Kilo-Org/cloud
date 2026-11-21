import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { pool, taggedWriterDb, taggedWriterPool } from '@kilocode/web-shared/lib/drizzle';
import { queueWriterAdmission } from '@kilocode/web-shared/lib/ai-gateway/usage-writer-admission';
import { INTERNAL_API_SECRET } from '@kilocode/web-shared/lib/config.server';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { POST as enkrypt } from '../../enkrypt-usage/record/route';
import { POST as exa } from '../../exa-usage/record/route';

function request(body: unknown) {
  return new NextRequest('http://localhost/api/internal/usage/record', {
    method: 'POST',
    headers: { 'x-internal-api-key': INTERNAL_API_SECRET, 'x-usage-write-source': 'queue' },
    body: JSON.stringify(body),
  });
}

it('keeps eight LLM admissions available while real Enkrypt and Exa transactions hold the tagged ceiling', async () => {
  expect(taggedWriterPool.totalCount).toBe(0);
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  const user = await insertTestUser();
  const org = await createTestOrganization(`isolation-${randomUUID()}`, user.id, 10_000_000);
  const guardrail = {
    id: randomUUID(),
    occurredAt: new Date().toISOString(),
    organizationId: org.id,
    kiloUserId: user.id,
    sessionId: 'session',
    microdollarUsageId: randomUUID(),
    apiKind: 'messages',
    decision: 'blocked',
    creditsCost: 7,
    addedLatencyMs: 1,
    guardrail: 'output',
  };
  const search = {
    id: randomUUID(),
    occurredAt: new Date().toISOString(),
    userId: user.id,
    organizationId: null,
    path: '/search',
    costMicrodollars: 7000,
    chargedToBalance: true,
    freeAllowanceMicrodollars: 10_000_000,
  };
  const unblock = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  let count = 0;
  const transaction = taggedWriterDb.transaction.bind(taggedWriterDb);
  const spy = jest.spyOn(taggedWriterDb, 'transaction').mockImplementation((callback, config) =>
    transaction(async tx => {
      const connection = await tx.execute(sql`select current_setting('application_name') as name`);
      expect(connection.rows[0]?.name).toBe('kilocode-web-tagged-writer');
      if (++count === 2) started.resolve();
      await unblock.promise;
      return callback(tx);
    }, config)
  );
  const primaryConnect = jest.spyOn(pool, 'connect');
  const timer = setTimeout(
    () => started.reject(new Error('Tagged transactions did not start on their dedicated pool')),
    2000
  );
  const work = [enkrypt(request(guardrail)), exa(request(search))];
  const slots: { release: () => void }[] = [];
  try {
    await started.promise;
    for (const route of [enkrypt, exa]) {
      const response = await route(request(route === enkrypt ? guardrail : search));
      expect(response.status).toBe(429);
      expect(response.headers.get('x-usage-class-limit')).toBe('non_llm');
      expect(await response.json()).toEqual({
        error: 'Usage writer overloaded',
        reason: 'queue_limit',
      });
    }
    for (let i = 0; i < 8; i++) {
      const slot = queueWriterAdmission.tryAcquire('queue', randomUUID());
      if (slot.admitted) slots.push(slot);
    }
    expect(slots).toHaveLength(8);
    expect(queueWriterAdmission.tryAcquire('queue', randomUUID())).toEqual({
      admitted: false,
      reason: 'queue_limit',
    });
    expect(primaryConnect).not.toHaveBeenCalled();
    expect(pool.options.max).toBe(10);
    expect(taggedWriterPool.options.max).toBe(2);
    expect(taggedWriterPool).not.toBe(pool);
    expect(taggedWriterPool.totalCount - taggedWriterPool.idleCount).toBe(2);
    expect(pool.waitingCount).toBe(0);
  } finally {
    clearTimeout(timer);
    slots.forEach(slot => slot.release());
    unblock.resolve();
    await Promise.allSettled(work);
    spy.mockRestore();
    jest.restoreAllMocks();
  }
  expect((await Promise.all(work)).map(response => response.status)).toEqual([200, 200]);
});
