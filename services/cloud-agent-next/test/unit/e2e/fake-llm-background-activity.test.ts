import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startFakeLlmServer, type FakeLlmServerHandle } from '../../e2e/fake-llm-server.js';

describe('background activity fake inference', () => {
  let server: FakeLlmServerHandle;
  beforeEach(async () => {
    server = await startFakeLlmServer({ host: '127.0.0.1' });
  });
  afterEach(async () => server.close());
  const post = (messages: unknown[], names = ['shell', 'subagent']) =>
    fetch(`${server.url}/api/openrouter/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'fake-deterministic',
        messages,
        tools: names.map(name => ({
          type: 'function',
          function: { name, parameters: { type: 'object', properties: {} } },
        })),
      }),
    });

  it('launches one bounded shell with exit 7 and one gated subagent', async () => {
    const response = await post([{ role: 'user', content: '__fake__:background-activity:local' }]);
    const output = await response.text();
    expect(response.status).toBe(200);
    const data = JSON.parse(
      output
        .split('\n')
        .find(line => line.startsWith('data: {'))!
        .slice(6)
    );
    const calls = data.choices[0].delta.tool_calls;
    expect(calls.map((call: { function: { name: string } }) => call.function.name)).toEqual([
      'shell',
      'subagent',
    ]);
    expect(JSON.parse(calls[0].function.arguments)).toMatchObject({
      background: true,
      description: 'Run background checks',
      command: expect.stringContaining('exit 7'),
    });
    expect(JSON.parse(calls[1].function.arguments)).toMatchObject({
      background: true,
      prompt: '__fake__:gate:activity-child-local:waiting',
    });
  });
  it('does not relaunch jobs after the shell launch result', async () => {
    const response = await post([
      { role: 'user', content: '__fake__:background-activity:local' },
      { role: 'tool', tool_call_id: 'activity_local_shell', content: 'Background job started' },
    ]);
    const output = await response.text();
    expect(output).toContain('Background work continues.');
    expect(output).not.toContain('tool_calls');
  });
  it('rejects unsafe tags and missing native tools', async () => {
    expect(
      (await post([{ role: 'user', content: '__fake__:background-activity:tag;command' }])).status
    ).toBe(400);
    expect(
      (await post([{ role: 'user', content: '__fake__:background-activity:local' }], ['bash']))
        .status
    ).toBe(422);
  });
});
