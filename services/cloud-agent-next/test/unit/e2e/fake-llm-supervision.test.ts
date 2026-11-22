import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startFakeLlmServer, type FakeLlmServerHandle } from '../../e2e/fake-llm-server.js';

describe('bash directive fake scenario', () => {
  let server: FakeLlmServerHandle;
  beforeEach(async () => {
    server = await startFakeLlmServer({ host: '127.0.0.1' });
  });
  afterEach(async () => server.close());

  const tools = (names: string[]) =>
    names.map(name => ({
      type: 'function',
      function: { name, parameters: { type: 'object', properties: {} } },
    }));

  const post = (messages: unknown[], names = ['bash']) =>
    fetch(`${server.url}/api/openrouter/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'fake-deterministic', messages, tools: tools(names) }),
    });

  it('emits one bash tool call with the exact command, colons and plus signs included', async () => {
    const command = 'git push origin +main && printf "a:b"';
    const response = await post([{ role: 'user', content: `__fake__:bash:probe1:${command}` }]);
    expect(response.status).toBe(200);
    const body = await response.text();
    const calls = body
      .split('\n')
      .filter(line => line.startsWith('data: ') && line !== 'data: [DONE]')
      .map(line => JSON.parse(line.slice('data: '.length)))
      .flatMap(chunk => chunk.choices?.[0]?.delta?.tool_calls ?? []);
    expect(calls).toHaveLength(1);
    expect(calls[0].id).toBe('bash_probe1');
    expect(JSON.parse(calls[0].function.arguments)).toEqual({
      command,
      description: 'Fixture bash command',
    });
    expect(body).toContain('"finish_reason":"tool_calls"');
  });

  it('reports the tool result verbatim and no tool call once the result is present', async () => {
    const refusal = 'Permission denied: git push --force';
    const response = await post([
      { role: 'user', content: '__fake__:bash:probe2:git push --force origin main' },
      { role: 'assistant', content: '' },
      { role: 'tool', tool_call_id: 'bash_probe2', content: refusal },
    ]);
    const body = await response.text();
    const chunks = body
      .split('\n')
      .filter(line => line.startsWith('data: ') && line !== 'data: [DONE]')
      .map(line => JSON.parse(line.slice('data: '.length)));
    const content = chunks.flatMap(chunk => chunk.choices?.[0]?.delta?.content ?? []).join('');
    expect(content.startsWith('bash-result-probe2\n')).toBe(true);
    expect(content).toContain(refusal);
    expect(body).not.toContain('tool_calls');
    expect(body).toContain('"finish_reason":"stop"');
  });

  it.each(['probe3:', 'probe3'])('rejects a missing command: %s', async args => {
    const response = await post([{ role: 'user', content: `__fake__:bash:${args}` }]);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'expected bash:<tag>:<command>' });
  });

  it('refuses when the bash tool is not advertised', async () => {
    const response = await post(
      [{ role: 'user', content: '__fake__:bash:probe4:printf hi' }],
      ['goal_report']
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: 'bash fixture requires native bash' });
  });
});

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
