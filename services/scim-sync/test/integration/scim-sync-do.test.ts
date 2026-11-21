import { env, runInDurableObject } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { describe, expect, it, vi } from 'vitest';

import {
  directoryConflicts,
  eventFailures,
  parkedActivations,
  parkedEvents,
  syncState,
} from '../../src/db/sqlite-schema';
import type { ScimSyncDO } from '../../src/dos/ScimSyncDO';
import {
  CONFLICT_RETRY_BUDGET_MS,
  CURSOR_KEY,
  DRAIN_BUDGET_MS,
  LAST_POLL_KEY,
  PAGE_LIMIT,
  PARKED_EVENT_RETENTION_MS,
  SEED_CURSOR_KEY,
} from '../../src/util/constants';
import { logger } from '../../src/util/logger';
import { resolveSecret } from '../../src/util/secret';
import {
  activationWithNonListDomains,
  activationWithRejectedBody,
  activationWithoutDomains,
  directoryEvent,
  groupEvent,
  harness,
  membershipEvent,
  readState,
  steppingClock,
  stub,
  userEvent,
  type AppRoute,
} from './harness';

/**
 * The loop's behaviour: what the cursor does, which endpoints each event type
 * reaches, and what each response class does to both. Asserted through the
 * Durable Object's RPC and its SQLite state, with the WorkOS Events API and the
 * app origin stubbed at the `fetch` boundary.
 */

describe('cursor', () => {
  it('advances once per applied event', async () => {
    const target = stub('advance');
    harness({
      pages: [[directoryEvent('evt_1'), directoryEvent('evt_2'), directoryEvent('evt_3')]],
    });

    const result = await runInDurableObject(target, instance => instance.poll());

    expect(result.eventsApplied).toBe(3);
    expect(result.cursor).toBe('evt_3');
    expect((await readState(target)).rows[CURSOR_KEY]).toBe('evt_3');
    expect((await target.getStatus()).cursor).toBe('evt_3');
  });

  it('stops at the first held failure with the earlier events committed', async () => {
    const target = stub('hold');
    const io = harness({
      pages: [[directoryEvent('evt_1'), directoryEvent('evt_2'), directoryEvent('evt_3')]],
      routes: [
        {
          method: 'PUT',
          path: '/organizations/directory_01',
          replies: [{ status: 200, body: { id: 'org_1', created: false } }, { status: 503 }],
        },
      ],
    });

    const result = await runInDurableObject(target, instance => instance.poll());

    expect(result.eventsApplied).toBe(1);
    expect(result.cursor).toBe('evt_1');
    expect(result.heldFailure?.eventId).toBe('evt_2');
    // The third event is behind the held one, so it was never attempted.
    expect(io.calls).toHaveLength(2);

    const state = await readState(target);
    expect(state.rows[CURSOR_KEY]).toBe('evt_1');
    expect(state.failures).toBe(1);
    expect(state.parked).toEqual([]);
  });

  it('re-sends only the last event after a mid-page interruption', async () => {
    const target = stub('replay');
    harness({ pages: [[directoryEvent('evt_1'), directoryEvent('evt_2')]] });
    await runInDurableObject(target, instance => instance.poll());

    // A crash after `evt_2` applied replays from the committed cursor, which is
    // `evt_2` itself: the Events API returns events *after* it, so nothing
    // earlier is re-sent.
    const second = harness({ pages: [[directoryEvent('evt_3')]] });
    const result = await runInDurableObject(target, instance => instance.poll());

    expect(second.cursors[0]).toBe('evt_2');
    expect(result.eventsApplied).toBe(1);
    expect((await readState(target)).rows[CURSOR_KEY]).toBe('evt_3');
  });

  it('reports no cursor and omits `after` on a first poll', async () => {
    const target = stub('first-poll');
    const io = harness({ pages: [[]] });

    const result = await runInDurableObject(target, instance => instance.poll());

    expect(io.cursors).toEqual([null]);
    expect(result.cursor).toBeNull();
    expect(result.cursorSource).toBe('none');
  });
});

describe('drain', () => {
  it('keeps fetching while pages come back full, and stops on a short one', async () => {
    const target = stub('drain');
    const full = Array.from({ length: PAGE_LIMIT }, (_unused, i) => directoryEvent(`a_${i}`));
    const io = harness({ pages: [full, [directoryEvent('b_0')]] });

    const result = await runInDurableObject(target, instance => instance.poll());

    expect(io.cursors).toEqual([null, `a_${PAGE_LIMIT - 1}`]);
    expect(result.eventCount).toBe(PAGE_LIMIT + 1);
    expect(result.caughtUp).toBe(true);
    expect(result.cursor).toBe('b_0');
  });

  it('reports not caught up while the stream still returns full pages', async () => {
    const target = stub('drain-backlog');
    const page = (tag: string) =>
      Array.from({ length: PAGE_LIMIT }, (_unused, i) => directoryEvent(`${tag}_${i}`));
    harness({ pages: [page('a'), page('b')] });

    const result = await runInDurableObject(target, instance => instance.poll());

    // Two full pages then an empty one: the empty page is short, so the loop
    // reports caught up only once it has actually seen the end.
    expect(result.eventCount).toBe(PAGE_LIMIT * 2);
    expect(result.caughtUp).toBe(true);
  });

  it('stops mid-page once the drain budget is spent, with the cursor at the last applied event', async () => {
    const target = stub('drain-budget');
    // A quarter of the budget per app call, so the fourth event's call spends
    // it and the fifth is never attempted. One page, so the outer `while`
    // never gets a chance to notice: only a per-event check can stop this.
    const clock = steppingClock(DRAIN_BUDGET_MS / 4);
    const io = harness({
      pages: [Array.from({ length: 8 }, (_unused, i) => directoryEvent(`evt_${i}`))],
      onCall: () => clock.advance(),
    });

    const result = await runInDurableObject(target, instance => instance.poll());

    expect(result.eventsApplied).toBe(4);
    expect(result.cursor).toBe('evt_3');
    expect(io.calls).toHaveLength(4);
    // One page fetched: the drain stopped inside it rather than after it.
    expect(io.cursors).toEqual([null]);
    // The page was full of unapplied events, so the stream is not caught up
    // and the next alarm is the one-second re-arm.
    expect(result.caughtUp).toBe(false);
    expect(result.heldFailure).toBeNull();
    expect(result.error).toBeNull();

    // The next alarm resumes exactly where the budget ran out.
    clock.advanceBy(1_000);
    const second = harness({ pages: [[directoryEvent('evt_8')]] });
    await runInDurableObject(target, instance => instance.poll());

    expect(second.cursors[0]).toBe('evt_3');
    expect((await readState(target)).rows[CURSOR_KEY]).toBe('evt_8');
  });
});

