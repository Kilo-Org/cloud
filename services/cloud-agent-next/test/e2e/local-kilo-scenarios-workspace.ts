import assert from 'node:assert/strict';
import { eventMessage, newMessageId, record } from './local-kilo-stack.js';
import { validateSystem, type Scenario } from './local-kilo-scenarios.js';

export const workspaceScenarios: Scenario[] = [
  {
    name: 'workspace.create',
    sandbox: 'workspace',
    run: async h => {
      const fixture = await h.workspace();
      assert(Array.isArray(fixture.listItems), 'workspace list did not return items');
      assert.equal(fixture.createdRaw.status, 200);
      assert.equal(fixture.created.messageID, fixture.messageID);
      assert.equal(fixture.created.replayed, false);
      assert.equal(fixture.replayRaw.status, 200);
      assert.deepEqual(fixture.replay.workspace, fixture.created.workspace);
      assert.deepEqual(fixture.replay.session, fixture.created.session);
      assert.equal(fixture.replay.replayed, true);
      assert(
        fixture.listed?.sessions.some(
          item => item.id.sessionID === fixture.created.session.sessionID
        ),
        'created session missing from workspace catalog'
      );
      assert.deepEqual(fixture.detail.id, fixture.created.workspace);
    },
  },
  {
    name: 'workspace.system-feed',
    sandbox: 'workspace',
    run: async h => {
      const fixture = await h.workspace();
      validateSystem(fixture.system, fixture.session.sessionID);
      assert(fixture.system.events.some(event => event.type === 'preparing'));
      assert(
        fixture.system.events.some(
          event =>
            event.type === 'cloud.sandbox.status' &&
            record(event.properties.sandbox).status === 'active'
        ),
        'system feed did not report an active sandbox'
      );
      assert(
        fixture.system.events.some(
          event =>
            event.type === 'cloud.status' && record(event.properties.cloudStatus).type === 'ready'
        ),
        'system feed did not report a ready cloud lifecycle'
      );
    },
  },
  {
    name: 'workspace.native-feed',
    sandbox: 'workspace',
    run: async h => {
      const fixture = await h.workspace();
      const native = await h.feed('/event', fixture.attachment);
      await native.wait(event => event.type === 'kilo.native.fence', 'native snapshot fence');
      const boundary = native.events.findIndex(event => event.type === 'kilo.native.fence');
      assert(
        native.events.slice(0, boundary).some(event => event.type === 'session.updated'),
        'native snapshot did not precede its fence'
      );
      const fence = native.events.length;
      await h.releaseGate(fixture.gate);
      await h.completion(fixture.session, fixture.messageID);
      await native.wait(
        event => event.type === 'message.updated' && eventMessage(event).role === 'assistant',
        'live initial assistant event',
        fence
      );
      assert.equal(native.error(), undefined);
    },
  },
  {
    name: 'workspace.sibling',
    sandbox: 'workspace',
    run: async h => {
      const sibling = await h.workspaceSession('sibling', `${h.run}-sibling`);
      assert.equal(sibling.session.providerID, 'kilo-cloud');
      assert(sibling.messageID.length > 0);
    },
  },
  {
    name: 'workspace.follow-ups',
    sandbox: 'workspace',
    run: async h => {
      const fixture = await h.workspace();
      const sibling = await h.workspaceSession('sibling', `${h.run}-sibling`);
      const native = sibling.native;
      const system = await h.feed('/cloud-agent/event', sibling.attachment);
      const turns = [sibling.messageID];
      for (let index = 1; index <= 2; index++) {
        const id = newMessageId();
        turns.push(id);
        const start = native.events.length;
        const admitted = await h.prompt(
          sibling.session,
          sibling.attachment,
          `__fake__:echo:${h.run}-followup-${index}`,
          id
        );
        assert.equal(admitted.status, 204);
        await h.completion(sibling.session, id);
        await native.wait(
          event => event.type === 'message.updated' && eventMessage(event).role === 'assistant',
          'live follow-up assistant event',
          start
        );
      }
      await system.wait(
        event =>
          event.type === 'cloud.sandbox.status' &&
          record(event.properties.sandbox).status === 'active',
        'sibling sandbox snapshot'
      );
      validateSystem(fixture.system, fixture.session.sessionID);
      validateSystem(system, sibling.session.sessionID);
      const history = await h.messages(sibling.session);
      for (const id of turns) {
        assert.equal(
          history.filter(item => item.info.role === 'user' && item.info.id === id).length,
          1,
          'accepted prompt missing or duplicated'
        );
      }
    },
  },
];
