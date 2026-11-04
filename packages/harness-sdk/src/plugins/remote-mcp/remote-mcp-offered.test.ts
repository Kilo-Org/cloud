import { describe, expect, it } from 'vitest';
import { remoteMcpTools } from './index.js';
import { chartApp, deps, run, serve, serverFor, token } from './remote-mcp-fixture.js';

/**
 * What a server's tools look like once this harness offers them, and what the
 * surface that draws a call is told: the view a tool carries, the name the
 * view calls it by, and the whole answer the model's text was cut from.
 */

describe('the tools a server offers with a view', () => {
  it('carries the view and the server’s own name, outside the model’s definition', async () => {
    const served = await serve(chartApp);
    const offered = await run(remoteMcpTools(serverFor('work', served.url, token), deps()));
    const [first] = offered;
    expect(first?.uiResourceUri).toBe('ui://work/chart.html');
    expect(first?.serverToolName).toBe('draw-chart');
    expect(first?.definition).toEqual({
      name: 'mcp_work_draw-chart',
      description: 'Draws a chart.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
      },
    });
  });

  it('names the server’s own tool even when the server attached no view', async () => {
    const served = await serve({
      list: [
        {
          name: 'read-file',
          description: 'Reads.',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
      call: () => ({ content: [] }),
    });
    const offered = await run(remoteMcpTools(serverFor('work', served.url, token), deps()));
    const [first] = offered;
    expect(first?.uiResourceUri).toBeUndefined();
    expect(first?.serverToolName).toBe('read-file');
  });
});

describe('the answer a surface draws', () => {
  it('is reported whole, after the model’s text is returned', async () => {
    const served = await serve(chartApp);
    const answers: { tool: string; callId: string; structuredContent: unknown }[] = [];
    const offered = await run(
      remoteMcpTools(serverFor('work', served.url, token), {
        ...deps(),
        onCallResult: answered => answers.push(answered),
      })
    );
    const [first] = offered;
    if (first === undefined) {
      throw new Error('the server offered no tool');
    }
    const text = await run(
      first.run({ id: 'call_9', name: first.definition.name, arguments: '{}' })
    );
    expect(text).toBe('chart drawn');
    expect(answers).toEqual([
      {
        tool: 'draw-chart',
        callId: 'call_9',
        content: [{ type: 'text', text: 'chart drawn' }],
        structuredContent: { points: 3 },
      },
    ]);
  });
});
