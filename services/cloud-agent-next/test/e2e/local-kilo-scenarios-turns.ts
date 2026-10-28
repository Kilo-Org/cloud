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
    name: 'turns.fifo',
    sandbox: 'hosted',
    run: async h => {
      const fixture = await h.hosted();
      const first = { id: newMessageId(), text: '__fake__:slow:6:700' };
      const second = { id: newMessageId(), text: '__fake__:slow:6:700' };
      const third = {
        id: newMessageId(),
        text: `__fake__:echo:${h.run}-fifo-c`,
        expected: `${h.run}-fifo-c`,
      };
      const turns: Array<{ id: string; text: string; expected?: string }> = [first, second, third];
      const a = await h.prompt(fixture.session, fixture.attachment, first.text, first.id);
      assert.equal(a.status, 204);
      await delay(400);
      const b = await h.prompt(fixture.session, fixture.attachment, second.text, second.id);
      assert.equal(b.status, 204);
      // One prompt is queued at a time: wait for the first turn to finish, then
      // queue the third while the second is still running.
      await eventually('first queued turn complete', async () => {
        const items = await h.messages(fixture.session);
        const reply = items.find(
          item => item.info.role === 'assistant' && item.info.parentID === first.id
        );
        return reply && typeof record(reply.info.time).completed === 'number' ? reply : undefined;
      });
      await delay(300);
      const c = await h.prompt(fixture.session, fixture.attachment, third.text, third.id);
      assert.equal(c.status, 204);
      await h.completion(fixture.session, third.id, third.expected);
      await h.waitIdle(fixture.session, fixture.attachment);
      const history = await eventually('all queued turns persisted', async () => {
        const items = await h.messages(fixture.session);
        const complete = turns.every(
          turn =>
            items.some(item => item.info.role === 'user' && item.info.id === turn.id) &&
            items.filter(
              item =>
                item.info.role === 'assistant' &&
                item.info.parentID === turn.id &&
                typeof record(item.info.time).completed === 'number'
            ).length === 1
        );
        return complete ? items : undefined;
      });
      let previous = -Infinity;
      for (const turn of turns) {
        const reply = history.find(
          item => item.info.role === 'assistant' && item.info.parentID === turn.id
        );
        assert(reply, `no assistant reply for queued turn ${turn.id}`);
        if (turn.expected !== undefined) {
          const text = reply.parts
            .filter(part => part.type === 'text')
            .map(part => part.text)
            .join('');
          assert(
            text.includes(turn.expected),
            `queued turn ${turn.expected} reply text: ${text.slice(0, 80)}`
          );
        }
        const completed = Number(record(reply.info.time).completed);
        assert(
          completed >= previous,
          `queued replies finished out of order at ${turn.id}: ${completed} < ${previous}`
        );
        previous = completed;
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
      await h.completion(fixture.session, follow, `${h.run}-after-abort`);
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
      assert.equal(
        users.length,
        1,
        `duplicate messageID produced ${users.length} user messages`
      );
      assert.equal(
        history.filter(item => item.info.role === 'assistant' && item.info.parentID === id).length,
        1,
        'duplicate messageID produced more than one assistant reply'
      );
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
            (item.info.error !== undefined || item.parts.some(part => record(part).state !== undefined))
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
      await h.completion(fixture.session, recovered, `${h.run}-recovered`);
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
      const ids = (page: Record<string, unknown>[]) => page.map(item => String(record(item.info).id));
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
