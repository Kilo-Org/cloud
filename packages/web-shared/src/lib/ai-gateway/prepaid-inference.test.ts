import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { eq } from 'drizzle-orm';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { POST } from '../../../../../apps/web/src/app/api/internal/inference/reservations/route';
import { admitClassifierInference } from '../../../../../services/auto-routing/src/prepaid-inference';
import * as store from '@kilocode/db/inference-reservations';
import { inference_reservations, kilocode_users } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import * as connections from '@kilocode/web-shared/lib/drizzle';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { admitPrepaidInference } from './prepaid-inference';
import { quoteInferenceReservation } from './reservation-quote';

const mockAfterTasks: Array<() => Promise<void>> = [];
let mockEnabled = true;

jest.mock('next/server', () => ({
  ...jest.requireActual<object>('next/server'),
  after: (work: () => Promise<void>) => {
    mockAfterTasks.push(work);
  },
}));
jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  ...jest.requireActual<object>('@kilocode/web-shared/lib/config.server'),
  isPrepaidInferenceReservationsEnabled: () => mockEnabled,
  INTERNAL_API_SECRET: 'isolated-prepaid-test',
}));
jest.mock('./reservation-quote', () => ({
  quoteInferenceReservation: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/constants', () => ({
  ...jest.requireActual<object>('@kilocode/web-shared/lib/constants'),
  get APP_URL() {
    return process.env.TEST_PREPAID_PRIMARY_ORIGIN ?? 'http://127.0.0.1';
  },
}));
jest.mock('@kilocode/db/inference-reservations', () => ({
  __esModule: true,
  ...jest.requireActual<object>('@kilocode/db/inference-reservations'),
}));
jest.mock('@kilocode/web-shared/lib/drizzle', () => ({
  __esModule: true,
  ...jest.requireActual<object>('@kilocode/web-shared/lib/drizzle'),
}));

let userId: string;
let requestId: string;

beforeEach(async () => {
  mockEnabled = true;
  mockAfterTasks.length = 0;
  jest
    .mocked(quoteInferenceReservation)
    .mockResolvedValue({ kind: 'quoted', amountMicrodollars: 60 });
  userId = (await insertTestUser({ total_microdollars_acquired: 100 })).id;
  requestId = crypto.randomUUID();
});

afterEach(async () => {
  jest.useRealTimers();
  await Promise.all(mockAfterTasks.map(task => task()));
  jest.restoreAllMocks();
  delete process.env.TEST_PREPAID_PRIMARY_ORIGIN;
  await db.delete(inference_reservations).where(eq(inference_reservations.kilo_user_id, userId));
  await db.delete(kilocode_users).where(eq(kilocode_users.id, userId));
});

function input() {
  return {
    requestId,
    userId,
    apiKind: 'messages',
    model: 'test-model',
    providerId: 'martian',
    body: { model: 'test-model', max_tokens: 1 },
    zeroCost: false,
  };
}

async function state() {
  const [user] = await db.select().from(kilocode_users).where(eq(kilocode_users.id, userId));
  const [reservation] = await db
    .select()
    .from(inference_reservations)
    .where(eq(inference_reservations.request_id, requestId));
  return { user, reservation };
}

