import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { HOST, newMessageId } from './local-kilo-stack.js';
import type { Scenario } from './local-kilo-scenarios.js';

export const authScenarios: Scenario[] = [
  {
    name: 'auth.signed-out-401',
    sandbox: 'none',
    run: async h => {
      const kilo = await h.startKilo({ home: path.join(h.out, 'home-signed-out') });
      const response = await h.requestOn(kilo, `${HOST}/session`, {
        method: 'POST',
        body: {
          repository: { type: 'git', url: h.config.gitUrl },
          prompt: 'should not start',
          agent: { mode: 'code', model: h.config.model },
          messageID: newMessageId(),
          operationKey: randomUUID(),
        },
      });
      assert.equal(
        response.status,
        401,
        `signed-out hosted start returned HTTP ${response.status}: ${response.text.slice(0, 200)}`
      );
    },
  },
  {
    name: 'auth.no-balance-402',
    sandbox: 'none',
    run: async h => {
      const user = await h.ensureNoBalanceUser();
      const token = await h.signToken(user);
      const kilo = await h.startKilo({ home: path.join(h.out, 'home-no-balance'), token });
      const response = await h.requestOn(kilo, `${HOST}/session`, {
        method: 'POST',
        body: {
          repository: { type: 'git', url: h.config.gitUrl },
          prompt: 'should not start',
          agent: { mode: 'code', model: h.config.model },
          messageID: newMessageId(),
          operationKey: randomUUID(),
        },
      });
      assert.equal(
        response.status,
        402,
        `no-balance hosted start returned HTTP ${response.status}: ${response.text.slice(0, 200)}`
      );
    },
  },
];