describe('event mapping', () => {
  it('issues the group upsert, the user upsert, then the membership add', async () => {
    const target = stub('user-added');
    const io = harness({ pages: [[membershipEvent('evt_1', 'dsync.group.user_added')]] });

    await runInDurableObject(target, instance => instance.poll());

    expect(io.calls.map(c => `${c.method} ${c.path}`)).toEqual([
      'PUT /api/internal/scim/sub-organizations/dir_grp_01',
      'PUT /api/internal/scim/users/dir_usr_01',
      'PUT /api/internal/scim/memberships',
    ]);
    expect(io.calls[0]?.body).toEqual({
      directoryId: 'directory_01',
      directoryIdpId: 'idp_grp_01',
      name: 'Engineering',
    });
    expect(io.calls[1]?.body).toEqual({
      directoryId: 'directory_01',
      email: 'ada@acme.test',
      firstName: 'Ada',
      lastName: 'Lovelace',
    });
    expect(io.calls[2]?.body).toEqual({
      directoryGroupId: 'dir_grp_01',
      externalId: 'dir_usr_01',
    });
    // Every call carries the internal secret; the endpoints refuse without it.
    // Compared against the binding rather than a literal: `.dev.vars` overrides
    // `wrangler.test.jsonc`'s vars, so a developer who has run `pnpm dev:env`
    // supplies their real secret here and a hardcoded expectation would fail
    // for them and pass in CI.
    const configured = await resolveSecret(env.INTERNAL_API_SECRET, 'INTERNAL_API_SECRET');
    expect(io.calls.every(c => c.apiKey === configured)).toBe(true);
  });

  it('revokes every membership for a deletion and for an inactive update', async () => {
    const target = stub('revoke-all');
    const io = harness({
      pages: [
        [
          userEvent('evt_1', 'dsync.user.deleted'),
          userEvent('evt_2', 'dsync.user.updated', { state: 'inactive' }),
        ],
      ],
    });

    await runInDurableObject(target, instance => instance.poll());

    expect(io.calls.map(c => `${c.method} ${c.path}`)).toEqual([
      'DELETE /api/internal/scim/users/dir_usr_01/memberships',
      'DELETE /api/internal/scim/users/dir_usr_01/memberships',
    ]);
    // The directory scopes the revocation: an account that also belongs to
    // another directory's organization keeps those memberships, so the body
    // is required on both branches.
    expect(io.calls.map(c => c.body)).toEqual([
      { directoryId: 'directory_01' },
      { directoryId: 'directory_01' },
    ]);
  });

  it('upserts the user for an active update', async () => {
    const target = stub('active-update');
    const io = harness({
      pages: [[userEvent('evt_1', 'dsync.user.updated', { state: 'active' })]],
    });

    await runInDurableObject(target, instance => instance.poll());

    expect(io.calls.map(c => `${c.method} ${c.path}`)).toEqual([
      'PUT /api/internal/scim/users/dir_usr_01',
    ]);
  });

  it('maps the organization upsert body from the activation payload', async () => {
    const target = stub('activated');
    const io = harness({ pages: [[directoryEvent('evt_1')]] });

    await runInDurableObject(target, instance => instance.poll());

    expect(io.calls[0]).toMatchObject({
      method: 'PUT',
      path: '/api/internal/scim/organizations/directory_01',
      body: {
        workOSOrganizationId: 'org_workos',
        name: 'Acme',
        capturedDomains: ['acme.test'],
      },
    });
  });

  it('revokes one membership for a removal, with no prerequisite upserts', async () => {
    const target = stub('user-removed');
    const io = harness({ pages: [[membershipEvent('evt_1', 'dsync.group.user_removed')]] });

    await runInDurableObject(target, instance => instance.poll());

    expect(io.calls.map(c => `${c.method} ${c.path}`)).toEqual([
      'DELETE /api/internal/scim/memberships',
    ]);
  });

  it('deletes the sub-organization for a group deletion', async () => {
    const target = stub('group-deleted');
    const io = harness({ pages: [[groupEvent('evt_1', 'dsync.group.deleted')]] });

    await runInDurableObject(target, instance => instance.poll());

    expect(io.calls.map(c => `${c.method} ${c.path}`)).toEqual([
      'DELETE /api/internal/scim/sub-organizations/dir_grp_01',
    ]);
  });

  it('deletes the organization for a directory disconnect', async () => {
    const target = stub('dsync-deleted');
    const io = harness({ pages: [[directoryEvent('evt_1', 'org_workos', 'dsync.deleted')]] });

    await runInDurableObject(target, instance => instance.poll());

    expect(io.calls.map(c => `${c.method} ${c.path}`)).toEqual([
      'DELETE /api/internal/scim/organizations/directory_01',
    ]);
  });
});

