import assert from 'node:assert/strict';
import { z } from 'zod';
import { identity, object, record, sessionStarted } from './local-kilo-stack.js';
import type { Scenario } from './local-kilo-scenarios.js';

export const hostedScenarios: Scenario[] = [
  {
    name: 'hosted.start',
    sandbox: 'hosted',
    run: async h => {
      const fixture = await h.hosted();
      const start = sessionStarted.parse(fixture.start.value);
      assert.equal(start.messageID, fixture.messageID);
      assert.equal(start.replayed, false);
      assert.equal(start.session.providerID, 'kilo-cloud');
      assert.deepEqual(start.session, fixture.session);

      assert.equal(
        fixture.immediateAttach.status,
        200,
        `attach during pending snapshot was rejected: HTTP ${fixture.immediateAttach.status} ${fixture.immediateAttach.text.slice(0, 200)}`
      );
      const attached = z
        .object({ attachmentID: z.string().startsWith('wrk_att_'), session: identity })
        .parse(fixture.immediateAttach.value);
      assert.deepEqual(attached.session, fixture.session);

      assert.equal(fixture.listedAtStart.status, 200);
      const listed = z.array(object).parse(record(fixture.listedAtStart.value).items);
      assert(
        listed.some(item => identity.parse(record(item).id).sessionID === fixture.session.sessionID),
        'new hosted session missing from the hosted list'
      );

      const replay = await h.startHosted(fixture.prompt, {
        messageID: fixture.messageID,
        operationKey: fixture.operationKey,
      });
      assert.equal(replay.result.status, 200);
      const replayed = sessionStarted.parse(replay.result.value);
      assert.equal(replayed.session.sessionID, fixture.session.sessionID);
      assert.equal(replayed.messageID, fixture.messageID);
      assert.equal(replayed.replayed, true);

      const changed = await h.startHosted(`${fixture.prompt}-changed`, {
        messageID: fixture.messageID,
        operationKey: fixture.operationKey,
      });
      assert(
        changed.result.status >= 400,
        `changed intent accepted with the same operation key: HTTP ${changed.result.status}`
      );

      assert(
        fixture.system.events.some(event => event.type === 'cloud.status'),
        'system feed carried no cloud.status during start'
      );
    },
  },
];
