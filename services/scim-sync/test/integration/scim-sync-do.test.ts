import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import {
  CONFLICT_RETRY_BUDGET_MS,
  CURSOR_KEY,
  DRAIN_BUDGET_MS,
  PAGE_LIMIT,
  SEED_CURSOR_KEY,
} from '../../src/util/constants';
import { resolveSecret } from '../../src/util/secret';
import {
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
    // The SDK copies `domains` through without defaulting it, so an activation
    // without the field makes the dispatcher's `.map(...)` throw a TypeError.
    // Unrecorded, that unwound into the poll's catch: a poll-level error with
    // no event id, no `event_failures` row and an unmoved cursor, so every
    // later poll refetched the same event and threw again forever.
    const clock = steppingClock(0);
    const io = harness({ pages: [[activationWithoutDomains('evt_1')]] });

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
    harness({ pages: [[activationWithoutDomains('evt_1')]] });
    const retried = await runInDurableObject(target, instance => instance.poll());
    expect(retried.heldFailure?.attempts).toBe(2);
    expect(retried.eventsParked).toBe(0);

    clock.advanceBy(CONFLICT_RETRY_BUDGET_MS);
    harness({ pages: [[activationWithoutDomains('evt_1'), directoryEvent('evt_2')]] });
    const parked = await runInDurableObject(target, instance => instance.poll());

    expect(parked.eventsParked).toBe(1);
    expect(parked.eventsApplied).toBe(1);
    expect(parked.cursor).toBe('evt_2');
    const state = await readState(target);
    expect(state.parked).toEqual(['evt_1']);
    expect(state.failures).toBe(0);
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