describe('response classes', () => {
  const RETRYABLE_409: AppRoute = {
    method: 'PUT',
    path: '/organizations/directory_01',
    replies: [{ status: 409, code: 'directory_not_found' }],
  };

  it('holds the cursor and retries a retryable conflict', async () => {
    const target = stub('retryable-409');
    harness({ pages: [[directoryEvent('evt_1')]], routes: [RETRYABLE_409] });
    const held = await runInDurableObject(target, instance => instance.poll());

    expect(held.heldFailure).toMatchObject({ eventId: 'evt_1', attempts: 1, lastStatus: 409 });
    expect(held.eventsParked).toBe(0);
    expect((await readState(target)).rows[CURSOR_KEY]).toBeUndefined();

    // The next tick re-reads the same event, because the cursor did not move.
    const second = harness({ pages: [[directoryEvent('evt_1')]], routes: [RETRYABLE_409] });
    const retried = await runInDurableObject(target, instance => instance.poll());

    expect(second.cursors[0]).toBeNull();
    expect(retried.heldFailure?.attempts).toBe(2);
    expect((await readState(target)).parked).toEqual([]);
  });

  it('parks a terminal conflict code immediately and moves the cursor past it', async () => {
    const target = stub('terminal-409');
    harness({
      pages: [[groupEvent('evt_1'), groupEvent('evt_2')]],
      routes: [
        {
          method: 'PUT',
          path: '/sub-organizations/dir_grp_01',
          replies: [
            { status: 409, code: 'sub_organization_cannot_nest' },
            { status: 200, body: { id: 'org_2', created: true } },
          ],
        },
      ],
    });

    const result = await runInDurableObject(target, instance => instance.poll());

    expect(result.eventsParked).toBe(1);
    expect(result.eventsApplied).toBe(1);
    expect(result.heldFailure).toBeNull();
    // The parked event did not stop the page: `evt_2` was applied behind it.
    expect(result.cursor).toBe('evt_2');

    const state = await readState(target);
    expect(state.parked).toEqual(['evt_1']);
    expect(state.failures).toBe(0);
    expect((await target.getStatus()).parkedCount).toBe(1);
  });

  it('holds the cursor on a 400 and never parks it, so an app-first deploy recovers', async () => {
    const target = stub('retryable-400');
    // Deploy skew: this Worker sends a field the app's `z.strictObject` does
    // not accept yet, so every attempt is a 400 until the app rolls out.
    const ROUTE: AppRoute = {
      method: 'PUT',
      path: '/sub-organizations/dir_grp_01',
      replies: [{ status: 400 }],
    };

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      harness({ pages: [[groupEvent('evt_1')]], routes: [ROUTE] });
      const result = await runInDurableObject(target, instance => instance.poll());

      expect(result.heldFailure).toMatchObject({
        eventId: 'evt_1',
        attempts: attempt,
        lastClass: 'unavailable',
        lastStatus: 400,
      });
      expect(result.eventsParked).toBe(0);
      // Parking would advance the cursor past the event, and nothing replays
      // `parked_events`, so the event would be lost to a condition that
      // clears itself.
      expect((await readState(target)).rows[CURSOR_KEY]).toBeUndefined();
    }

    expect((await readState(target)).parked).toEqual([]);

    // The app deploys and accepts the body: the held event applies and the
    // cursor moves, with no operator action.
    harness({ pages: [[groupEvent('evt_1')]] });
    const recovered = await runInDurableObject(target, instance => instance.poll());

    expect(recovered.eventsApplied).toBe(1);
    const state = await readState(target);
    expect(state.rows[CURSOR_KEY]).toBe('evt_1');
    expect(state.failures).toBe(0);
    expect(state.parked).toEqual([]);
  });

  it('does not follow a redirect and never parses the redirected body as a success', async () => {
    const target = stub('redirect');
    const io = harness({
      pages: [[directoryEvent('evt_1')]],
      routes: [
        {
          method: 'PUT',
          path: '/organizations/directory_01',
          replies: [
            {
              status: 302,
              location: 'https://attacker.test/api/internal/scim/organizations/directory_01',
              // A body that would parse as the route's contract, so following
              // the redirect would look like a clean success.
              body: { id: 'org_1', created: false },
            },
          ],
        },
      ],
    });

    const result = await runInDurableObject(target, instance => instance.poll());

    // One call, to the configured origin: `x-internal-api-key` is a custom
    // header, so a followed cross-origin redirect would have handed the
    // shared internal secret to the redirect's target.
    expect(io.calls.map(c => c.path)).toEqual(['/api/internal/scim/organizations/directory_01']);
    expect(io.calls[0]?.redirect).toBe('manual');

    expect(result.eventsApplied).toBe(0);
    expect(result.heldFailure).toMatchObject({ lastClass: 'unavailable', lastStatus: 302 });
    expect(result.eventsParked).toBe(0);
    expect((await readState(target)).rows[CURSOR_KEY]).toBeUndefined();
  });

  it('records an unexpected dispatcher throw against its event and then makes progress', async () => {
    const target = stub('dispatch-throw');
    // The dispatcher is total: for a payload it cannot map to a request, the
    // failure is recorded against that event, retried, and then parked once the
    // budget from the first failure is spent, so the loop keeps moving and the
    // operator view names the event.
    const clock = steppingClock(0);
    const io = harness({ pages: [[activationWithNonListDomains('evt_1')]] });

    const first = await runInDurableObject(target, instance => instance.poll());

    expect(first.error).toBeNull();
    expect(first.heldFailure).toMatchObject({
      eventId: 'evt_1',
      eventType: 'dsync.activated',
      attempts: 1,
      lastClass: 'conflict',
      lastStatus: null,
    });
    expect(first.heldFailure?.lastError).toContain('could not be dispatched');
    // Nothing was asked of the app: the throw happened building the request.
    expect(io.calls).toEqual([]);
    // The operator view names the event, which is the whole point.
    expect((await target.getStatus()).eventFailure?.eventId).toBe('evt_1');

    // Retried rather than parked on the first attempt, then parked once the
    // budget from the first failure is spent — so the loop moves on instead of
    // spinning on one event.
    harness({ pages: [[activationWithNonListDomains('evt_1')]] });
    const retried = await runInDurableObject(target, instance => instance.poll());
    expect(retried.heldFailure?.attempts).toBe(2);
    expect(retried.eventsParked).toBe(0);

    clock.advanceBy(CONFLICT_RETRY_BUDGET_MS);
    harness({ pages: [[activationWithNonListDomains('evt_1'), directoryEvent('evt_2')]] });
    const parked = await runInDurableObject(target, instance => instance.poll());

    expect(parked.eventsParked).toBe(1);
    expect(parked.eventsApplied).toBe(1);
    expect(parked.cursor).toBe('evt_2');
    const state = await readState(target);
    expect(state.parked).toEqual(['evt_1']);
    expect(state.failures).toBe(0);
  });

  it('applies an activation for a directory with no domains and the next event in one poll', async () => {
    const target = stub('activation-without-domains');
    // A directory created before any domain is attached arrives without
    // `domains`. Both events apply in one poll, in stream order, and the cursor
    // advances past each of them.
    const io = harness({
      pages: [[activationWithoutDomains('evt_1'), directoryEvent('evt_2', null, 'dsync.deleted')]],
    });

    const result = await runInDurableObject(target, instance => instance.poll());

    expect(result.error).toBeNull();
    expect(result.heldFailure).toBeNull();
    expect(result.eventsApplied).toBe(2);
    expect(result.eventsParked).toBe(0);
    expect(result.cursor).toBe('evt_2');
    // Both events reached the app, in stream order.
    expect(io.calls.map(call => `${call.method} ${call.path}`)).toEqual([
      'PUT /api/internal/scim/organizations/directory_01',
      'DELETE /api/internal/scim/organizations/directory_01',
    ]);
    // No domains on the event means an empty list in the body, which the route
    // reads as saying nothing about domains.
    expect(io.calls[0]?.body).toEqual({
      workOSOrganizationId: 'org_workos',
      name: 'Acme',
      capturedDomains: [],
    });
    const state = await readState(target);
    expect(state.rows[CURSOR_KEY]).toBe('evt_2');
    expect(state.failures).toBe(0);
    expect(state.parked).toEqual([]);
  });

  it('never parks a 5xx, however many times it repeats', async () => {
    const target = stub('server-error');
    const routes: AppRoute[] = [
      { method: 'PUT', path: '/organizations/directory_01', replies: [{ status: 500 }] },
    ];

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      harness({ pages: [[directoryEvent('evt_1')]], routes });
      const result = await runInDurableObject(target, instance => instance.poll());
      expect(result.heldFailure).toMatchObject({ attempts: attempt, lastClass: 'unavailable' });
      expect(result.eventsParked).toBe(0);
    }

    const state = await readState(target);
    expect(state.parked).toEqual([]);
    expect(state.rows[CURSOR_KEY]).toBeUndefined();
  });

  it('never parks a 401, because a wrong secret is not a bad event', async () => {
    const target = stub('unauthorized');
    harness({
      pages: [[directoryEvent('evt_1')]],
      routes: [{ method: 'PUT', path: '/organizations/directory_01', replies: [{ status: 401 }] }],
    });

    const result = await runInDurableObject(target, instance => instance.poll());

    expect(result.heldFailure).toMatchObject({ lastClass: 'unavailable', lastStatus: 401 });
    expect(result.eventsParked).toBe(0);
  });

  it('omits the Vercel bypass header when no bypass is configured', async () => {
    const target = stub('no-bypass');
    const io = harness({ pages: [[directoryEvent('evt_1')]] });

    await runInDurableObject(target, instance => instance.poll());

    // Production's origin is unprotected, and an empty bypass is a *rejected*
    // bypass rather than no bypass, so the header must be absent entirely.
    expect(io.calls).toHaveLength(1);
    expect(io.calls[0]?.protectionBypass).toBeNull();
  });

  it('sends the Vercel bypass header when one is configured', async () => {
    const target = stub('with-bypass');
    const io = harness({ pages: [[directoryEvent('evt_1')]] });

    // Staging's origin sits behind Deployment Protection: without this header
    // Vercel's edge answers every call before the app runs, so no
    // `x-internal-api-key` can authenticate. The binding is read per poll, so
    // setting it on the test env is what the deployed secret does.
    const configured = env as Env;
    configured.SCIM_PROTECTION_BYPASS = 'bypass-token';
    try {
      await runInDurableObject(target, instance => instance.poll());

      expect(io.calls).toHaveLength(1);
      expect(io.calls[0]?.protectionBypass).toBe('bypass-token');
      // The internal secret still travels with it; the bypass only gets past
      // the edge, it does not authenticate.
      expect(io.calls[0]?.apiKey).not.toBeNull();
    } finally {
      delete configured.SCIM_PROTECTION_BYPASS;
    }
  });

  it('never parks a network failure', async () => {
    const target = stub('network-error');
    harness({
      pages: [[directoryEvent('evt_1')]],
      routes: [
        {
          method: 'PUT',
          path: '/organizations/directory_01',
          replies: [{ throws: 'connection reset' }],
        },
      ],
    });

    const result = await runInDurableObject(target, instance => instance.poll());

    expect(result.heldFailure).toMatchObject({ lastClass: 'unavailable', lastStatus: null });
    expect(result.eventsParked).toBe(0);
  });

  it('parks a payload no request body can express, without calling the app', async () => {
    const target = stub('payload-terminal');
    const io = harness({
      pages: [
        [userEvent('evt_1', 'dsync.user.created', { email: null }), directoryEvent('evt_2', null)],
      ],
    });

    const result = await runInDurableObject(target, instance => instance.poll());

    expect(io.calls).toEqual([]);
    expect(result.eventsParked).toBe(2);
    expect(result.cursor).toBe('evt_2');
    expect((await readState(target)).parked).toEqual(['evt_1', 'evt_2']);
  });

  it('parks directory data the app would reject, instead of holding the stream', async () => {
    const target = stub('invalid-directory-data');
    // A real IdP can deliver an address the app's `.email()` check refuses.
    // Before the body was validated here, that produced a 400 on every
    // retry — classified `unavailable`, which never parks — so one tenant's
    // bad attribute stalled the single namespace for every tenant.
    const io = harness({
      pages: [
        [
          userEvent('evt_1', 'dsync.user.created', { email: 'not-an-address' }),
          userEvent('evt_2', 'dsync.user.created'),
        ],
      ],
    });

    const result = await runInDurableObject(target, instance => instance.poll());

    // No request spent on a body that cannot be accepted.
    expect(io.calls.map(call => call.path)).toEqual(['/api/internal/scim/users/dir_usr_01']);
    expect(result.eventsParked).toBe(1);
    expect(result.eventsApplied).toBe(1);
    // The stream kept moving: the valid event behind the bad one applied.
    expect(result.cursor).toBe('evt_2');
    expect((await readState(target)).parked).toEqual(['evt_1']);
  });

  it('stops an event at its first failed call, so later calls do not run', async () => {
    const target = stub('partial-event');
    const io = harness({
      pages: [[membershipEvent('evt_1', 'dsync.group.user_added')]],
      routes: [
        {
          method: 'PUT',
          path: '/sub-organizations/dir_grp_01',
          replies: [{ status: 409, code: 'directory_not_found' }],
        },
      ],
    });

    const result = await runInDurableObject(target, instance => instance.poll());

    expect(io.calls.map(c => c.path)).toEqual(['/api/internal/scim/sub-organizations/dir_grp_01']);
    expect(result.heldFailure?.eventId).toBe('evt_1');
  });
});

