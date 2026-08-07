import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { adminProcedure, createCallerFactory, createTRPCRouter, type TRPCContext } from './init';
import { setAdminAccessSinkForTest, type AdminAccessEvent } from '@/lib/admin/admin-access-log';
import { defineTestUser } from '@/tests/helpers/user.helper';

const testRouter = createTRPCRouter({
  ping: adminProcedure.query(() => 'ok'),
});
const createCaller = createCallerFactory(testRouter);

function ctxFor(overrides: Partial<TRPCContext> & Pick<TRPCContext, 'user'>): TRPCContext {
  return { authViaToken: false, tokenSource: null, ip: null, ...overrides };
}

let events: AdminAccessEvent[];

beforeEach(() => {
  events = [];
  setAdminAccessSinkForTest(event => events.push(event));
});

afterEach(() => {
  setAdminAccessSinkForTest(null);
});

describe('adminProcedure admin_access telemetry', () => {
  test('emits a trpc session event for a web-console admin', async () => {
    const caller = createCaller(
      ctxFor({ user: defineTestUser({ is_admin: true, is_super_admin: true }), ip: '9.9.9.9' })
    );

    await expect(caller.ping()).resolves.toBe('ok');

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: 'admin_access',
      surface: 'trpc',
      authVia: 'session',
      adminTier: 'super_admin',
      route: 'ping',
      method: 'query',
      ip: '9.9.9.9',
      tokenSource: null,
    });
  });

  test('emits authVia token when the caller authenticated via a bearer token', async () => {
    const caller = createCaller(
      ctxFor({
        user: defineTestUser({ is_admin: true, is_super_admin: false }),
        authViaToken: true,
        tokenSource: 'cloud-agent',
      })
    );

    await caller.ping();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      surface: 'trpc',
      authVia: 'token',
      adminTier: 'platform_admin',
      tokenSource: 'cloud-agent',
    });
  });

  test('does not emit for a non-admin caller', async () => {
    const caller = createCaller(ctxFor({ user: defineTestUser({ is_admin: false }) }));

    await expect(caller.ping()).rejects.toThrow();

    expect(events).toHaveLength(0);
  });
});
