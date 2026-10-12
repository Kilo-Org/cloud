import { beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import {
  cli_sessions_v2,
  organization_memberships,
  organizations,
  todo_item_sessions,
  todo_items,
  todo_lists,
  type NewCliSessionV2,
  type User,
} from '@kilocode/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { todosRouter } from './todos-router';

const USER_ID = 'oauth/github|todo-owner';
const OTHER_USER_ID = 'oauth/github|other-todo-owner';
const ORGANIZATION_ID = '3c384401-b75d-4375-a1ba-e319a02e18b7';
const FOREIGN_ORGANIZATION_ID = '4c384401-b75d-4375-a1ba-e319a02e18b7';

let user: User;
let otherUser: User;

function callerFor(account = user) {
  return todosRouter.createCaller({ user: account });
}

async function insertSession(overrides: Partial<NewCliSessionV2> = {}) {
  const [session] = await db
    .insert(cli_sessions_v2)
    .values({
      session_id: `ses_${crypto.randomUUID().replaceAll('-', '').slice(0, 26)}`,
      kilo_user_id: USER_ID,
      title: 'Linked session',
      created_on_platform: 'cloud-agent-web',
      ...overrides,
    })
    .returning();
  if (!session) throw new Error('Session fixture was not inserted');
  return session;
}

async function readLinks() {
  return db
    .select()
    .from(todo_item_sessions)
    .where(inArray(todo_item_sessions.kilo_user_id, [USER_ID, OTHER_USER_ID]));
}

async function listNames(caller = callerFor(), organizationId: string | null = null) {
  return (await caller.lists.list({ organizationId })).map(list => list.name);
}

async function openTitles(listId: string) {
  return (await callerFor().items.list({ listId }))
    .filter(item => item.doneAt === null)
    .map(item => item.title);
}

beforeAll(async () => {
  user = await insertTestUser({ id: USER_ID, is_admin: false });
  otherUser = await insertTestUser({ id: OTHER_USER_ID, is_admin: false });
  await db.insert(organizations).values([
    { id: ORGANIZATION_ID, name: 'To-do organization', created_by_kilo_user_id: USER_ID },
    {
      id: FOREIGN_ORGANIZATION_ID,
      name: 'Foreign to-do organization',
      created_by_kilo_user_id: OTHER_USER_ID,
    },
  ]);
});

beforeEach(async () => {
  const userIds = [USER_ID, OTHER_USER_ID];
  await db.delete(todo_lists).where(inArray(todo_lists.kilo_user_id, userIds));
  await db.delete(cli_sessions_v2).where(inArray(cli_sessions_v2.kilo_user_id, userIds));
  await db
    .delete(organization_memberships)
    .where(inArray(organization_memberships.kilo_user_id, userIds));
  await db.insert(organization_memberships).values([
    { kilo_user_id: USER_ID, organization_id: ORGANIZATION_ID, role: 'member' },
    { kilo_user_id: OTHER_USER_ID, organization_id: FOREIGN_ORGANIZATION_ID, role: 'member' },
  ]);
});

describe('todos ownership', () => {
  it('lists only the caller’s lists in the requested organization context', async () => {
    await callerFor().lists.create({ name: 'Personal' });
    await callerFor().lists.create({ organizationId: ORGANIZATION_ID, name: 'Organization' });
    await callerFor(otherUser).lists.create({ name: 'Someone else' });

    expect(await listNames(callerFor())).toEqual(['Personal']);
    expect(await listNames(callerFor(), ORGANIZATION_ID)).toEqual(['Organization']);
    expect(await listNames(callerFor(otherUser))).toEqual(['Someone else']);
    await expect(
      callerFor().lists.list({ organizationId: FOREIGN_ORGANIZATION_ID })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('returns NOT_FOUND for another user’s lists, to-dos, and sessions', async () => {
    const list = await callerFor().lists.create({ name: 'Mine' });
    const item = await callerFor().items.create({ listId: list.id, title: 'Private' });
    const otherSession = await insertSession({ kilo_user_id: OTHER_USER_ID });
    const intruder = callerFor(otherUser);

    const attempts = [
      () => intruder.lists.update({ id: list.id, name: 'Taken' }),
      () => intruder.lists.move({ id: list.id, beforeId: null, afterId: null }),
      () => intruder.lists.delete({ id: list.id }),
      () => intruder.items.list({ listId: list.id }),
      () => intruder.items.get({ id: item.id }),
      () => intruder.items.create({ listId: list.id, title: 'Injected' }),
      () => intruder.items.update({ id: item.id, done: true }),
      () => intruder.items.move({ id: item.id, beforeId: null, afterId: null }),
      () => intruder.items.delete({ id: item.id }),
      () =>
        intruder.items.linkSession({
          id: item.id,
          sessionId: otherSession.session_id,
          origin: 'linked',
        }),
      () =>
        callerFor().items.linkSession({
          id: item.id,
          sessionId: otherSession.session_id,
          origin: 'linked',
        }),
      () => callerFor().items.candidatesForSession({ sessionId: otherSession.session_id }),
    ];
    for (const attempt of attempts) {
      await expect(attempt()).rejects.toMatchObject({ code: 'NOT_FOUND' });
    }

    expect(await callerFor().items.get({ id: item.id })).toMatchObject({
      title: 'Private',
      doneAt: null,
      sessions: [],
      list: { name: 'Mine', openCount: 1 },
    });
    expect(await readLinks()).toEqual([]);
  });
});

describe('todos ordering', () => {
  it('appends lists and moves them between neighbours', async () => {
    const caller = callerFor();
    const a = await caller.lists.create({ name: 'A' });
    const b = await caller.lists.create({ name: 'B' });
    const c = await caller.lists.create({ name: 'C' });
    expect(await listNames(caller)).toEqual(['A', 'B', 'C']);

    await caller.lists.move({ id: c.id, beforeId: a.id, afterId: b.id });
    expect(await listNames(caller)).toEqual(['A', 'C', 'B']);

    await caller.lists.move({ id: a.id, beforeId: b.id, afterId: null });
    expect(await listNames(caller)).toEqual(['C', 'B', 'A']);

    await caller.lists.move({ id: b.id, beforeId: null, afterId: c.id });
    expect(await listNames(caller)).toEqual(['B', 'C', 'A']);

    await caller.lists.update({ id: c.id, archived: true });
    expect(await listNames(caller)).toEqual(['B', 'A']);
    expect((await caller.lists.list({ includeArchived: true })).map(list => list.name)).toEqual([
      'B',
      'C',
      'A',
    ]);
  });

  it('places a moved row next to the named neighbour when the other side is stale', async () => {
    const caller = callerFor();
    const a = await caller.lists.create({ name: 'A' });
    const b = await caller.lists.create({ name: 'B' });
    const c = await caller.lists.create({ name: 'C' });

    await caller.lists.move({ id: c.id, beforeId: a.id, afterId: null });
    expect(await listNames(caller)).toEqual(['A', 'C', 'B']);

    await caller.lists.move({ id: a.id, beforeId: null, afterId: b.id });
    expect(await listNames(caller)).toEqual(['C', 'A', 'B']);
  });
  it('lands below the named neighbour when a hidden row sits between', async () => {
    const caller = callerFor();
    const list = await caller.lists.create({ name: 'List' });
    const a = await caller.items.create({ listId: list.id, title: 'A' });
    const b = await caller.items.create({ listId: list.id, title: 'B' });
    const c = await caller.items.create({ listId: list.id, title: 'C' });
    const d = await caller.items.create({ listId: list.id, title: 'D' });
    await caller.items.create({ listId: list.id, title: 'E' });
    await caller.items.update({ id: c.id, done: true });
    // Open order is E, D, B, A. Dropping A between the visible D and B
    // names a non-adjacent pair: the done C sits between them server-side.
    await caller.items.move({ id: a.id, beforeId: d.id, afterId: b.id });
    expect(await openTitles(list.id)).toEqual(['E', 'D', 'A', 'B']);
    const positions = await db
      .select({ position: todo_items.position })
      .from(todo_items)
      .where(eq(todo_items.list_id, list.id));
    expect(new Set(positions.map(row => row.position)).size).toEqual(positions.length);
  });

  it('rejects neighbours from another organization context', async () => {
    const caller = callerFor();
    const personal = await caller.lists.create({ name: 'Personal' });
    const organization = await caller.lists.create({
      organizationId: ORGANIZATION_ID,
      name: 'Organization',
    });
    await expect(
      caller.lists.move({ id: personal.id, beforeId: organization.id })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('prepends to-dos, moves them, and lists done to-dos last by completion time', async () => {
    const caller = callerFor();
    const list = await caller.lists.create({ name: 'List' });
    const first = await caller.items.create({ listId: list.id, title: 'First' });
    const second = await caller.items.create({ listId: list.id, title: 'Second' });
    const third = await caller.items.create({ listId: list.id, title: '  Third  ', notes: '  ' });
    expect(third).toMatchObject({ title: 'Third', notes: null });
    expect(await openTitles(list.id)).toEqual(['Third', 'Second', 'First']);

    await caller.items.move({ id: first.id, beforeId: third.id, afterId: second.id });
    expect(await openTitles(list.id)).toEqual(['Third', 'First', 'Second']);

    await caller.items.update({ id: second.id, done: true });
    await caller.items.update({ id: third.id, done: true });
    await db
      .update(todo_items)
      .set({ done_at: '2026-10-01T00:00:00.000Z' })
      .where(eq(todo_items.id, second.id));
    await db
      .update(todo_items)
      .set({ done_at: '2026-10-02T00:00:00.000Z' })
      .where(eq(todo_items.id, third.id));

    expect((await caller.items.list({ listId: list.id })).map(item => item.title)).toEqual([
      'First',
      'Third',
      'Second',
    ]);
    expect((await caller.lists.list({})).map(row => row.openCount)).toEqual([1]);

    await caller.items.update({ id: third.id, done: false });
    expect(await openTitles(list.id)).toEqual(['Third', 'First']);

    const fourth = await caller.items.create({ listId: list.id, title: 'Fourth' });
    await caller.items.move({ id: fourth.id, beforeId: first.id, afterId: null });
    expect(await openTitles(list.id)).toEqual(['Third', 'First', 'Fourth']);
  });

  it('returns up-next to-dos from active lists in list then to-do order', async () => {
    const caller = callerFor();
    const top = await caller.lists.create({ name: 'Top', emoji: '🔥' });
    const archived = await caller.lists.create({ name: 'Archived' });
    const bottom = await caller.lists.create({ name: 'Bottom' });
    await caller.items.create({ listId: top.id, title: 'Top later' });
    await caller.items.create({ listId: top.id, title: 'Top now' });
    await caller.items.create({ listId: archived.id, title: 'Hidden' });
    await caller.items.create({ listId: bottom.id, title: 'Bottom one' });
    await caller.items.create({ listId: bottom.id, title: 'Bottom two' });
    await caller.lists.update({ id: archived.id, archived: true });

    expect(
      (await caller.items.upNext({})).map(item => [item.listName, item.listEmoji, item.title])
    ).toEqual([
      ['Top', '🔥', 'Top now'],
      ['Top', '🔥', 'Top later'],
      ['Bottom', null, 'Bottom two'],
    ]);
    expect((await caller.items.upNext({ limit: 10 })).map(item => item.title)).toHaveLength(4);
  });
});

describe('todos session links', () => {
  it('keeps each session on one to-do and moves the link when relinked', async () => {
    const caller = callerFor();
    const list = await caller.lists.create({ name: 'List' });
    const original = await caller.items.create({ listId: list.id, title: 'Original' });
    const next = await caller.items.create({ listId: list.id, title: 'Next' });
    const session = await insertSession({
      pr_url: 'https://github.com/kilo-org/cloud/pull/1',
      pr_link_verified_at: null,
    });

    const linked = await caller.items.linkSession({
      id: original.id,
      sessionId: session.session_id,
      origin: 'started',
    });
    expect(linked.sessions).toEqual([
      {
        sessionId: session.session_id,
        title: 'Linked session',
        status: null,
        prUrl: null,
        prVerified: false,
        lastActivityAt: null,
        origin: 'started',
        linkedAt: expect.any(String),
      },
    ]);

    const moved = await caller.items.linkSession({
      id: next.id,
      sessionId: session.session_id,
      origin: 'linked',
    });
    expect(moved.sessions).toMatchObject([{ sessionId: session.session_id, origin: 'linked' }]);
    expect((await caller.items.get({ id: original.id })).sessions).toEqual([]);
    expect(await caller.items.forSession({ sessionId: session.session_id })).toEqual({
      id: next.id,
      title: 'Next',
      listId: list.id,
      listName: 'List',
    });

    const repeated = await caller.items.linkSession({
      id: next.id,
      sessionId: session.session_id,
      origin: 'started',
    });
    expect(repeated.sessions).toEqual(moved.sessions);
    expect(await readLinks()).toHaveLength(1);

    await db
      .update(cli_sessions_v2)
      .set({ pr_link_verified_at: '2026-10-01 00:00:00+00' })
      .where(eq(cli_sessions_v2.session_id, session.session_id));
    expect((await caller.items.get({ id: next.id })).sessions).toMatchObject([
      { prUrl: 'https://github.com/kilo-org/cloud/pull/1', prVerified: true },
    ]);

    await caller.items.unlinkSession({ id: next.id, sessionId: session.session_id });
    expect(await caller.items.forSession({ sessionId: session.session_id })).toBeNull();
  });

  it('ranks open to-dos from same-repository lists first', async () => {
    const caller = callerFor();
    const general = await caller.lists.create({ name: 'General' });
    const repo = await caller.lists.create({ name: 'Cloud', gitUrl: 'kilo-org/cloud' });
    const other = await caller.lists.create({ name: 'Other', gitUrl: 'kilo-org/kilocode' });
    await caller.items.create({ listId: general.id, title: 'General task' });
    await caller.items.create({ listId: repo.id, title: 'Cloud task' });
    await caller.items.create({ listId: other.id, title: 'Other task' });
    const done = await caller.items.create({ listId: repo.id, title: 'Done cloud task' });
    await caller.items.update({ id: done.id, done: true });
    const session = await insertSession({ git_url: 'https://github.com/Kilo-Org/cloud.git' });

    const candidates = await caller.items.candidatesForSession({ sessionId: session.session_id });
    expect(
      candidates.map(candidate => [candidate.listName, candidate.title, candidate.sameRepo])
    ).toEqual([
      ['Cloud', 'Cloud task', true],
      ['General', 'General task', false],
      ['Other', 'Other task', false],
    ]);
  });
});

describe('todos deletion', () => {
  it('deletes links but keeps sessions when a to-do or list is deleted', async () => {
    const caller = callerFor();
    const list = await caller.lists.create({ name: 'List' });
    const kept = await caller.items.create({ listId: list.id, title: 'Kept' });
    const removed = await caller.items.create({ listId: list.id, title: 'Removed' });
    const firstSession = await insertSession();
    const secondSession = await insertSession();
    await caller.items.linkSession({
      id: removed.id,
      sessionId: firstSession.session_id,
      origin: 'started',
    });
    await caller.items.linkSession({
      id: kept.id,
      sessionId: secondSession.session_id,
      origin: 'linked',
    });

    await expect(caller.items.delete({ id: removed.id })).resolves.toEqual({ id: removed.id });
    expect((await readLinks()).map(link => link.session_id)).toEqual([secondSession.session_id]);

    await expect(caller.lists.delete({ id: list.id })).resolves.toEqual({ id: list.id });
    expect(await readLinks()).toEqual([]);
    expect(await db.select().from(todo_items).where(eq(todo_items.list_id, list.id))).toEqual([]);
    const sessions = await db
      .select({ sessionId: cli_sessions_v2.session_id })
      .from(cli_sessions_v2)
      .where(
        and(
          eq(cli_sessions_v2.kilo_user_id, USER_ID),
          inArray(cli_sessions_v2.session_id, [firstSession.session_id, secondSession.session_id])
        )
      );
    expect(sessions).toHaveLength(2);
  });

  it('drops the link when its session is deleted', async () => {
    const caller = callerFor();
    const list = await caller.lists.create({ name: 'List' });
    const item = await caller.items.create({ listId: list.id, title: 'Item' });
    const session = await insertSession();
    await caller.items.linkSession({
      id: item.id,
      sessionId: session.session_id,
      origin: 'linked',
    });

    await db.delete(cli_sessions_v2).where(eq(cli_sessions_v2.session_id, session.session_id));

    expect((await caller.items.get({ id: item.id })).sessions).toEqual([]);
    expect(await readLinks()).toEqual([]);
  });
});
