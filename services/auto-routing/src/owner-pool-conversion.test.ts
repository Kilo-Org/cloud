import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as DbModule from '@kilocode/db';
import { kilocode_users, organizations } from '@kilocode/db';
import {
  MAX_OWNER_POOL_CONVERSIONS_PER_REQUEST as BATCH,
  type OwnerPoolConversionOutcome,
  type OwnerPoolConversionRequest,
} from '@kilocode/auto-routing-contracts';
import { app } from './index';
import { matchOwnerObjects } from './owner-pool-conversion';
import type { StoredOwnerSettings } from './routing-mode';

const getWorkerDb = vi.hoisted(() => vi.fn());

vi.mock('@kilocode/db', async importOriginal => {
  const actual = await importOriginal<typeof DbModule>();
  return { ...actual, getWorkerDb };
});

function objectIdFor(name: string): string {
  return createHash('sha256').update(name).digest('hex');
}

const stored = new Map<string, StoredOwnerSettings | Error>();
const marked = new Map<string, string>();
const failedMarks = new Map<string, string>();
const begun = new Set<string>();
const migrated = new Set<string>();
let markError: Error | null = null;
const dbFrom = vi.fn();
const dbLimit = vi.fn();
let ownerRows: string[] = [];
const webFetch = vi.fn<typeof fetch>();
const originalFetch = globalThis.fetch;

const env = {
  INTERNAL_API_SECRET_PROD: { get: async () => 'internal-secret' },
  KILO_WEB_API_BASE_URL: 'https://web.example.test',
  HYPERDRIVE: { connectionString: 'postgres://worker' },
  AUTO_ROUTING_MODE_CONFIG: {
    idFromName: (name: string) => ({ toString: () => objectIdFor(name) }),
    idFromString: (id: string) => ({ toString: () => id }),
    get: (id: { toString(): string }) => ({
      beginConversion: async () => {
        begun.add(id.toString());
        const value = stored.get(id.toString());
        if (value === undefined) return storedSettings({ mode: null, pool: null });
        if (value instanceof Error) throw value;
        return value;
      },
      readStoredSettings: async () => {
        const value = stored.get(id.toString());
        if (value === undefined) return storedSettings({ mode: null, pool: null });
        if (value instanceof Error) throw value;
        return value;
      },
      markConverted: async (at: string, isMigrated: boolean) => {
        if (markError) throw markError;
        marked.set(id.toString(), at);
        if (isMigrated) migrated.add(id.toString());
        const settings = stored.get(id.toString());
        if (settings && !(settings instanceof Error)) {
          stored.set(id.toString(), { ...settings, convertedAt: at });
        }
      },
      markFailed: async (at: string) => {
        if (markError) throw markError;
        failedMarks.set(id.toString(), at);
      },
    }),
  },
};

function storedSettings(
  settings: Pick<StoredOwnerSettings, 'mode' | 'pool'> & Partial<StoredOwnerSettings>
): StoredOwnerSettings {
  return { invalidMode: false, invalidPool: false, convertedAt: null, failedAt: null, ...settings };
}

function setOwner(
  ownerType: 'user' | 'org',
  id: string,
  settings: (Pick<StoredOwnerSettings, 'mode' | 'pool'> & Partial<StoredOwnerSettings>) | Error
) {
  stored.set(
    objectIdFor(`${ownerType}:${id}`),
    settings instanceof Error ? settings : storedSettings(settings)
  );
  return objectIdFor(`${ownerType}:${id}`);
}

const NO_OUTCOMES = {
  created: 0,
  exists: 0,
  slug_taken: 0,
  router_cap_reached: 0,
  owner_not_found: 0,
  failed: 0,
};

function scan(body: unknown, authorization: string | null = 'Bearer internal-secret') {
  return app.request(
    'https://auto-routing.example.com/admin/owner-pool-conversion/scan',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(authorization ? { authorization } : {}),
      },
      body: JSON.stringify(body),
    },
    env
  );
}

function requestBody(init: RequestInit | undefined): OwnerPoolConversionRequest {
  if (typeof init?.body !== 'string') throw new Error('Expected a JSON string body');
  return JSON.parse(init.body) as OwnerPoolConversionRequest;
}

function webRequests(): OwnerPoolConversionRequest[] {
  return webFetch.mock.calls.map(([, init]) => requestBody(init));
}