describe('directory conflict bounds', () => {
  /** The directory's organization was never bound to the group's directory. */
  const MISSING_DIRECTORY = (groupPath: string): AppRoute => ({
    method: 'PUT',
    path: `/sub-organizations/${groupPath}`,
    replies: [{ status: 409, code: 'directory_not_found' }],
  });

  const GROUP_ROUTE = (groupPath: string): string =>
    `/api/internal/scim/sub-organizations/${groupPath}`;

  it('holds the shared cursor for one window per directory, then continues', async () => {
    const target = stub('directory-window');
    const clock = steppingClock(0);
    const routes = [MISSING_DIRECTORY('dir_grp_01'), MISSING_DIRECTORY('dir_grp_02')];

    // The first conflicting group of a directory: held, with its window open.
    harness({ pages: [[groupEvent('evt_1')]], routes });
    const held = await runInDurableObject(target, instance => instance.poll());
    expect(held.heldFailure?.eventId).toBe('evt_1');
    expect(held.eventsParked).toBe(0);

    // Half a budget later the same event still holds, which is the per-event
    // budget doing its work.
    clock.advanceBy(CONFLICT_RETRY_BUDGET_MS / 2);
    harness({ pages: [[groupEvent('evt_1')]], routes });
    const stillHeld = await runInDurableObject(target, instance => instance.poll());
    expect(stillHeld.heldFailure?.eventId).toBe('evt_1');
    expect(stillHeld.eventsParked).toBe(0);

    // Past the budget the first event parks, and the same directory's second
    // conflicting group parks in the same poll, so another directory's group
    // applies behind both of them.
    clock.advanceBy(CONFLICT_RETRY_BUDGET_MS);
    const io = harness({
      pages: [
        [
          groupEvent('evt_1'),
          groupEvent('evt_2', 'dsync.group.created', { groupId: 'dir_grp_02' }),
          groupEvent('evt_3', 'dsync.group.created', {
            directoryId: 'directory_02',
            groupId: 'dir_grp_03',
          }),
        ],
      ],
      routes,
    });
    const result = await runInDurableObject(target, instance => instance.poll());

    expect(result.heldFailure).toBeNull();
    expect(result.eventsParked).toBe(2);
    expect(result.eventsApplied).toBe(1);
    expect(result.cursor).toBe('evt_3');
    // All three events were attempted in this poll, so the second conflict cost
    // no additional window.
    expect(io.calls.map(call => call.path)).toEqual([
      GROUP_ROUTE('dir_grp_01'),
      GROUP_ROUTE('dir_grp_02'),
      GROUP_ROUTE('dir_grp_03'),
    ]);

    const state = await readState(target);
    expect(state.parked).toEqual(['evt_1', 'evt_2']);
    expect(state.rows[CURSOR_KEY]).toBe('evt_3');
    // The park records the directory rule alongside the app's answer, so an
    // operator can tell the two apart.
    expect(state.parkedReasons['evt_2']).toContain('spent its conflict window');
    expect(state.parkedClasses['evt_2']).toBe('conflict');
  });

  it('parks a directory’s missing-organization conflicts once its activation was parked', async () => {
    const target = stub('parked-activation');
    const io = harness({
      pages: [
        [
          activationWithRejectedBody('evt_1'),
          groupEvent('evt_2'),
          groupEvent('evt_3', 'dsync.group.created', {
            directoryId: 'directory_02',
            groupId: 'dir_grp_03',
          }),
        ],
      ],
      routes: [MISSING_DIRECTORY('dir_grp_01')],
    });

    const result = await runInDurableObject(target, instance => instance.poll());

    // The activation was rejected before any request, so no organization was
    // bound for that directory.
    expect(io.calls.map(call => call.path)).toEqual([
      GROUP_ROUTE('dir_grp_01'),
      GROUP_ROUTE('dir_grp_03'),
    ]);
    expect(result.heldFailure).toBeNull();
    expect(result.eventsParked).toBe(2);
    expect(result.eventsApplied).toBe(1);
    expect(result.cursor).toBe('evt_3');

    const state = await readState(target);
    expect(state.parked).toEqual(['evt_1', 'evt_2']);
    // The later conflict records terminal, and its reason names the activation
    // that was abandoned.
    expect(state.parkedClasses['evt_2']).toBe('terminal');
    expect(state.parkedReasons['evt_2']).toContain('activation was parked');
    expect((await target.getStatus()).parkedCount).toBe(2);
  });

  it('holds a directory to one window across the events it applies', async () => {
    const target = stub('converging-removal');
    const clock = steppingClock(0);
    const routes = [MISSING_DIRECTORY('dir_grp_01'), MISSING_DIRECTORY('dir_grp_02')];

    harness({ pages: [[groupEvent('evt_1')]], routes });
    await runInDurableObject(target, instance => instance.poll());

    // The window opened at `evt_1` stays spent while `evt_2` applies, so both
    // conflicting groups park in this poll.
    clock.advanceBy(CONFLICT_RETRY_BUDGET_MS);
    harness({
      pages: [
        [
          groupEvent('evt_1'),
          membershipEvent('evt_2', 'dsync.group.user_removed'),
          groupEvent('evt_3', 'dsync.group.created', { groupId: 'dir_grp_02' }),
          groupEvent('evt_4', 'dsync.group.created', {
            directoryId: 'directory_02',
            groupId: 'dir_grp_03',
          }),
        ],
      ],
      routes,
    });
    const result = await runInDurableObject(target, instance => instance.poll());

    expect(result.heldFailure).toBeNull();
    expect(result.eventsParked).toBe(2);
    expect(result.eventsApplied).toBe(2);
    expect(result.cursor).toBe('evt_4');
    expect((await readState(target)).parked).toEqual(['evt_1', 'evt_3']);
  });

  it('keeps a spent window spent once an activation of that directory applies', async () => {
    const target = stub('activation-does-not-rearm');
    const clock = steppingClock(0);
    const routes = [MISSING_DIRECTORY('dir_grp_01'), MISSING_DIRECTORY('dir_grp_02')];

    // The directory's first conflict opens its window.
    harness({ pages: [[groupEvent('evt_1')]], routes });
    const held = await runInDurableObject(target, instance => instance.poll());
    expect(held.heldFailure?.eventId).toBe('evt_1');

    // A budget later the window is spent. The event that opened it parks, the
    // activation behind it applies and binds the directory's organization, and
    // the directory's next conflict parks at once: only the event that opened
    // the window closes it, so the window stays spent across that activation.
    clock.advanceBy(CONFLICT_RETRY_BUDGET_MS);
    harness({
      pages: [
        [
          groupEvent('evt_1'),
          directoryEvent('evt_2'),
          groupEvent('evt_3', 'dsync.group.created', { groupId: 'dir_grp_02' }),
        ],
      ],
      routes,
    });
    const result = await runInDurableObject(target, instance => instance.poll());

    expect(result.eventsApplied).toBe(1);
    expect(result.eventsParked).toBe(2);
    expect(result.heldFailure).toBeNull();
    expect(result.cursor).toBe('evt_3');

    const state = await readState(target);
    expect(state.parked).toEqual(['evt_1', 'evt_3']);
    expect(state.parkedReasons['evt_3']).toContain('spent its conflict window');
  });

  it('gives a directory a fresh window once the event that opened it applies', async () => {
    const target = stub('window-closed');
    const clock = steppingClock(0);

    harness({ pages: [[groupEvent('evt_1')]], routes: [MISSING_DIRECTORY('dir_grp_01')] });
    const held = await runInDurableObject(target, instance => instance.poll());
    expect(held.heldFailure?.eventId).toBe('evt_1');

    // The dependency arrives behind the cursor, so the held event applies. That
    // is the only event whose success closes the window, and it does here.
    clock.advanceBy(CONFLICT_RETRY_BUDGET_MS / 2);
    harness({
      pages: [
        [
          groupEvent('evt_1'),
          groupEvent('evt_2', 'dsync.group.created', { groupId: 'dir_grp_02' }),
        ],
      ],
      routes: [
        {
          method: 'PUT',
          path: '/sub-organizations/dir_grp_01',
          replies: [{ status: 200, body: { id: 'org_2', created: true } }],
        },
        MISSING_DIRECTORY('dir_grp_02'),
      ],
    });
    const progressed = await runInDurableObject(target, instance => instance.poll());
    expect(progressed.eventsApplied).toBe(1);
    expect(progressed.heldFailure?.eventId).toBe('evt_2');

    // Half a budget into the new window the conflict still holds, so the window
    // was measured from the event applying.
    clock.advanceBy(CONFLICT_RETRY_BUDGET_MS / 2);
    harness({
      pages: [[groupEvent('evt_2', 'dsync.group.created', { groupId: 'dir_grp_02' })]],
      routes: [MISSING_DIRECTORY('dir_grp_02')],
    });
    const stillHeld = await runInDurableObject(target, instance => instance.poll());
    expect(stillHeld.eventsParked).toBe(0);
    expect(stillHeld.heldFailure?.eventId).toBe('evt_2');

    // A whole budget after it opened, it parks.
    clock.advanceBy(CONFLICT_RETRY_BUDGET_MS);
    harness({
      pages: [[groupEvent('evt_2', 'dsync.group.created', { groupId: 'dir_grp_02' })]],
      routes: [MISSING_DIRECTORY('dir_grp_02')],
    });
    const parked = await runInDurableObject(target, instance => instance.poll());
    expect(parked.eventsParked).toBe(1);
    expect((await readState(target)).parked).toEqual(['evt_2']);
  });
});

