import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export function mcpTestFixture() {
  const key = crypto.randomUUID();
  const shape = {
    type: 'object' as const,
    properties: { [key]: { type: 'integer', minimum: 1 } },
    required: [key],
    additionalProperties: false,
  };
  const tool: Tool = {
    name: 'remote',
    inputSchema: shape,
    outputSchema: shape,
    annotations: { readOnlyHint: true },
  };
  const connection = {
    serverId: 'configured',
    configurationVersion: '1',
    url: 'https://gateway.example/mcp-connect/user/owner/configured/route',
    authorization: 'Bearer derived-secret',
  };
  const state = {
    tool,
    result: { content: [], structuredContent: { [key]: 2 } } as unknown,
    effects: [] as unknown[],
    status: 200,
    lose: false,
    overflow: false,
    stall: false,
    response: undefined as Response | ((message: object) => Response) | undefined,
    requests: [] as { url: string; init: RequestInit }[],
  };
  const fetchImpl: typeof fetch = async (target, init) => {
    if (init?.redirect !== 'manual') throw new Error('Redirect controls are missing');
    const url =
      typeof target === 'string' ? target : target instanceof URL ? target.href : target.url;
    state.requests.push({ url, init });
    if (init.method === 'GET') return new Response(null, { status: 405 });
    if (typeof init.body !== 'string') throw new Error('Expected a JSON request body');
    const message = JSON.parse(init.body) as {
      id?: string | number;
      method: string;
      params: { arguments: unknown };
    };
    if (!('id' in message)) return new Response(null, { status: 202 });
    if (state.status !== 200) return new Response('provider-secret', { status: state.status });
    let result: unknown = {
      protocolVersion: '2025-11-25',
      capabilities: { tools: {} },
      serverInfo: { name: 'remote', version: '1' },
    };
    if (message.method === 'tools/list') result = { tools: [state.tool] };
    if (message.method === 'tools/call') {
      state.effects.push(message.params.arguments);
      if (state.lose) throw new Error('provider-secret');
      if (state.stall)
        return new Promise((_resolve, reject) =>
          init.signal?.addEventListener('abort', () => reject(new Error('timeout')), { once: true })
        );
      if (state.overflow)
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(4096));
              controller.close();
            },
          }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      result = state.result;
    }
    const response = { jsonrpc: '2.0', id: message.id, result };
    return typeof state.response === 'function'
      ? state.response(response)
      : (state.response ?? Response.json(response));
  };
  return { key, state, connection, fetchImpl };
}
