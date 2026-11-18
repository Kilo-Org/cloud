import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startFakeLlmServer, type FakeLlmServerHandle } from '../../e2e/fake-llm-server.js';

describe('supervision fake request boundaries', () => {
  let server: FakeLlmServerHandle;
  beforeEach(async () => {
    server = await startFakeLlmServer({ host: '127.0.0.1' });
  });
  afterEach(async () => server.close());

  const post = (messages: unknown[], signal?: AbortSignal) =>
    fetch(`${server.url}/api/openrouter/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'fake-deterministic',
        messages,
        tools: ['bash', 'goal_report'].map(name => ({
          type: 'function',
          function: { name, parameters: { type: 'object', properties: {} } },
        })),
      }),
      signal,
    });

  it.each(['tag:silent:541', 'tag:stuck:1801', 'tag:progress:0', 'tag;echo:progress:1'])(
    'rejects invalid or unbounded directive %s',
    async args => {
      const response = await post([{ role: 'user', content: `__fake__:supervision:${args}` }]);
      expect(response.status).toBe(400);
      expect(await (await server.adminFetch('/test/waiters')).json()).toEqual({
        tags: [],
        liveResponses: 0,
      });
    }
  );

  it('does not mistake the initial goal instruction for autonomous continuation', async () => {
    const response = await post([
      {
        role: 'user',
        content: 'Continue working toward this session goal:\n__fake__:supervision:tag:progress:1',
      },
    ]);
    const body = await response.text();
    expect(body).toContain('supervision_tag_bootstrap');
    expect(body).toContain('bash');
    expect(body).not.toContain('goal_report');
  });

  it('releases a stalled continuation and its timer when the model request is aborted', async () => {
    const controller = new AbortController();
    const response = await post(
      [
        { role: 'assistant', content: 'supervision-bootstrap-tag' },
        { role: 'user', content: '__fake__:supervision:tag:stuck:1800' },
      ],
      controller.signal
    );
    const reading = response.text().catch(() => undefined);
    try {
      expect((await (await server.adminFetch('/test/waiters')).json()).liveResponses).toBe(1);
      controller.abort();
      await reading;
      await expect
        .poll(async () => (await (await server.adminFetch('/test/waiters')).json()).liveResponses)
        .toBe(0);
    } finally {
      controller.abort();
    }
  });
});