describe('cursor override', () => {
  it('lets a changed WORKOS_EVENT_CURSOR win over stored state', async () => {
    const target = stub('override');
    harness({ pages: [[directoryEvent('evt_1')]] });
    await runInDurableObject(target, instance => instance.poll());
    expect((await readState(target)).rows[CURSOR_KEY]).toBe('evt_1');

    await withCursorVar('evt_rewind', async () => {
      const second = harness({ pages: [[]] });
      const result = await runInDurableObject(target, instance => instance.poll());

      expect(second.cursors[0]).toBe('evt_rewind');
      expect(result.cursorSource).toBe('var');
      const state = await readState(target);
      expect(state.rows[CURSOR_KEY]).toBe('evt_rewind');
      expect(state.rows[SEED_CURSOR_KEY]).toBe('evt_rewind');
    });
  });

  it('leaves live state alone when the var is unchanged', async () => {
    const target = stub('no-override');

    await withCursorVar('evt_seed', async () => {
      harness({ pages: [[directoryEvent('evt_1')]] });
      await runInDurableObject(target, instance => instance.poll());
      expect((await readState(target)).rows[CURSOR_KEY]).toBe('evt_1');

      // Same var, a later tick: the advanced cursor must survive it.
      const second = harness({ pages: [[]] });
      const result = await runInDurableObject(target, instance => instance.poll());

      expect(second.cursors[0]).toBe('evt_1');
      expect(result.cursorSource).toBe('stored');
      expect((await readState(target)).rows[SEED_CURSOR_KEY]).toBe('evt_seed');
    });
  });

  it('clears the held failure on a forward reset past the held event', async () => {
    const target = stub('override-clears');
    const HELD: AppRoute = {
      method: 'PUT',
      path: '/organizations/directory_01',
      replies: [{ status: 500 }],
    };
    harness({ pages: [[directoryEvent('evt_1')]], routes: [HELD] });
    await runInDurableObject(target, instance => instance.poll());
    expect((await readState(target)).failure).toMatchObject({ eventId: 'evt_1' });

    // Resetting *past* the held event: only that event applying or being
    // parked clears its row, and neither can happen once the cursor is ahead
    // of it, so a surviving row would leave `/status.eventFailure` non-null
    // forever and the loop would look stuck when it is not.
    await withCursorVar('evt_9', async () => {
      harness({ pages: [[]] });
      const result = await runInDurableObject(target, instance => instance.poll());

      expect(result.cursorSource).toBe('var');
      expect(result.heldFailure).toBeNull();
      expect((await readState(target)).failure).toBeNull();
      expect((await target.getStatus()).eventFailure).toBeNull();
    });
  });

  it('gives a rewind onto a previously held event a fresh attempt count', async () => {
    const target = stub('override-rewind');
    const clock = steppingClock(0);
    const CONFLICTED: AppRoute = {
      method: 'PUT',
      path: '/organizations/directory_01',
      replies: [{ status: 409, code: 'directory_not_found' }],
    };

    harness({ pages: [[directoryEvent('evt_1')]], routes: [CONFLICTED] });
    const held = await runInDurableObject(target, instance => instance.poll());
    expect(held.heldFailure).toMatchObject({ eventId: 'evt_1', attempts: 1 });

    // The conflict budget runs out while the event is held, so the next
    // attempt on the carried row would park it.
    clock.advanceBy(CONFLICT_RETRY_BUDGET_MS);

    await withCursorVar('evt_0', async () => {
      harness({ pages: [[directoryEvent('evt_1')]], routes: [CONFLICTED] });
      const result = await runInDurableObject(target, instance => instance.poll());

      // A reset is a deliberate "start from here", so the replayed event gets
      // the whole retry budget again rather than inheriting the spent one.
      expect(result.cursorSource).toBe('var');
      expect(result.eventsParked).toBe(0);
      expect(result.heldFailure).toMatchObject({ eventId: 'evt_1', attempts: 1 });
      const state = await readState(target);
      expect(state.failure).toMatchObject({ eventId: 'evt_1', attempts: 1 });
      expect(state.parked).toEqual([]);
    });
  });
});