describe('prepaid inference admission', () => {
  it.each(['gateway', 'lost-classifier-ack', 'insufficient-classifier'] as const)(
    'protects credit during %s admission over the real primary HTTP endpoint',
    async mode => {
      if (mode === 'insufficient-classifier') {
        await store.reserveInferenceCredits(db, {
          requestId: crypto.randomUUID(),
          userId,
          amountMicrodollars: 60,
        });
      }
      let inPrimary = false;
      jest.spyOn(connections, 'isUSRegion').mockImplementation(() => !inPrimary);
      const server = createServer(async (incoming, outgoing) => {
        const chunks: Buffer[] = [];
        for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks).toString('utf8');
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (typeof value === 'string') headers.set(name, value);
        }
        inPrimary = true;
        try {
          const response = await POST(
            new Request('http://127.0.0.1/api/internal/inference/reservations', {
              method: 'POST',
              headers,
              body,
            })
          );
          outgoing.writeHead(response.status, Object.fromEntries(response.headers));
          outgoing.end(
            mode === 'lost-classifier-ack' && JSON.parse(body).action === 'admit' && response.ok
              ? 'acknowledgement lost'
              : await response.text()
          );
        } catch {
          outgoing.writeHead(500);
          outgoing.end();
        } finally {
          inPrimary = false;
        }
      });
      try {
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const address = server.address();
        if (!address || typeof address === 'string')
          throw new Error('Primary fixture is not listening');
        const origin = `http://127.0.0.1:${address.port}`;
        process.env.TEST_PREPAID_PRIMARY_ORIGIN = origin;
        if (mode === 'gateway') {
          expect(await admitPrepaidInference(input())).toEqual({
            kind: 'admitted',
            reservationId: requestId,
          });
        } else {
          await expect(
            admitClassifierInference(
              {
                KILO_WEB_API_BASE_URL: origin,
                INTERNAL_API_SECRET_PROD: { get: async () => 'isolated-prepaid-test' },
              },
              { ...input(), organizationId: null }
            )
          ).rejects.toThrow();
        }
        await Promise.all(mockAfterTasks.map(task => task()));
        const result = await state();
        expect(result.user).toMatchObject({
          inference_microdollars_held: mode === 'lost-classifier-ack' ? 0 : 60,
          microdollars_used: 0,
        });
        if (mode === 'insufficient-classifier') {
          expect(result.reservation).toBeUndefined();
        } else {
          expect(result.reservation).toMatchObject({
            status: mode === 'gateway' ? 'reserved' : 'released',
          });
        }
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close(error => (error ? reject(error) : resolve()))
        );
      }
    }
  );

  it('keeps admitted money held after the response ends until billing settles it', async () => {
    expect(await admitPrepaidInference(input())).toEqual({
      kind: 'admitted',
      reservationId: requestId,
    });
    await Promise.all(mockAfterTasks.map(task => task()));
    const result = await state();
    expect(result.user).toMatchObject({ microdollars_used: 0, inference_microdollars_held: 60 });
    expect(result.reservation).toMatchObject({ status: 'reserved' });
  });

  it('does not reserve credit for an already disconnected client', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await admitPrepaidInference({ ...input(), signal: controller.signal });
    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') throw new Error('Expected disconnected-client response');
    expect(result.response.status).toBe(499);
    expect((await state()).reservation).toBeUndefined();
  });

  it('releases a hold when the client disconnects during confirmed pre-dispatch admission', async () => {
    const controller = new AbortController();
    const reserve = store.reserveInferenceCredits;
    jest.spyOn(store, 'reserveInferenceCredits').mockImplementation(async (database, request) => {
      const result = await reserve(database, request);
      controller.abort();
      return result;
    });
    const result = await admitPrepaidInference({ ...input(), signal: controller.signal });
    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') throw new Error('Expected disconnected-client response');
    expect(result.response.status).toBe(499);
    await Promise.all(mockAfterTasks.map(task => task()));
    expect((await state()).user).toMatchObject({
      inference_microdollars_held: 0,
      microdollars_used: 0,
    });
    expect((await state()).reservation).toMatchObject({ status: 'released' });
  });

  it('rejects a competing request when another request holds the required credit', async () => {
    await store.reserveInferenceCredits(db, {
      requestId: crypto.randomUUID(),
      userId,
      amountMicrodollars: 60,
    });
    const result = await admitPrepaidInference(input());
    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') throw new Error('Expected insufficient-credit response');
    expect(result.response.status).toBe(402);
    expect((await state()).user).toMatchObject({
      inference_microdollars_held: 60,
      microdollars_used: 0,
    });
    await Promise.all(mockAfterTasks.map(task => task()));
    expect((await state()).reservation).toBeUndefined();
  });

  it('retries transient admission once without reserving the same credit twice', async () => {
    const reserve = store.reserveInferenceCredits;
    jest
      .spyOn(store, 'reserveInferenceCredits')
      .mockRejectedValueOnce(new Error('Transient primary error'))
      .mockImplementation(reserve);
    expect(await admitPrepaidInference(input())).toEqual({
      kind: 'admitted',
      reservationId: requestId,
    });
    expect((await state()).user).toMatchObject({ inference_microdollars_held: 60 });
  });

  it('cancels a late primary commit after its admission deadline without allowing resurrection', async () => {
    const reserve = store.reserveInferenceCredits;
    const pending = Promise.withResolvers<void>();
    jest.spyOn(store, 'reserveInferenceCredits').mockImplementation(async (database, request) => {
      await pending.promise;
      return reserve(database, request);
    });
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    const admission = admitPrepaidInference(input());
    await Promise.resolve();
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(3_001);
    const result = await admission;
    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') throw new Error('Expected bounded admission failure');
    expect(result.response.status).toBe(503);
    jest.useRealTimers();
    pending.resolve();
    await Promise.all(mockAfterTasks.map(task => task()));
    const recovered = await state();
    expect(recovered.user).toMatchObject({ inference_microdollars_held: 0, microdollars_used: 0 });
    expect(recovered.reservation).toMatchObject({ status: 'released' });
    await expect(reserve(db, { requestId, userId, amountMicrodollars: 60 })).rejects.toMatchObject({
      reason: 'terminal',
    });
  });

  it('refuses an unbounded request without holding or spending credit', async () => {
    jest
      .mocked(quoteInferenceReservation)
      .mockResolvedValue({ kind: 'unsupported', reason: 'missing_price_contract' });
    const result = await admitPrepaidInference(input());
    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') throw new Error('Expected unbounded-cost rejection');
    expect(result.response.status).toBe(503);
    expect((await state()).user).toMatchObject({
      inference_microdollars_held: 0,
      microdollars_used: 0,
    });
    expect((await state()).reservation).toBeUndefined();
  });

  it('preserves existing traffic without a held balance while the rollout is disabled', async () => {
    mockEnabled = false;
    expect(await admitPrepaidInference(input())).toEqual({ kind: 'admitted' });
    expect((await state()).reservation).toBeUndefined();
    expect((await state()).user).toMatchObject({
      inference_microdollars_held: 0,
      microdollars_used: 0,
    });
  });
});
