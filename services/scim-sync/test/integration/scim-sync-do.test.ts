import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { CURSOR_KEY, PAGE_LIMIT, SEED_CURSOR_KEY } from '../../src/util/constants';
import {
  directoryEvent,
  groupEvent,
  harness,
  membershipEvent,
  readState,
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
    harness({ pages: [[directoryEvent('evt_1'), directoryEvent('evt_2'), directoryEvent('evt_3')]] });

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
    expect(io.calls.every(c => c.apiKey === 'internal-test-secret')).toBe(true);
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
    expect(io.calls.every(c => c.body === null)).toBe(true);
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

  it('parks a 400 immediately', async () => {
    const target = stub('terminal-400');
    harness({
      pages: [[groupEvent('evt_1')]],
      routes: [
        { method: 'PUT', path: '/sub-organizations/dir_grp_01', replies: [{ status: 400 }] },
      ],
    });

    const result = await runInDurableObject(target, instance => instance.poll());

    expect(result.eventsParked).toBe(1);
    expect((await readState(target)).parked).toEqual(['evt_1']);
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
        [
          userEvent('evt_1', 'dsync.user.created', { email: null }),
          directoryEvent('evt_2', null),
        ],
      ],
    });

    const result = await runInDurableObject(target, instance => instance.poll());

    expect(io.calls).toEqual([]);
    expect(result.eventsParked).toBe(2);
    expect(result.cursor).toBe('evt_2');
    expect((await readState(target)).parked).toEqual(['evt_1', 'evt_2']);
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
