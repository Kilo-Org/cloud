import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { newMessageId, record } from './local-kilo-stack.js';
import type { Scenario } from './local-kilo-scenarios.js';

const REAL_MODEL = 'kilo-auto/efficient';

export const optInScenarios: Scenario[] = [
  {
    name: 'real-model',
    optIn: true,
    sandbox: 'hosted',
    run: async h => {
      const start = await h.startHosted(
        'Reply with exactly real-cold-ok. Do not use tools or edit files.',
        { agent: { mode: 'code', model: REAL_MODEL } }
      );
      assert.equal(start.result.status, 200, `real-model start failed: HTTP ${start.result.status}`);
      const session = record(record(start.result.value).session);
      const providerID = String(session.providerID);
      const sessionID = String(session.sessionID);
      h.ownSession({ providerID, sessionID });
      const attachment = await h.attach({ providerID, sessionID });
      const native = await h.feed('/event', attachment);
      await native.wait(
        event =>
          event.type === 'message.updated' &&
          record(event.properties.info).role === 'assistant' &&
          typeof record(record(event.properties.info).time).completed === 'number',
        'real-model assistant completion'
      );
      await h.waitIdle({ providerID, sessionID }, attachment);

      const followUp = newMessageId();
      const prompt = await h.prompt(
        { providerID, sessionID },
        attachment,
        'List the files in the repository root using a tool, then reply with the count only.',
        followUp,
        REAL_MODEL
      );
      assert.equal(prompt.status, 204, `real-model follow-up prompt failed: HTTP ${prompt.status}`);
      await native.wait(
        event =>
          event.type === 'message.part.updated' && record(event.properties.part).type === 'tool',
        'real-model tool call'
      );
      await h.waitIdle({ providerID, sessionID }, attachment);
      const history = await h.messages({ providerID, sessionID });
      const tools = history.flatMap(item =>
        item.parts.filter(part => record(part).type === 'tool').map(part => record(part))
      );
      assert(
        tools.some(part => record(part.state).status === 'completed'),
        'real-model tool follow-up produced no completed tool part'
      );
    },
  },
  {
    name: 'idle-stream',
    optIn: true,
    sandbox: 'workspace',
    run: async h => {
      const fixture = await h.workspaceSession('idle', `${h.run}-idle`);
      const attachment = await h.attach(fixture.session);
      const stream = await h.feed('/event', attachment);
      await stream.wait(event => event.type === 'kilo.native.fence', 'idle native fence');
      const from = stream.events.length;
      await delay(30_000);
      const resnapshots = stream.events.slice(from).filter(event => event.type === 'kilo.native.resnapshot');
      assert.equal(
        resnapshots.length,
        0,
        `idle session received ${resnapshots.length} kilo.native.resnapshot event(s)`
      );
      assert.equal(stream.error(), undefined, 'idle session feed closed unexpectedly');
    },
  },
];
