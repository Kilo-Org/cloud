import { expect, it } from 'vitest';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { RunLimitsSchema } from '../commands';
import { executeMcp } from './mcp';
import { mcpTestFixture } from './mcp-test-fixture';
import { toolDefinitions } from '@kilocode/agent-harness/tools';
import { ToolCallSchema } from '@kilocode/agent-harness/contracts';
import { evaluateDispatch } from '@kilocode/agent-harness/policy';

it('requires Ask approval despite a discovered read-only hint', async () => {
  const request = await fixture().call();
  const definition = toolDefinitions.find(tool => tool.name === request.name);
  const call = ToolCallSchema.parse({
    id: crypto.randomUUID(),
    runId: crypto.randomUUID(),
    name: request.name,
    definitionVersion: definition?.version,
    arguments: request.arguments,
    context: { type: 'personal' },
    effect: definition?.effect,
    executionTarget: { kind: 'backend' },
    approval: null,
    state: 'pending',
    result: null,
  });
  expect(
    evaluateDispatch(call, call, {
      permissionMode: 'ask',
      permissionRevision: 0,
      expectedPermissionRevision: 0,
      authorized: true,
      available: true,
      clientReady: true,
      questionAnswered: true,
      trustedRead: true,
    })
  ).toBe('approval');
});

function fixture() {
  const { key, state, connection, fetchImpl } = mcpTestFixture();
  const run = (request: unknown = { name: 'mcp.discover', arguments: {} }, limits = {}) =>
    executeMcp(
      request,
      [connection],
      { deadline: Date.now() + 1000, limits: RunLimitsSchema.parse(limits) },
      fetchImpl
    );
  const call = async () => {
    const result = await run();
    expect(result.status).toBe('succeeded');
    expect(JSON.stringify(result)).not.toContain('derived-secret');
    const [found] = (result as { output: any[] }).output;
    return {
      name: 'mcp.call',
      arguments: {
        serverId: found.serverId,
        configurationVersion: found.configurationVersion,
        definitionVersion: found.definitionVersion,
        name: found.name,
        arguments: { [key]: 2 },
      },
    };
  };
  return { key, state, connection, run, call };
}

it('discovers runtime-only schemas and returns validated business data without authorization', async () => {
  const f = fixture();
  const call = await f.call();
  const result = await f.run(call);
  expect(result).toEqual({ status: 'succeeded', output: f.state.result });
  expect(f.state.effects).toEqual([call.arguments.arguments]);
  expect(JSON.stringify(result)).not.toContain('derived-secret');
});
it.each(['missing', 'wrong_type', 'minimum', 'extra'])(
  'rejects malformed arguments before an effect: %s',
  async mode => {
    const f = fixture(),
      call = await f.call();
    const key = Object.keys(call.arguments.arguments)[0];
    const args =
      mode === 'missing'
        ? {}
        : mode === 'extra'
          ? { ...call.arguments.arguments, extra: true }
          : { [key]: mode === 'minimum' ? 0 : 'two' };
    expect(
      await f.run({ ...call, arguments: { ...call.arguments, arguments: args } })
    ).toMatchObject({ status: 'failed', error: { message: 'invalid_input' } });
    expect(f.state.effects).toEqual([]);
  }
);
it.each(['inputSchema', 'outputSchema'] as const)(
  'rejects unsupported references and malformed %s before discovery or effects',
  async field => {
    for (const extra of [
      { $ref: 'https://evil.example/schema' },
      { $ref: '#/properties/value' },
      { required: 'wrong' },
      { required: ['value', 'value'] },
      { unevaluatedProperties: false },
      { properties: { value: { type: 'unsupported' } } },
    ]) {
      const f = fixture(),
        call = await f.call();
      f.state.tool[field] = { type: 'object', ...extra } as Tool['inputSchema'];
      for (const request of [undefined, call])
        expect(await f.run(request), JSON.stringify(extra)).toMatchObject({
          status: 'failed',
          error: { message: 'invalid_schema', retryable: false },
        });
      expect(f.state.effects).toEqual([]);
    }
  }
);
it.each([
  [401, 'reauthorization_required', true],
  [403, 'reauthorization_required', true],
  [503, 'unavailable_server', true],
  [302, 'unsafe_destination', false],
  [400, 'unsafe_destination', false],
] as const)('keeps HTTP failure %i distinct and sanitized', async (status, reason, retryable) => {
  const f = fixture();
  f.state.status = status;
  expect(await f.run()).toMatchObject({ status: 'failed', error: { message: reason, retryable } });
  expect(JSON.stringify(await f.run())).not.toContain('provider-secret');
});
it.each(['description', 'inputSchema', 'outputSchema'] as const)(
  'requires a new call after %s or configuration changes',
  async field => {
    const f = fixture(),
      call = await f.call();
    expect((await f.call()).arguments).toEqual(call.arguments);
    f.state.tool = {
      ...f.state.tool,
      [field]:
        field === 'description'
          ? 'Changed operation'
          : { ...f.state.tool[field], additionalProperties: true },
    };
    expect(await f.run(call)).toMatchObject({
      status: 'failed',
      error: { message: 'definition_changed' },
    });
    f.connection.configurationVersion = '2';
    expect(await f.run(call)).toMatchObject({
      status: 'failed',
      error: { message: 'definition_changed' },
    });
    expect(f.state.effects).toEqual([]);
    expect(await f.run(await f.call())).toMatchObject({ status: 'succeeded' });
  }
);
it.each([
  ['invalid', 'invalid_output'],
  ['wrong_type', 'invalid_output'],
  ['malformed', 'invalid_output'],
  ['missing', 'invalid_output'],
  ['error', 'invalid_output'],
  ['lose', 'unavailable_server'],
  ['overflow', 'limit_exceeded'],
  ['stall', 'unavailable_server'],
  ['businessLimit', 'limit_exceeded'],
])('retains unknown outcomes without mutation replay: %s', async (mode, reason) => {
  const f = fixture(),
    call = await f.call();
  if (mode === 'invalid') f.state.result = { content: [], structuredContent: { wrong: true } };
  if (mode === 'wrong_type')
    f.state.result = { content: [], structuredContent: { [f.key]: 'two' } };
  if (mode === 'malformed') f.state.result = { content: 'provider-secret' };
  if (mode === 'missing') f.state.result = { content: [] };
  if (mode === 'error') f.state.result = { content: [], isError: true };
  if (mode === 'businessLimit')
    f.state.result = {
      ...(f.state.result as object),
      content: [{ type: 'text', text: 'é'.repeat(1600) }],
    };
  f.state.lose = mode === 'lose';
  f.state.overflow = mode === 'overflow';
  f.state.stall = mode === 'stall';
  const result = await f.run(call, {
    httpResponseBytes: mode === 'businessLimit' ? 8192 : 2048,
    toolOutputBytes: 2048,
    toolAttemptMs: 100,
  });
  expect(result).toEqual({ status: 'outcome_unknown', reason });
  expect(f.state.effects).toEqual([call.arguments.arguments]);
  expect(JSON.stringify(result)).not.toContain('provider-secret');
});
it('returns no invented definitions without configured connections', async () => {
  expect(
    await executeMcp({ name: 'mcp.discover', arguments: {} }, [], {
      deadline: Date.now() + 1000,
      limits: RunLimitsSchema.parse({}),
    })
  ).toEqual({ status: 'succeeded', output: [] });
});
