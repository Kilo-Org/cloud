import assert from 'node:assert/strict';
import { newMessageId, record } from './local-kilo-stack.js';
import type { Scenario } from './local-kilo-scenarios.js';

const questionId = (value: unknown) => {
  const id = record(value).id;
  assert(typeof id === 'string', 'question event carried no id');
  return id;
};

export const questionsScenarios: Scenario[] = [
  {
    name: 'questions.reply',
    sandbox: 'workspace',
    run: async h => {
      const fixture = await h.workspaceSession('sibling', `${h.run}-sibling`);
      const from = fixture.native.events.length;
      const tag = `q${Date.now()}`;
      const asked = await h.tryRequest(
        `/session/${fixture.session.sessionID}/prompt_async?workspace=${encodeURIComponent(fixture.attachment)}`,
        {
          method: 'POST',
          body: {
            messageID: newMessageId(),
            agent: 'code',
            model: { providerID: 'kilo', modelID: h.model },
            parts: [{ type: 'text', text: `__fake__:question:${tag}:Pick a color?` }],
          },
        }
      );
      assert.equal(asked.status, 204);
      const event = await fixture.native.wait(
        item => item.type === 'question.asked',
        'question.asked',
        from
      );
      const id = questionId(event.properties);
      const listed = await h.tryRequest(
        `/question?workspace=${encodeURIComponent(fixture.attachment)}`
      );
      assert.equal(listed.status, 200);
      assert(
        Array.isArray(listed.value) && listed.value.some(item => record(item).id === id),
        'pending question missing from GET /question'
      );
      const reply = await h.tryRequest(
        `/question/${id}/reply?workspace=${encodeURIComponent(fixture.attachment)}`,
        { method: 'POST', body: { answers: [['Blue']] } }
      );
      assert.equal(reply.status, 200, `question reply rejected: HTTP ${reply.status}`);
      await fixture.native.wait(item => item.type === 'question.replied', 'question.replied', from);
      await h.waitIdle(fixture.session, fixture.attachment);
      const after = await h.tryRequest(
        `/question?workspace=${encodeURIComponent(fixture.attachment)}`
      );
      assert.equal(after.status, 200);
      assert(
        Array.isArray(after.value) && after.value.length === 0,
        'answered question stayed pending'
      );
    },
  },
  {
    name: 'questions.reject-bodyless',
    sandbox: 'workspace',
    run: async h => {
      const fixture = await h.workspaceSession('sibling', `${h.run}-sibling`);
      const from = fixture.native.events.length;
      const tag = `qr${Date.now()}`;
      const asked = await h.tryRequest(
        `/session/${fixture.session.sessionID}/prompt_async?workspace=${encodeURIComponent(fixture.attachment)}`,
        {
          method: 'POST',
          body: {
            messageID: newMessageId(),
            agent: 'code',
            model: { providerID: 'kilo', modelID: h.model },
            parts: [{ type: 'text', text: `__fake__:question:${tag}:Proceed?` }],
          },
        }
      );
      assert.equal(asked.status, 204);
      const event = await fixture.native.wait(
        item => item.type === 'question.asked',
        'question.asked',
        from
      );
      const id = questionId(event.properties);
      // Regression for 6b660026ca: a bodyless rejection must be accepted.
      const rejected = await h.tryRequest(
        `/question/${id}/reject?workspace=${encodeURIComponent(fixture.attachment)}`,
        { method: 'POST' }
      );
      assert.equal(
        rejected.status,
        200,
        `bodyless question reject failed: HTTP ${rejected.status}`
      );
      await fixture.native.wait(
        item => item.type === 'question.rejected',
        'question.rejected',
        from
      );
      await h.waitIdle(fixture.session, fixture.attachment);
    },
  },
  {
    name: 'questions.pending-reattach',
    sandbox: 'workspace',
    run: async h => {
      const fixture = await h.workspaceSession('sibling', `${h.run}-sibling`);
      const from = fixture.native.events.length;
      const tag = `wa${Date.now()}`;
      const asked = await h.tryRequest(
        `/session/${fixture.session.sessionID}/prompt_async?workspace=${encodeURIComponent(fixture.attachment)}`,
        {
          method: 'POST',
          body: {
            messageID: newMessageId(),
            agent: 'code',
            model: { providerID: 'kilo', modelID: h.model },
            parts: [{ type: 'text', text: `__fake__:question:${tag}:Still there?` }],
          },
        }
      );
      assert.equal(asked.status, 204);
      const event = await fixture.native.wait(
        item => item.type === 'question.asked',
        'question.asked',
        from
      );
      const id = questionId(event.properties);
      const attachment = await h.attach(fixture.session);
      const reattached = await h.feed('/event', attachment);
      await reattached.wait(item => item.type === 'kilo.native.fence', 'reattached native fence');
      const snapshot = reattached.events.some(
        item => item.type === 'question.asked' && record(item.properties).id === id
      );
      assert(snapshot, 'pending question missing from the reattached native snapshot');
      const listed = await h.tryRequest(`/question?workspace=${encodeURIComponent(attachment)}`);
      assert.equal(listed.status, 200);
      assert(
        Array.isArray(listed.value) && listed.value.some(item => record(item).id === id),
        'pending question missing from GET /question after reattach'
      );
      const reply = await h.tryRequest(
        `/question/${id}/reply?workspace=${encodeURIComponent(attachment)}`,
        { method: 'POST', body: { answers: [['Yes']] } }
      );
      assert.equal(
        reply.status,
        200,
        `question reply after reattach rejected: HTTP ${reply.status}`
      );
      await h.waitIdle(fixture.session, fixture.attachment);
    },
  },
];
