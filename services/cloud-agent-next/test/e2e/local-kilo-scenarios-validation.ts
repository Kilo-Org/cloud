import assert from 'node:assert/strict';
import { HOST, newMessageId, record } from './local-kilo-stack.js';
import type { Scenario } from './local-kilo-scenarios.js';

const UNKNOWN_ATTACHMENT = 'wrk_att_00000000000000000000000000';
const UNKNOWN_SESSION = 'ses_00000000000000000000000000';

export const validationScenarios: Scenario[] = [
  {
    name: 'validation.selectors',
    sandbox: 'workspace',
    run: async h => {
      const fixture = await h.workspaceSession('sibling', `${h.run}-sibling`);
      const stale = await h.attach(fixture.session);
      const detached = await h.tryRequest(`${HOST}/attachment/${stale}`, { method: 'DELETE' });
      assert.equal(detached.status, 200, `attachment detach failed: HTTP ${detached.status}`);

      const afterDetach = await h.tryRequest(
        `/session/${fixture.session.sessionID}?workspace=${encodeURIComponent(stale)}`
      );
      assert(afterDetach.status >= 400, `detached selector accepted: HTTP ${afterDetach.status}`);

      const unknown = await h.tryRequest(
        `/session/${fixture.session.sessionID}?workspace=${UNKNOWN_ATTACHMENT}`
      );
      assert(unknown.status >= 400, `unknown selector accepted: HTTP ${unknown.status}`);

      const mismatch = await h.tryRequest(
        `/session/${UNKNOWN_SESSION}?workspace=${encodeURIComponent(fixture.attachment)}`
      );
      assert(mismatch.status >= 400, `mismatched selector accepted: HTTP ${mismatch.status}`);

      const header = await h.tryRequest(`/session/${fixture.session.sessionID}`, {
        headers: { 'x-kilo-workspace': fixture.attachment },
      });
      assert.equal(header.status, 200, `x-kilo-workspace selector rejected: HTTP ${header.status}`);
    },
  },
  {
    name: 'validation.oversized-prompt',
    sandbox: 'workspace',
    run: async h => {
      const fixture = await h.workspaceSession('sibling', `${h.run}-sibling`);
      const response = await h.prompt(
        fixture.session,
        fixture.attachment,
        'x'.repeat(300 * 1024),
        newMessageId()
      );
      assert(
        response.status === 400 || response.status === 413,
        `oversized prompt returned HTTP ${response.status}`
      );
      const readable = await h.tryRequest(
        `/session/${fixture.session.sessionID}?workspace=${encodeURIComponent(fixture.attachment)}`
      );
      assert.equal(readable.status, 200, `session unreadable after oversized prompt`);
    },
  },
  {
    name: 'validation.invalid-bodies',
    sandbox: 'workspace',
    run: async h => {
      const fixture = await h.workspaceSession('sibling', `${h.run}-sibling`);
      const route = `/session/${fixture.session.sessionID}/prompt_async?workspace=${encodeURIComponent(fixture.attachment)}`;
      const cases: Array<{ name: string; body: unknown }> = [
        { name: 'no parts', body: { messageID: newMessageId(), parts: [] } },
        { name: 'invalid json', body: '{not json' },
        { name: 'bad messageID', body: { messageID: 'msg_1', parts: [{ type: 'text', text: 'hi' }] } },
        {
          name: 'unknown model',
          body: {
            messageID: newMessageId(),
            model: { providerID: 'kilo', modelID: 'no-such-model-xyz' },
            parts: [{ type: 'text', text: 'hi' }],
          },
        },
        {
          name: 'non-kilo provider',
          body: {
            messageID: newMessageId(),
            model: { providerID: 'anthropic', modelID: 'claude' },
            parts: [{ type: 'text', text: 'hi' }],
          },
        },
      ];
      for (const item of cases) {
        const response = await h.tryRequest(route, { method: 'POST', body: item.body });
        assert(
          response.status >= 400 && response.status < 500,
          `${item.name} returned HTTP ${response.status}: ${response.text.slice(0, 200)}`
        );
      }
      const readable = await h.tryRequest(
        `/session/${fixture.session.sessionID}?workspace=${encodeURIComponent(fixture.attachment)}`
      );
      assert.equal(readable.status, 200, 'session unreadable after invalid prompt bodies');
      assert.equal(record(readable.value).id, fixture.session.sessionID);
    },
  },
];
