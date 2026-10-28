import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import {
  eventMessage,
  eventually,
  newMessageId,
  object,
  PROVIDER,
  record,
} from './local-kilo-stack.js';
import { type Scenario } from './local-kilo-scenarios.js';

export const turnsScenarios: Scenario[] = [
  {
    name: 'turns.queued',
    sandbox: 'hosted',
    run: async h => {
      const fixture = await h.hosted();
      const ids = [newMessageId(), newMessageId(), newMessageId()];
      const texts = [
        '__fake__:slow:6:700',
        `__fake__:echo:${h.run}-queued-b`,
        `__fake__:echo:${h.run}-queued-c`,
      ];
      for (const [index, id] of ids.entries()) {
        const admitted = await h.prompt(fixture.session, fixture.attachment, texts[index], id);
        assert.equal(admitted.status, 204);
      }
      await h.completion(fixture.session, ids[2]);
      await h.waitIdle(fixture.session, fixture.attachment);
      const history = await h.messages(fixture.session);
      for (const id of ids) {
        assert.equal(
          history.filter(item => item.info.role === 'user' && item.info.id === id).length,
          1,
          `queued prompt ${id} missing or duplicated`
        );
      }
    },
  },
  {
    name: 'turns.abort',
    sandbox: 'hosted',
    run: async h => {
      const fixture = await h.hosted();
      const from = fixture.native.events.length;
      const hanging = newMessageId();
      const started = await h.prompt(
        fixture.session,
        fixture.attachment,
        '__fake__:slow:20:700',
        hanging
      );
      assert.equal(started.status, 204);
      await fixture.native.wait(
        event => event.type === 'session.status' && record(event.properties.status).type === 'busy',
        'busy slow turn',
        from
      );
      await delay(2_000);
      const aborted = await h.tryRequest(
        `/session/${fixture.session.sessionID}/abort?workspace=${encodeURIComponent(fixture.attachment)}`,
        { method: 'POST' }
      );
      assert.equal(aborted.status, 200);
      await h.waitIdle(fixture.session, fixture.attachment);
      const follow = newMessageId();
      const after = await h.prompt(
        fixture.session,
        fixture.attachment,
        `__fake__:echo:${h.run}-after-abort`,
        follow
      );
      assert.equal(after.status, 204);
      await h.completion(fixture.session, follow);
      await h.waitIdle(fixture.session, fixture.attachment);
    },
  },
  {
    name: 'turns.dedupe',
    sandbox: 'hosted',
    run: async h => {
      const fixture = await h.hosted();
      const id = newMessageId();
      const first = await h.prompt(
        fixture.session,
        fixture.attachment,
        `__fake__:echo:${h.run}-dedupe`,
        id
      );
      assert.equal(first.status, 204);
      const second = await h.prompt(
        fixture.session,
        fixture.attachment,
        `__fake__:echo:${h.run}-dedupe`,
        id
      );
      assert(second.status < 500, `duplicate prompt rejected unusually: HTTP ${second.status}`);
      await h.waitIdle(fixture.session, fixture.attachment);
      const history = await eventually('deduplicated user message persisted', async () => {
        const items = await h.messages(fixture.session);
        return items.some(item => item.info.id === id) ? items : undefined;
      });
      const users = history.filter(item => item.info.id === id);
      assert.equal(users.length, 1, `duplicate messageID produced ${users.length} user messages`);
    },
  },
  {
    name: 'turns.provider-error',
    sandbox: 'hosted',
    run: async h => {
      const fixture = await h.hosted();
      const from = fixture.native.events.length;
      const failed = newMessageId();
      const started = await h.prompt(
        fixture.session,
        fixture.attachment,
        '__fake__:error-terminal:e8-boom',
        failed
      );
      assert.equal(started.status, 204);
      await h.waitIdle(fixture.session, fixture.attachment);
      const surfaced =
        fixture.native.events
          .slice(from)
          .some(
            event =>
              event.type === 'session.error' ||
              (event.type === 'message.updated' && eventMessage(event).error !== undefined)
          ) ||
        (await h.messages(fixture.session)).some(
          item =>
            item.info.id === failed &&
            (item.info.error !== undefined ||
              item.parts.some(part => record(part).state !== undefined))
        );
      assert(surfaced, 'provider error turn did not surface an error');
      const recovered = newMessageId();
      const after = await h.prompt(
        fixture.session,
        fixture.attachment,
        `__fake__:echo:${h.run}-recovered`,
        recovered
      );
      assert.equal(after.status, 204);
      await h.completion(fixture.session, recovered);
      await h.waitIdle(fixture.session, fixture.attachment);
    },
  },
  {
    name: 'turns.command',
    sandbox: 'hosted',
    run: async h => {
      const fixture = await h.hosted();
      const messageID = newMessageId();
      const command = await h.tryRequest(
        `/session/${fixture.session.sessionID}/command?workspace=${encodeURIComponent(fixture.attachment)}`,
        { method: 'POST', body: { messageID, command: 'init', arguments: '' } }
      );
      assert.equal(
        command.status,
        204,
        `slash command was not accepted: HTTP ${command.status} ${command.text.slice(0, 200)}`
      );
      await h.waitIdle(fixture.session, fixture.attachment);
    },
  },
  {
    name: 'turns.pagination',
    sandbox: 'hosted',
    run: async h => {
      const fixture = await h.hosted();
      const native = `/session/${fixture.session.sessionID}/message?workspace=${encodeURIComponent(fixture.attachment)}`;
      const first = await h.tryRequest(`${native}&limit=2`);
      assert.equal(first.status, 200);
      const page1 = z.array(object).parse(first.value);
      assert.equal(page1.length, 2);
      const cursor = first.headers.get('x-next-cursor');
      assert(cursor, 'native transcript page omitted X-Next-Cursor');
      const second = await h.tryRequest(`${native}&limit=2&before=${encodeURIComponent(cursor)}`);
      assert.equal(second.status, 200);
      const page2 = z.array(object).parse(second.value);
      assert(page2.length > 0);
      const ids = (page: Record<string, unknown>[]) =>
        page.map(item => String(record(item.info).id));
      const firstIDs = ids(page1);
      assert(!ids(page2).some(id => firstIDs.includes(id)), 'native transcript pages overlap');
      const bad = await h.tryRequest(`${native}&limit=2&before=garbage`);
      assert.equal(bad.status, 400);

      const hostedRoute = `${h.host}/session/${PROVIDER}/${fixture.session.sessionID}/message?limit=2`;
      const hosted = await h.tryRequest(hostedRoute);
      assert.equal(hosted.status, 200);
      const hostedPage = record(hosted.value);
      assert(Array.isArray(hostedPage.items));
      assert(typeof hostedPage.cursor === 'string', 'hosted transcript page omitted its cursor');
      const hostedNext = await h.tryRequest(
        `${hostedRoute}&before=${encodeURIComponent(String(hostedPage.cursor))}`
      );
      assert.equal(hostedNext.status, 200);
      assert(Array.isArray(record(hostedNext.value).items));
    },
  },
];