describe('scheduling', () => {
  it('arms an alarm once and leaves a live one untouched', async () => {
    const target = stub('schedule');

    const armed = await target.ensureScheduled();
    expect(armed.armed).toBe(true);

    const again = await target.ensureScheduled();
    expect(again.armed).toBe(false);
    expect(again.nextAlarmAt).toBe(armed.nextAlarmAt);
  });

  it('always reschedules, even when the poll fails', async () => {
    const target = stub('alarm-reschedule');
    harness({
      pages: [[directoryEvent('evt_1')]],
      routes: [{ method: 'PUT', path: '/organizations/directory_01', replies: [{ status: 500 }] }],
    });

    await runInDurableObject(target, async (instance, instanceState) => {
      await instance.alarm();
      // An alarm that threw past its own reschedule would strand the loop
      // until the cron watchdog noticed.
      expect(await instanceState.storage.getAlarm()).not.toBeNull();
    });

    const status = await target.getStatus();
    expect(status.lastPoll?.heldFailure?.eventId).toBe('evt_1');
    expect(status.nextAlarmAt).not.toBeNull();
  });
});

/**
 * Retention is decided by `parked_at`, so these tests seed rows through the
 * Durable Object's own drizzle handle: only a seeded date puts a row outside
 * the window without waiting 30 days, and the loop's park path always writes
 * `Date.now()`.
 */
