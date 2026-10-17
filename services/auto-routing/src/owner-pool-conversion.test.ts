import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as DbModule from '@kilocode/db';
import { kilocode_users, organizations } from '@kilocode/db';
import type { OwnerPoolConversionRequest } from '@kilocode/auto-routing-contracts';
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
      readStoredSettings: async () => {
        const value = stored.get(id.toString());
        if (value === undefined) return storedSettings({ mode: null, pool: null });
        if (value instanceof Error) throw value;
        return value;
      },
      markConverted: async (at: string) => {
        if (markError) throw markError;
        marked.set(id.toString(), at);
      },
    }),
  },
};

function storedSettings(
  settings: Pick<StoredOwnerSettings, 'mode' | 'pool'> & Partial<StoredOwnerSettings>
): StoredOwnerSettings {
  return { invalidMode: false, invalidPool: false, convertedAt: null, ...settings };
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
        noticesSent: 1,
        noticesFailed: 0,
      })),
    });
  });
}

beforeEach(() => {
  stored.clear();
  marked.clear();
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
      noticesSent: 2,
      noticesFailed: 0,
      aborted: false,
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
    expect(webRequests()).toEqual([
      {
        conversions: [
          {
            owner: { type: 'user', id: 'u1' },
            mode: 'best_accuracy',
            models: ['z/last', 'a/first'],
          },
          { owner: { type: 'user', id: 'u2' }, mode: 'cost_per_accuracy', models: ['m/one'] },
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
  });

  it('chunks conversions at 25 per web request', async () => {
    ownerRows = Array.from({ length: 60 }, (_, index) => `u${String(index).padStart(3, '0')}`);
    const objectIds = ownerRows.map(id =>
      setOwner('user', id, { mode: null, pool: [{ model: 'a/b' }] })
    );

    const response = await scan({ ownerType: 'user', objectIds, after: null, dryRun: false });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      conversions: 60,
      outcomes: { created: 60 },
      noticesSent: 60,
    });
    expect(webRequests().map(request => request.conversions.length)).toEqual([25, 25, 10]);
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
  });

  it.each([
    ['a non-2xx response', async () => new Response('boom', { status: 502 })],
    ['an invalid response', async () => Response.json({ results: [] })],
    ['a network error', async () => Promise.reject(new Error('connection reset'))],
  ])('aborts the page with 503 and reports every owner as not posted on %s', async (_label, respond) => {
    const id = setOwner('user', 'u1', { mode: null, pool: [{ model: 'a/b' }] });
    ownerRows = ['u1'];
    webFetch.mockImplementation(respond);

    const response = await scan({ ownerType: 'user', objectIds: [id], after: null, dryRun: false });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      aborted: true,
      notPosted: ['user:u1'],
      needsAttention: [],
      outcomes: NO_OUTCOMES,
    });
    expect(marked.size).toBe(0);
  });

  it('keeps and marks the batches that succeeded when a later batch fails, without posting the rest', async () => {
    ownerRows = Array.from({ length: 60 }, (_, index) => `u${String(index).padStart(3, '0')}`);
    const objectIds = ownerRows.map(id =>
      setOwner('user', id, { mode: null, pool: [{ model: 'a/b' }] })
    );
    const created = webFetch.getMockImplementation();
    let calls = 0;
    webFetch.mockImplementation(async (url, init) => {
      calls += 1;
      if (calls === 1 && created) return created(url, init);
      return new Response('boom', { status: 500 });
    });

    const response = await scan({ ownerType: 'user', objectIds, after: null, dryRun: false });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      aborted: true,
      outcomes: { ...NO_OUTCOMES, created: 25 },
      notPosted: ownerRows.slice(25).map(id => `user:${id}`),
    });
    expect(marked.size).toBe(25);
    expect(webFetch).toHaveBeenCalledTimes(2);
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
      outcomes: { ...NO_OUTCOMES, failed: 30 },
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
          noticesSent: 1,
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

    await expect(response.json()).resolves.toMatchObject({ needsAttention: ['exists user:u1'] });
    expect([...marked.keys()]).toEqual([id]);
  });

  it('aborts on a retry that turns scattered failures into a consecutive run', async () => {
    ownerRows = ['u1', 'u2', 'u3', 'u4', 'u5'];
    const objectIds = ownerRows.map(id =>
      setOwner('user', id, { mode: null, pool: [{ model: 'a/b' }] })
    );
    const first = ['failed', 'created', 'failed', 'created', 'failed'] as const;
    webFetch.mockImplementationOnce(async (_url, init) =>
      Response.json({
        results: requestBody(init).conversions.map((conversion, index) => ({
          owner: conversion.owner,
          outcome: first[index],
          modelId: 'kilo-auto/custom/efficient',
          noticesSent: first[index] === 'created' ? 1 : 0,
          noticesFailed: 0,
        })),
      })
    );

    const firstRun = await scan({ ownerType: 'user', objectIds, after: null, dryRun: false });

    expect(firstRun.status).toBe(200);
    await expect(firstRun.json()).resolves.toMatchObject({
      aborted: false,
      consecutiveFailed: 1,
      needsAttention: ['failed user:u1', 'failed user:u3', 'failed user:u5'],
    });

    // The retry skips the two owners that converted, so the three failures are consecutive.
    webFetch.mockImplementationOnce(async (_url, init) =>
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

    const retry = await scan({
      ownerType: 'user',
      objectIds,
      after: null,
      dryRun: false,
      consecutiveFailed: 1,
    });

    expect(retry.status).toBe(503);
    await expect(retry.json()).resolves.toMatchObject({ aborted: true, consecutiveFailed: 4 });
  });

  it('reports exists when a retry follows a transport abort, so the notice is checked rather than sent twice', async () => {
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
    await expect(retry.json()).resolves.toMatchObject({ needsAttention: ['exists user:u1'] });
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

  it('lists owners whose notice failed or whose marker could not be stored', async () => {
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
          noticesFailed: 1,
        })),
      })
    );

    const response = await scan({ ownerType: 'user', objectIds: [id], after: null, dryRun: false });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      needsAttention: ['notice_failed user:u1', 'mark_failed user:u1'],
    });
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