function respondCreated() {
  webFetch.mockImplementation(async (_url, init) => {
    const body = requestBody(init);
    return Response.json({
      results: body.conversions.map(conversion => ({
        owner: conversion.owner,
        outcome: 'created',
        modelId: `kilo-auto/${conversion.owner.type}/efficient`,
        noticesSent: 0,
        noticesFailed: 0,
      })),
    });
  });
}

// Answers every batch with `outcomeFor(ownerId)`, keeping the batch's owners in order.
function respondOutcomes(outcomeFor: (ownerId: string) => OwnerPoolConversionOutcome) {
  webFetch.mockImplementation(async (_url, init) =>
    Response.json({
      results: requestBody(init).conversions.map(conversion => ({
        owner: conversion.owner,
        outcome: outcomeFor(conversion.owner.id),
        modelId: 'kilo-auto/custom/efficient',
        noticesSent: 0,
        noticesFailed: 0,
      })),
    })
  );
}

function ownerIdsFor(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `u${String(index).padStart(3, '0')}`);
}

function poolOwners(ids: readonly string[]): string[] {
  return ids.map(id => setOwner('user', id, { mode: null, pool: [{ model: 'a/b' }] }));
}

beforeEach(() => {
  stored.clear();
  begun.clear();
  migrated.clear();
  marked.clear();
  failedMarks.clear();
  markError = null;
  ownerRows = [];
  dbFrom.mockReset();
  dbLimit.mockReset();
  dbLimit.mockImplementation(async () => ownerRows.map(id => ({ id })));
  const chain = { from: dbFrom, where: () => chain, orderBy: () => chain, limit: dbLimit };
  dbFrom.mockReturnValue(chain);
  getWorkerDb.mockReset();
  getWorkerDb.mockReturnValue({ select: () => chain });
  webFetch.mockReset();
  respondCreated();
  globalThis.fetch = webFetch;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('matchOwnerObjects', () => {
  it('keeps owners whose object id was listed and never matches across owner types', () => {
    const listed = new Set([objectIdFor('user:a'), objectIdFor('org:b')]);
    expect(matchOwnerObjects('user', ['a', 'b', 'c'], listed, objectIdFor)).toEqual([
      { ownerId: 'a', objectId: objectIdFor('user:a') },
    ]);
    expect(matchOwnerObjects('org', ['a', 'b'], listed, objectIdFor)).toEqual([
      { ownerId: 'b', objectId: objectIdFor('org:b') },
    ]);
  });
});

describe('POST /admin/owner-pool-conversion/scan', () => {
  it('converts pools in order, applies the default mode, and drops mode-only owners', async () => {
    const withMode = setOwner('user', 'u1', {
      mode: 'best_accuracy',
      pool: [{ model: 'z/last' }, { model: 'a/first' }],
    });
    const withoutMode = setOwner('user', 'u2', { mode: null, pool: [{ model: 'm/one' }] });
    const modeOnly = setOwner('user', 'u3', { mode: 'best_accuracy', pool: null });
    const failed = setOwner('user', 'u4', new Error('storage unavailable'));
    const orgId = setOwner('org', 'u1', { mode: null, pool: [{ model: 'org/model' }] });
    const invalid = setOwner('user', 'u5', {
      mode: 'best_accuracy',
      pool: null,
      invalidPool: true,
    });
    ownerRows = ['u1', 'u2', 'u3', 'u4', 'u5'];

    const response = await scan({
      ownerType: 'user',
      objectIds: [withMode, withoutMode, modeOnly, failed, orgId, invalid],
      after: null,
      limit: 5,
      dryRun: false,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      scanned: 5,
      nextCursor: 'u5',
      matchedObjectIds: [withMode, withoutMode, modeOnly, failed, invalid],
      alreadyConverted: 0,
      conversions: 2,
      droppedModeOnly: 1,
      readFailed: ['user:u4'],
      invalidPool: ['user:u5'],
      invalidMode: [],
      needsAttention: [],
      outcomes: { ...NO_OUTCOMES, created: 2 },
      noticesSent: 0,
      noticesFailed: 0,
      aborted: false,
      abortReason: null,
      consecutiveFailed: 0,
      notPosted: [],
    });
    expect([...marked.keys()]).toEqual([withMode, withoutMode]);
    expect(dbFrom).toHaveBeenCalledWith(kilocode_users);
    expect(dbLimit).toHaveBeenCalledWith(5);
    expect(webFetch).toHaveBeenCalledTimes(1);
    const [url, init] = webFetch.mock.calls[0] ?? [];
    expect(url instanceof URL ? url.href : url).toBe(
      'https://web.example.test/api/internal/auto-routing/owner-pool-conversions'
    );
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer internal-secret');
    expect(init?.redirect).toBe('manual');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(webRequests()).toEqual([
      {
        conversions: [
          {
            owner: { type: 'user', id: 'u1' },
            mode: 'best_accuracy',
            configuredMode: 'best_accuracy',
            models: ['z/last', 'a/first'],
          },
          {
            owner: { type: 'user', id: 'u2' },
            mode: 'cost_per_accuracy',
            configuredMode: null,
            models: ['m/one'],
          },
        ],
      },
    ]);
  });

  it('reads organizations and returns a null cursor for a short page', async () => {
    const orgId = setOwner('org', 'o1', { mode: null, pool: [{ model: 'org/model' }] });
    ownerRows = ['o1'];

    const response = await scan({
      ownerType: 'org',
      objectIds: [orgId],
      after: 'o0',
      dryRun: false,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ scanned: 1, nextCursor: null });
    expect(dbFrom).toHaveBeenCalledWith(organizations);
    expect(dbLimit).toHaveBeenCalledWith(2_000);
    expect(webRequests()[0]?.conversions[0]?.owner).toEqual({ type: 'org', id: 'o1' });
  });

  it('posts nothing on a dry run', async () => {
    const id = setOwner('user', 'u1', { mode: null, pool: [{ model: 'a/b' }] });
    ownerRows = ['u1'];

    const response = await scan({ ownerType: 'user', objectIds: [id], after: null, dryRun: true });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      conversions: 1,
      outcomes: NO_OUTCOMES,
    });
    expect(webFetch).not.toHaveBeenCalled();
    expect(begun.size).toBe(0);
    expect(marked.size).toBe(0);
  });

  it(`chunks conversions at ${BATCH} per web request`, async () => {
    ownerRows = ownerIdsFor(BATCH * 2 + 2);
    const objectIds = poolOwners(ownerRows);

    const response = await scan({ ownerType: 'user', objectIds, after: null, dryRun: false });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      conversions: ownerRows.length,
      outcomes: { created: ownerRows.length },
      noticesSent: 0,
    });
    expect(webRequests().map(request => request.conversions.length)).toEqual([BATCH, BATCH, 2]);
    expect(webRequests().flatMap(request => request.conversions.map(c => c.owner.id))).toEqual(
      ownerRows
    );
  });

  it('lists every owner whose conversion needs operator attention', async () => {
    ownerRows = ['u1', 'u2', 'u3', 'u4'];
    const objectIds = ownerRows.map(id =>
      setOwner('user', id, { mode: null, pool: [{ model: 'a/b' }] })
    );
    const outcomes = ['created', 'slug_taken', 'router_cap_reached', 'failed'] as const;
    webFetch.mockImplementation(async (_url, init) =>
      Response.json({
        results: requestBody(init).conversions.map((conversion, index) => ({
          owner: conversion.owner,
          outcome: outcomes[index],
          modelId: 'kilo-auto/custom/efficient',
          noticesSent: 0,
          noticesFailed: 0,
        })),
      })
    );

    const response = await scan({ ownerType: 'user', objectIds, after: null, dryRun: false });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      needsAttention: ['slug_taken user:u2', 'router_cap_reached user:u3', 'failed user:u4'],
      outcomes: { ...NO_OUTCOMES, created: 1, slug_taken: 1, router_cap_reached: 1, failed: 1 },
    });
    expect([...marked.keys()]).toEqual([objectIds[0]]);
    expect([...failedMarks.keys()]).toEqual([objectIds[3]]);
  });

  it.each(['slug_taken', 'router_cap_reached', 'owner_not_found'] as const)(
    'keeps %s unresolved across full scans and converts it after repair',
    async unresolved => {
      ownerRows = ['u1', 'u2'];
      const objectIds = poolOwners(ownerRows);
      respondOutcomes(id => (id === 'u1' ? 'created' : unresolved));
      const body = { ownerType: 'user', objectIds, after: null, dryRun: false };

      await scan(body);
      expect([...marked.keys()]).toEqual([objectIds[0]]);
      expect(migrated.has(objectIds[1])).toBe(false);
      webFetch.mockClear();

      const stillUnresolved = await scan(body);
      await expect(stillUnresolved.json()).resolves.toMatchObject({
        alreadyConverted: 1,
        conversions: 1,
        needsAttention: [`${unresolved} user:u2`],
      });
      expect(webRequests()[0]?.conversions.map(conversion => conversion.owner.id)).toEqual(['u2']);
      expect([...marked.keys()]).toEqual([objectIds[0]]);

      respondCreated();
      webFetch.mockClear();
      const repaired = await scan(body);
      await expect(repaired.json()).resolves.toMatchObject({
        alreadyConverted: 1,
        outcomes: { ...NO_OUTCOMES, created: 1 },
        needsAttention: [],
      });
      expect(migrated).toEqual(new Set(objectIds));
      webFetch.mockClear();

      const complete = await scan(body);
      await expect(complete.json()).resolves.toMatchObject({ alreadyConverted: 2, conversions: 0 });
      expect(webFetch).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['a non-2xx response', async () => new Response('boom', { status: 502 })],
    [
      'a redirect',
      async () =>
        new Response(null, { status: 307, headers: { location: 'https://elsewhere.test/' } }),
    ],
    ['an invalid response', async () => Response.json({ results: [] })],
    ['a network error', async () => Promise.reject(new Error('connection reset'))],
    [
      'results for other owners',
      async () =>
        Response.json({
          results: [
            {
              owner: { type: 'org', id: 'u1' },
              outcome: 'created',
              modelId: 'kilo-auto/custom/org/efficient',
              noticesSent: 0,
              noticesFailed: 0,
            },
          ],
        }),
    ],
  ])(
    'aborts the page with 503 and reports every owner as not posted on %s',
    async (_label, respond) => {
      const id = setOwner('user', 'u1', { mode: null, pool: [{ model: 'a/b' }] });
      ownerRows = ['u1'];
      webFetch.mockImplementation(respond);

      const response = await scan({
        ownerType: 'user',
        objectIds: [id],
        after: null,
        dryRun: false,
      });

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        aborted: true,
        abortReason: 'batch_failed',
        notPosted: ['user:u1'],
        needsAttention: [],
        outcomes: NO_OUTCOMES,
      });
      expect(marked.size).toBe(0);
    }
  );

  it('marks each batch as it returns, so a later failed batch never leaves converted owners unmarked', async () => {
    ownerRows = ownerIdsFor(BATCH * 3);
    const objectIds = poolOwners(ownerRows);
    const created = webFetch.getMockImplementation();
    let markedBeforeSecondBatch = -1;
    webFetch.mockImplementation(async (url, init) => {
      if (webFetch.mock.calls.length === 1 && created) return created(url, init);
      markedBeforeSecondBatch = marked.size;
      return new Response('boom', { status: 500 });
    });

    const response = await scan({ ownerType: 'user', objectIds, after: null, dryRun: false });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      aborted: true,
      abortReason: 'batch_failed',
      outcomes: { ...NO_OUTCOMES, created: BATCH },
      notPosted: ownerRows.slice(BATCH).map(id => `user:${id}`),
    });
    expect(markedBeforeSecondBatch).toBe(BATCH);
    expect(marked.size).toBe(BATCH);
    expect(webFetch).toHaveBeenCalledTimes(2);
  });

  it('counts a failure run that spans two batches', async () => {
    ownerRows = ownerIdsFor(BATCH + 2);
    const objectIds = poolOwners(ownerRows);
    const failing = new Set(ownerRows.slice(BATCH - 3));
    respondOutcomes(id => (failing.has(id) ? 'failed' : 'created'));

    const response = await scan({ ownerType: 'user', objectIds, after: null, dryRun: false });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      aborted: true,
      abortReason: 'consecutive_failures',
      consecutiveFailed: 5,
      outcomes: { ...NO_OUTCOMES, created: BATCH - 3, failed: 5 },
      notPosted: [],
    });
    expect(webRequests().map(request => request.conversions.length)).toEqual([BATCH, 2]);
  });

  it('stops posting after the page budget, reports only what it posted, and the next page picks up the rest', async () => {
    ownerRows = ownerIdsFor(BATCH * 3);
    const objectIds = poolOwners(ownerRows);
    const now = vi.spyOn(Date, 'now').mockReturnValue(0);
    const created = webFetch.getMockImplementation();
    webFetch.mockImplementation(async (url, init) => {
      now.mockReturnValue(200_000);
      if (!created) throw new Error('Expected the default web response');
      return created(url, init);
    });

    const first = await scan({ ownerType: 'user', objectIds, after: null, dryRun: false });

    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({
      aborted: false,
      scanned: BATCH,
      conversions: BATCH,
      matchedObjectIds: objectIds.slice(0, BATCH),
      nextCursor: ownerRows[BATCH - 1],
      outcomes: { ...NO_OUTCOMES, created: BATCH },
      notPosted: [],
    });
    expect(webFetch).toHaveBeenCalledTimes(1);
    expect(marked.size).toBe(BATCH);

    now.mockRestore();
    respondCreated();
    const allOwners = ownerRows;
    ownerRows = allOwners.slice(BATCH);

    const next = await scan({
      ownerType: 'user',
      objectIds,
      after: allOwners[BATCH - 1],
      dryRun: false,
    });

    await expect(next.json()).resolves.toMatchObject({
      scanned: BATCH * 2,
      conversions: BATCH * 2,
      outcomes: { ...NO_OUTCOMES, created: BATCH * 2 },
    });
    expect(webRequests().flatMap(request => request.conversions.map(c => c.owner.id))).toEqual(
      allOwners
    );
    expect(marked.size).toBe(BATCH * 3);
  });

  it('records failed owners without marking missing owners successfully converted', async () => {
    ownerRows = ['u1', 'u2'];
    const [failedOwner, missingOwner] = poolOwners(ownerRows);
    respondOutcomes(id => (id === 'u1' ? 'failed' : 'owner_not_found'));

    const response = await scan({
      ownerType: 'user',
      objectIds: [failedOwner, missingOwner],
      after: null,
      dryRun: false,
    });

    await expect(response.json()).resolves.toMatchObject({
      needsAttention: ['failed user:u1', 'owner_not_found user:u2'],
    });
    expect([...failedMarks.keys()]).toEqual([failedOwner]);
    expect(marked.size).toBe(0);
  });

  it('aborts when the endpoint reports every conversion of a batch failed', async () => {
    ownerRows = Array.from({ length: 30 }, (_, index) => `u${String(index).padStart(3, '0')}`);
    const objectIds = ownerRows.map(id =>
      setOwner('user', id, { mode: null, pool: [{ model: 'a/b' }] })
    );
    webFetch.mockImplementation(async (_url, init) =>
      Response.json({
        results: requestBody(init).conversions.map(conversion => ({
          owner: conversion.owner,
          outcome: 'failed',
          modelId: 'kilo-auto/custom/efficient',
          noticesSent: 0,
          noticesFailed: 0,
        })),
      })
    );

    const response = await scan({ ownerType: 'user', objectIds, after: null, dryRun: false });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      aborted: true,
      abortReason: 'consecutive_failures',
      outcomes: { ...NO_OUTCOMES, failed: BATCH },
      notPosted: ownerRows.slice(BATCH).map(id => `user:${id}`),
    });
    expect(webFetch).toHaveBeenCalledTimes(1);
  });

  it('reports a small all-failed batch without aborting, so one failing owner never blocks a run', async () => {
    const id = setOwner('user', 'u1', { mode: null, pool: [{ model: 'a/b' }] });
    ownerRows = ['u1'];
    webFetch.mockImplementation(async (_url, init) =>
      Response.json({
        results: requestBody(init).conversions.map(conversion => ({
          owner: conversion.owner,
          outcome: 'failed',
          modelId: 'kilo-auto/custom/efficient',
          noticesSent: 0,
          noticesFailed: 0,
        })),
      })
    );

    const response = await scan({ ownerType: 'user', objectIds: [id], after: null, dryRun: false });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      aborted: false,
      needsAttention: ['failed user:u1'],
    });
    expect(marked.size).toBe(0);
  });

  it.each([
    ['four failures in a row', 0, 4, 200],
    ['the fifth failure in a row, carried over from earlier pages', 4, 1, 503],
  ])('counts %s toward an outage', async (_label, carried, failing, status) => {
    ownerRows = Array.from({ length: failing }, (_, index) => `u${index}`);
    const objectIds = ownerRows.map(id =>
      setOwner('user', id, { mode: null, pool: [{ model: 'a/b' }] })
    );
    webFetch.mockImplementation(async (_url, init) =>
      Response.json({
        results: requestBody(init).conversions.map(conversion => ({
          owner: conversion.owner,
          outcome: 'failed',
          modelId: 'kilo-auto/custom/efficient',
          noticesSent: 0,
          noticesFailed: 0,
        })),
      })
    );

    const response = await scan({
      ownerType: 'user',
      objectIds,
      after: null,
      dryRun: false,
      consecutiveFailed: carried,
    });

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toMatchObject({
      aborted: status === 503,
      consecutiveFailed: carried + failing,
    });
  });

  it('resets the failure run on any other outcome', async () => {
    ownerRows = ['u1', 'u2'];
    const objectIds = ownerRows.map(id =>
      setOwner('user', id, { mode: null, pool: [{ model: 'a/b' }] })
    );
    const outcomes = ['failed', 'created'] as const;
    webFetch.mockImplementation(async (_url, init) =>
      Response.json({
        results: requestBody(init).conversions.map((conversion, index) => ({
          owner: conversion.owner,
          outcome: outcomes[index],
          modelId: 'kilo-auto/custom/efficient',
          noticesSent: 0,
          noticesFailed: 0,
        })),
      })
    );

    const response = await scan({
      ownerType: 'user',
      objectIds,
      after: null,
      dryRun: false,
      consecutiveFailed: 3,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ consecutiveFailed: 0 });
  });

  it('lists an unmarked owner whose router already matches as exists', async () => {
    const id = setOwner('user', 'u1', { mode: null, pool: [{ model: 'a/b' }] });
    ownerRows = ['u1'];
    webFetch.mockImplementation(async (_url, init) =>
      Response.json({
        results: requestBody(init).conversions.map(conversion => ({
          owner: conversion.owner,
          outcome: 'exists',
          modelId: 'kilo-auto/custom/efficient',
          noticesSent: 0,
          noticesFailed: 0,
        })),
      })
    );

    const response = await scan({ ownerType: 'user', objectIds: [id], after: null, dryRun: false });

    await expect(response.json()).resolves.toMatchObject({ needsAttention: [] });
    expect([...marked.keys()]).toEqual([id]);
    expect(migrated.has(id)).toBe(true);
  });

  it('does not count owners that failed in an earlier attempt toward an outage on a retry', async () => {
    ownerRows = ownerIdsFor(10);
    const objectIds = poolOwners(ownerRows);
    const keepsFailing = new Set(ownerRows.filter((_, index) => index % 2 === 0));
    respondOutcomes(id => (keepsFailing.has(id) ? 'failed' : 'created'));

    const firstRun = await scan({ ownerType: 'user', objectIds, after: null, dryRun: false });

    expect(firstRun.status).toBe(200);
    expect(failedMarks.size).toBe(5);

    // A real retry: the converted owners are marked and skipped, the failed ones carry their
    // failure marker, and the five failures are now consecutive.
    for (const id of ownerRows) {
      setOwner('user', id, {
        mode: null,
        pool: [{ model: 'a/b' }],
        ...(keepsFailing.has(id)
          ? { failedAt: '2026-10-17T00:00:00.000Z' }
          : { convertedAt: '2026-10-17T00:00:00.000Z' }),
      });
    }
    webFetch.mockClear();

    const retry = await scan({ ownerType: 'user', objectIds, after: null, dryRun: false });

    expect(retry.status).toBe(200);
    await expect(retry.json()).resolves.toMatchObject({
      aborted: false,
      alreadyConverted: 5,
      consecutiveFailed: 0,
      outcomes: { ...NO_OUTCOMES, failed: 5 },
    });
    expect(webRequests()[0]?.conversions).toHaveLength(5);
  });

  it('reports exists when a retry follows a transport abort, without recreating the canonical row', async () => {
    const id = setOwner('user', 'u1', { mode: null, pool: [{ model: 'a/b' }] });
    ownerRows = ['u1'];
    webFetch.mockRejectedValueOnce(new Error('connection reset'));

    const aborted = await scan({ ownerType: 'user', objectIds: [id], after: null, dryRun: false });

    expect(aborted.status).toBe(503);

    webFetch.mockImplementationOnce(async (_url, init) =>
      Response.json({
        results: requestBody(init).conversions.map(conversion => ({
          owner: conversion.owner,
          outcome: 'exists',
          modelId: 'kilo-auto/custom/efficient',
          noticesSent: 0,
          noticesFailed: 0,
        })),
      })
    );

    const retry = await scan({ ownerType: 'user', objectIds: [id], after: null, dryRun: false });

    expect(retry.status).toBe(200);
    await expect(retry.json()).resolves.toMatchObject({ needsAttention: [] });
    expect([...marked.keys()]).toEqual([id]);
  });

  it('skips owners an earlier run converted', async () => {
    const done = setOwner('user', 'u1', {
      mode: null,
      pool: [{ model: 'a/b' }],
      convertedAt: '2026-10-17T00:00:00.000Z',
    });
    const fresh = setOwner('user', 'u2', { mode: null, pool: [{ model: 'a/b' }] });
    ownerRows = ['u1', 'u2'];

    const response = await scan({
      ownerType: 'user',
      objectIds: [done, fresh],
      after: null,
      dryRun: false,
    });

    await expect(response.json()).resolves.toMatchObject({ alreadyConverted: 1, conversions: 1 });
    expect(webRequests()[0]?.conversions.map(conversion => conversion.owner.id)).toEqual(['u2']);
    expect([...marked.keys()]).toEqual([fresh]);
  });

  it('reports a pool whose models cannot be gateway entries as invalid and posts nothing for it', async () => {
    const id = setOwner('user', 'u1', { mode: null, pool: [{ model: 'client:ollama/llama' }] });
    ownerRows = ['u1'];

    const response = await scan({ ownerType: 'user', objectIds: [id], after: null, dryRun: false });

    await expect(response.json()).resolves.toMatchObject({
      invalidPool: ['user:u1'],
      conversions: 0,
    });
    expect(webFetch).not.toHaveBeenCalled();
  });

  it('converts an invalid stored mode with the default mode and lists it', async () => {
    const id = setOwner('user', 'u1', { mode: null, pool: [{ model: 'a/b' }], invalidMode: true });
    ownerRows = ['u1'];

    const response = await scan({ ownerType: 'user', objectIds: [id], after: null, dryRun: false });

    await expect(response.json()).resolves.toMatchObject({ invalidMode: ['user:u1'] });
    expect(webRequests()[0]?.conversions[0]?.mode).toBe('cost_per_accuracy');
  });

  it('lists owners whose settled marker could not be stored', async () => {
    const id = setOwner('user', 'u1', { mode: null, pool: [{ model: 'a/b' }] });
    ownerRows = ['u1'];
    markError = new Error('storage unavailable');
    webFetch.mockImplementation(async (_url, init) =>
      Response.json({
        results: requestBody(init).conversions.map(conversion => ({
          owner: conversion.owner,
          outcome: 'created',
          modelId: 'kilo-auto/custom/efficient',
          noticesSent: 0,
          noticesFailed: 0,
        })),
      })
    );

    const response = await scan({ ownerType: 'user', objectIds: [id], after: null, dryRun: false });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      needsAttention: ['mark_failed user:u1'],
    });
  });

  it('does not report a lost failure marker, since the owner is already listed as failed', async () => {
    const id = setOwner('user', 'u1', { mode: null, pool: [{ model: 'a/b' }] });
    ownerRows = ['u1'];
    markError = new Error('storage unavailable');
    respondOutcomes(() => 'failed');

    const response = await scan({ ownerType: 'user', objectIds: [id], after: null, dryRun: false });

    await expect(response.json()).resolves.toMatchObject({ needsAttention: ['failed user:u1'] });
  });

  it.each([null, 'Bearer wrong-secret'])('rejects authorization %s', async authorization => {
    const response = await scan(
      { ownerType: 'user', objectIds: [], after: null, dryRun: true },
      authorization
    );
    expect(response.status).toBe(401);
    expect(getWorkerDb).not.toHaveBeenCalled();
  });

  it.each([
    { ownerType: 'team', objectIds: [], after: null, dryRun: true },
    { ownerType: 'user', objectIds: ['NOT-HEX'], after: null, dryRun: true },
    { ownerType: 'user', objectIds: [], after: null, limit: 10_001, dryRun: true },
    { ownerType: 'user', objectIds: [], after: null },
  ])('rejects an invalid body %j', async body => {
    const response = await scan(body);
    expect(response.status).toBe(400);
    expect(getWorkerDb).not.toHaveBeenCalled();
  });
});