describe('parked-event retention', () => {
  it('removes only the rows strictly older than the window', async () => {
    const target = stub('retention-boundary');
    // Frozen so the alarm's `Date.now()` is the same instant the rows are
    // measured from: a few milliseconds of real time between seeding and the
    // tick would otherwise expire the row parked exactly on the cutoff.
    steppingClock(0);
    const now = Date.now();
    const retention = PARKED_EVENT_RETENTION_MS;
    const infoSpy = vi.spyOn(logger, 'info');

    await seedParked(target, [
      { eventId: 'expired', parkedAt: now - retention - 1 },
      // Exactly on the cutoff: the comparison is strict, so this row survives
      // this tick and the next one removes it.
      { eventId: 'at_cutoff', parkedAt: now - retention },
      { eventId: 'inside', parkedAt: now - retention + 1 },
    ]);
    harness({ pages: [[]] });

    await runInDurableObject(target, instance => instance.alarm());

    const state = await readState(target);
    expect(state.parked.sort()).toEqual(['at_cutoff', 'inside']);
    // `/status` counts what is retained, so the expired row is not in it.
    expect((await target.getStatus()).parkedCount).toBe(2);
    // The count the operator sees in the log is the one row this fixture put
    // outside the window, not the three the table held.
    expect(infoSpy).toHaveBeenCalledWith('SCIM sync expired parked events', { removed: 1 });
  });

  it('reports only the rows inside the window before a tick deletes the rest', async () => {
    const target = stub('retention-count-window');
    // Frozen, so the expired row is still past the window when `/status` reads
    // its own `Date.now()`, not only when the seeded row was written.
    steppingClock(0);
    const now = Date.now();
    const retention = PARKED_EVENT_RETENTION_MS;

    await seedParked(target, [
      { eventId: 'expired', parkedAt: now - retention - 1 },
      { eventId: 'retained', parkedAt: now - 1_000 },
    ]);
    harness({ pages: [[]] });

    // Read before any tick: the expired row is still in storage, because the
    // delete rides on the alarm, and `/status` must not report it anyway.
    expect((await readState(target)).parked.sort()).toEqual(['expired', 'retained']);
    expect((await target.getStatus()).parkedCount).toBe(1);

    await runInDurableObject(target, instance => instance.alarm());

    // The tick removes the expired row from storage and the count is unchanged.
    expect((await readState(target)).parked).toEqual(['retained']);
    expect((await target.getStatus()).parkedCount).toBe(1);
  });

  it('is a no-op on an empty table and safe to repeat', async () => {
    const target = stub('retention-empty');
    harness({ pages: [[]] });

    await runInDurableObject(target, async (instance, instanceState) => {
      await instance.alarm();
      expect(await instanceState.storage.getAlarm()).not.toBeNull();

      // A second tick deletes nothing either, and the loop is still armed
      // afterwards: an empty prune must not look like a failed one.
      await instance.alarm();
      expect(await instanceState.storage.getAlarm()).not.toBeNull();
    });

    const state = await readState(target);
    expect(state.parked).toEqual([]);
    expect((await target.getStatus()).parkedCount).toBe(0);
  });

  it('leaves the cursor and every other table untouched', async () => {
    const target = stub('retention-live-state');
    const now = Date.now();
    harness({ pages: [[]] });

    await runInDurableObject(target, (_instance, instanceState) => {
      const db = drizzle(instanceState.storage);
      db.insert(syncState)
        .values([
          { key: CURSOR_KEY, value: 'evt_cursor' },
          // An empty seed is what a poll under the unset `WORKOS_EVENT_CURSOR`
          // writes, so the alarm's poll reads these rows as live state instead
          // of treating the cursor as an operator override.
          { key: SEED_CURSOR_KEY, value: '' },
        ])
        .run();
      db.insert(eventFailures)
        .values({
          event_id: 'evt_held',
          event_type: 'dsync.group.created',
          attempts: 2,
          last_class: 'conflict',
          last_status: 409,
          last_error: 'directory_not_found',
          first_failed_at: now - 1_000,
          last_attempt_at: now - 500,
        })
        .run();
      db.insert(directoryConflicts)
        .values({
          directory_id: 'directory_01',
          event_id: 'evt_held',
          first_conflict_at: now - 1_000,
        })
        .run();
      db.insert(parkedActivations)
        .values({ directory_id: 'directory_02', parked_at: now - 1_000 })
        .run();
      db.insert(parkedEvents)
        .values([
          {
            event_id: 'evt_fresh',
            event_type: 'dsync.user.created',
            class: 'terminal',
            status: 400,
            error: 'seeded',
            attempts: 1,
            parked_at: now - 1_000,
          },
          {
            event_id: 'evt_expired',
            event_type: 'dsync.user.created',
            class: 'terminal',
            status: 400,
            error: 'seeded',
            attempts: 1,
            parked_at: now - PARKED_EVENT_RETENTION_MS - 1,
          },
        ])
        .run();
    });

    await runInDurableObject(target, instance => instance.alarm());

    const survivors = await runInDurableObject(target, (_instance, instanceState) => {
      const db = drizzle(instanceState.storage);
      const rows = db.select().from(syncState).all();
      return {
        cursor: rows.find(row => row.key === CURSOR_KEY)?.value,
        seed: rows.find(row => row.key === SEED_CURSOR_KEY)?.value,
        held: db
          .select()
          .from(eventFailures)
          .all()
          .map(row => row.event_id),
        conflicts: db
          .select()
          .from(directoryConflicts)
          .all()
          .map(row => row.directory_id),
        activations: db
          .select()
          .from(parkedActivations)
          .all()
          .map(row => row.directory_id),
      };
    });

    expect(survivors).toEqual({
      cursor: 'evt_cursor',
      seed: '',
      held: ['evt_held'],
      conflicts: ['directory_01'],
      activations: ['directory_02'],
    });
    const state = await readState(target);
    expect(state.parked).toEqual(['evt_fresh']);
    expect((await target.getStatus()).parkedCount).toBe(1);
  });

  it('logs a failed prune and still polls and reschedules', async () => {
    const target = stub('retention-prune-failure');
    const io = harness({ pages: [[directoryEvent('evt_1')]] });
    const errorSpy = vi.spyOn(logger, 'error');
    const message = 'sqlite did not answer';

    await runInDurableObject(target, async (instance, instanceState) => {
      // `state.pruneParkedEvents` is an ESM namespace export, and workerd makes
      // those bindings read-only, so `vi.spyOn` cannot patch it. Overriding the
      // instance's own method is the narrow seam that fails one tick's prune;
      // the prototype method is untouched, and the original is put back.
      const seam = instance as unknown as { pruneParkedEvents: () => void };
      const original = seam.pruneParkedEvents;
      seam.pruneParkedEvents = () => {
        throw new Error(message);
      };
      try {
        await instance.alarm();
      } finally {
        seam.pruneParkedEvents = original;
      }

      expect(await instanceState.storage.getAlarm()).not.toBeNull();
      expect(await instanceState.storage.get(LAST_POLL_KEY)).not.toBeNull();
    });

    expect(errorSpy).toHaveBeenCalledWith('SCIM sync parked-event prune failed', {
      error: message,
    });
    // The poll ran anyway, so nothing was lost to the failed delete: the next
    // tick retries it with a later cutoff.
    expect(io.calls).toHaveLength(1);
    expect((await readState(target)).rows[CURSOR_KEY]).toBe('evt_1');
  });

  it('keeps a parked row readable while the stream replays inside the window', async () => {
    const target = stub('retention-replay');

    // The shared request contract rejects this activation's body, so it parks
    // without an HTTP call and the row appears deterministically.
    harness({ pages: [[activationWithRejectedBody('evt_parked')]] });
    const parked = await runInDurableObject(target, instance => instance.poll());
    expect(parked.eventsParked).toBe(1);
    expect((await readState(target)).parked).toEqual(['evt_parked']);

    // A tick inside the window keeps it.
    harness({ pages: [[]] });
    await runInDurableObject(target, instance => instance.alarm());
    expect((await readState(target)).parked).toEqual(['evt_parked']);
    expect((await target.getStatus()).parkedCount).toBe(1);

    // An operator rewinds to before it and the replay applies the same event
    // id: a successful apply removes the held failure, never the park record.
    await withCursorVar('evt_0', async () => {
      harness({ pages: [[directoryEvent('evt_parked')]] });
      const replay = await runInDurableObject(target, instance => instance.poll());

      expect(replay.cursorSource).toBe('var');
      expect(replay.eventsApplied).toBe(1);
      expect(replay.cursor).toBe('evt_parked');
      const state = await readState(target);
      expect(state.rows[CURSOR_KEY]).toBe('evt_parked');
      expect(state.parked).toEqual(['evt_parked']);
    });
  });

  it('refreshes a re-parked row so the record and the window follow the latest park', async () => {
    const target = stub('retention-repark');
    // Frozen, so the seeded row is 40 days old at the instant the loop parks.
    // That is outside the window: only a refresh of `parked_at` keeps the row.
    steppingClock(0);
    const now = Date.now();

    await seedParked(target, [
      {
        eventId: 'evt_reparked',
        parkedAt: now - 40 * 24 * 60 * 60 * 1_000,
        error: 'stale first park',
      },
    ]);

    // A rewind replays the event and it parks again, so the decision made now
    // is the one the row has to carry.
    harness({ pages: [[activationWithRejectedBody('evt_reparked')]] });
    const parked = await runInDurableObject(target, instance => instance.poll());
    expect(parked.eventsParked).toBe(1);

    // The alarm prunes before it polls. A row still carrying the seeded date is
    // deleted on this tick; a refreshed `parked_at` is inside the window.
    harness({ pages: [[]] });
    await runInDurableObject(target, instance => instance.alarm());

    const state = await readState(target);
    expect(state.parked).toEqual(['evt_reparked']);
    expect((await target.getStatus()).parkedCount).toBe(1);
    expect(state.parkedReasons['evt_reparked']).toContain('body rejected by the request contract');
    expect(state.parkedReasons['evt_reparked']).not.toBe('stale first park');
  });
});

