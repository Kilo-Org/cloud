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
        if (value === undefined) return { mode: null, pool: null };
        if (value instanceof Error) throw value;
        return value;
      },
    }),
  },
};

function setOwner(ownerType: 'user' | 'org', id: string, settings: StoredOwnerSettings | Error) {
  stored.set(objectIdFor(`${ownerType}:${id}`), settings);
  return objectIdFor(`${ownerType}:${id}`);
}

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

function webRequests(): OwnerPoolConversionRequest[] {
  return webFetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
}

function respondCreated() {
  webFetch.mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as OwnerPoolConversionRequest;
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
    ownerRows = ['u1', 'u2', 'u3', 'u4', 'u5'];

    const response = await scan({
      ownerType: 'user',
      objectIds: [withMode, withoutMode, modeOnly, failed, orgId],
      after: null,
      limit: 5,
      dryRun: false,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      scanned: 5,
      nextCursor: 'u5',
      matchedObjectIds: [withMode, withoutMode, modeOnly, failed],
      conversions: 2,
      droppedModeOnly: 1,
      readFailed: ['user:u4'],
      outcomes: { created: 2, exists: 0, router_cap_reached: 0, owner_not_found: 0 },
      noticesSent: 2,
      noticesFailed: 0,
    });
    expect(dbFrom).toHaveBeenCalledWith(kilocode_users);
    expect(dbLimit).toHaveBeenCalledWith(5);
    expect(webFetch).toHaveBeenCalledTimes(1);
    const [url, init] = webFetch.mock.calls[0] ?? [];
    expect(String(url)).toBe(
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
      outcomes: { created: 0, exists: 0, router_cap_reached: 0, owner_not_found: 0 },
    });
    expect(webFetch).not.toHaveBeenCalled();
  });

  it('chunks conversions at 100 per web request', async () => {
    ownerRows = Array.from({ length: 250 }, (_, index) => `u${String(index).padStart(3, '0')}`);
    const objectIds = ownerRows.map(id =>
      setOwner('user', id, { mode: null, pool: [{ model: 'a/b' }] })
    );

    const response = await scan({ ownerType: 'user', objectIds, after: null, dryRun: false });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      conversions: 250,
      outcomes: { created: 250 },
      noticesSent: 250,
    });
    expect(webRequests().map(request => request.conversions.length)).toEqual([100, 100, 50]);
    expect(webRequests().flatMap(request => request.conversions.map(c => c.owner.id))).toEqual(
      ownerRows
    );
  });

  it.each([
    ['a non-2xx response', async () => new Response('boom', { status: 502 })],
    ['an invalid response', async () => Response.json({ results: [] })],
  ])('fails the scan with 500 on %s', async (_label, respond) => {
    const id = setOwner('user', 'u1', { mode: null, pool: [{ model: 'a/b' }] });
    ownerRows = ['u1'];
    webFetch.mockImplementation(respond);

    const response = await scan({ ownerType: 'user', objectIds: [id], after: null, dryRun: false });

    expect(response.status).toBe(500);
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