/**
 * Writes `parked_events` rows at the dates the retention test needs. The loop
 * itself always parks at `Date.now()`, so a row outside the window can only be
 * seeded.
 */
async function seedParked(
  target: DurableObjectStub<ScimSyncDO>,
  rows: { eventId: string; parkedAt: number; error?: string }[]
): Promise<void> {
  await runInDurableObject(target, (_instance, instanceState) => {
    const db = drizzle(instanceState.storage);
    db.insert(parkedEvents)
      .values(
        rows.map(row => ({
          event_id: row.eventId,
          event_type: 'dsync.user.created',
          class: 'terminal',
          status: 400,
          error: row.error ?? 'seeded',
          attempts: 1,
          parked_at: row.parkedAt,
        }))
      )
      .run();
  });
}

/**
 * `WORKOS_EVENT_CURSOR` is a var, so overriding it is how an operator resets
 * the stream. The binding object the Durable Object reads is the one the test
 * holds, so it is set and restored around the assertion.
 */
async function withCursorVar(value: string, body: () => Promise<void>): Promise<void> {
  // `wrangler types` narrows the var to the literal `""` it carries in config,
  // so writing it needs a widened view of the same binding object.
  const vars: { WORKOS_EVENT_CURSOR: string } = env;
  const previous = vars.WORKOS_EVENT_CURSOR;
  vars.WORKOS_EVENT_CURSOR = value;
  try {
    await body();
  } finally {
    vars.WORKOS_EVENT_CURSOR = previous;
  }
}
