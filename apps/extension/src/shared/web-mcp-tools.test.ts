import { describe, expect, it } from 'vitest';
import type { WebMcpToolDescriptor } from './tab-debugger';
import { buildWebMcpToolDefinitions } from './web-mcp-tools';

const objectSchema = {
  additionalProperties: false,
  properties: {
    query: { type: 'string' },
  },
  required: ['query'],
  type: 'object',
};

const createTool = (overrides: Partial<WebMcpToolDescriptor> = {}): WebMcpToolDescriptor => ({
  description: 'Search the page for a term.',
  inputSchema: objectSchema,
  name: 'search_page',
  origin: 'https://example.com',
  title: 'Search Page',
  ...overrides,
});

const build = (tools: WebMcpToolDescriptor[]) =>
  buildWebMcpToolDefinitions({ documentId: 'doc-1', tabId: 1, tools });

describe('webMCP tools', () => {
  it('maps a page tool to a gateway definition and route', () => {
    const result = build([createTool()]);

    expect(result.tools).toStrictEqual([
      {
        function: {
          description: 'Search Page\nSearch the page for a term.',
          name: 'search_page',
          parameters: objectSchema,
        },
        type: 'function',
      },
    ]);
    expect(result.routes.get('search_page')).toMatchObject({
      documentId: 'doc-1',
      gatewayToolName: 'search_page',
      origin: 'https://example.com',
      pageToolName: 'search_page',
      tabId: 1,
    });
  });

  it('normalizes a JSON-string schema and a structured schema to the same object', () => {
    const stringResult = build([createTool({ inputSchema: JSON.stringify(objectSchema) })]);
    const objectResult = build([createTool({ inputSchema: objectSchema })]);

    expect(stringResult.tools).toStrictEqual(objectResult.tools);
    expect(stringResult.tools[0]?.function.parameters).toStrictEqual(objectSchema);
    expect(stringResult.routes.get('search_page')?.definitionSignature).toBe(
      objectResult.routes.get('search_page')?.definitionSignature
    );
  });

  it('puts the title before the description in the gateway description', () => {
    const result = build([createTool()]);

    expect(result.tools[0]?.function.description).toBe('Search Page\nSearch the page for a term.');
  });

  it('uses the title alone when the description is empty', () => {
    const result = build([createTool({ description: '' })]);

    expect(result.tools[0]?.function.description).toBe('Search Page');
  });

  it('uses the description alone when the title is empty', () => {
    const result = build([createTool({ title: '' })]);

    expect(result.tools[0]?.function.description).toBe('Search the page for a term.');
  });

  it('normalizes empty title and description to an empty description', () => {
    const result = build([createTool({ description: '', title: '' })]);

    expect(result.tools[0]?.function.description).toBe('');
  });

  it('omits duplicate page names', () => {
    const result = build([createTool(), createTool({ title: 'Other' })]);

    expect(result.tools).toHaveLength(1);
    expect(result.routes.size).toBe(1);
    expect(result.warning).toContain('Omitted 1');
  });

  it('omits mcp_-prefixed names', () => {
    const result = build([createTool({ name: 'mcp_shadow' })]);

    expect(result.tools).toStrictEqual([]);
    expect(result.routes.size).toBe(0);
  });

  it('omits reserved built-in names', () => {
    const result = build([
      createTool({ name: 'eval' }),
      createTool({ name: 'get_page_snapshot' }),
      createTool({ name: 'delete_workflow' }),
    ]);

    expect(result.tools).toStrictEqual([]);
    expect(result.routes.size).toBe(0);
  });

  it('omits names that do not match the allowed pattern', () => {
    const result = build([createTool({ name: 'bad name!' })]);

    expect(result.tools).toStrictEqual([]);
    expect(result.routes.size).toBe(0);
  });

  it('omits tools whose schema is not an object after normalization', () => {
    const result = build([
      createTool({ inputSchema: 'not valid json', name: 'bad_json' }),
      createTool({ inputSchema: 42, name: 'number_schema' }),
      createTool({ inputSchema: [1, 2, 3], name: 'array_schema' }),
      createTool({ inputSchema: null, name: 'null_schema' }),
    ]);

    expect(result.tools).toStrictEqual([]);
    expect(result.routes.size).toBe(0);
  });

  it('returns no tools and a warning when the page exceeds the limit', () => {
    const tools = Array.from({ length: 129 }, (_unused, index) =>
      createTool({ name: `tool_${index}` })
    );

    const result = build(tools);

    expect(result.tools).toStrictEqual([]);
    expect(result.routes.size).toBe(0);
    expect(result.warning).toContain('the limit is 128');
  });

  it('builds the definition signature from the ordered array', () => {
    const result = build([createTool()]);

    expect(result.routes.get('search_page')?.definitionSignature).toBe(
      JSON.stringify([
        'search_page',
        'Search Page',
        'Search the page for a term.',
        'https://example.com',
        objectSchema,
      ])
    );
  });

  it('stores tabId, documentId, origin, and definitionSignature in the route', () => {
    const result = buildWebMcpToolDefinitions({
      documentId: 'doc-42',
      tabId: 7,
      tools: [createTool()],
    });

    expect(result.routes.get('search_page')).toStrictEqual({
      definitionSignature: JSON.stringify([
        'search_page',
        'Search Page',
        'Search the page for a term.',
        'https://example.com',
        objectSchema,
      ]),
      documentId: 'doc-42',
      gatewayToolName: 'search_page',
      origin: 'https://example.com',
      pageToolName: 'search_page',
      tabId: 7,
    });
  });

  it('reports omitted tools as a warning without failing the turn', () => {
    const result = build([
      createTool({ name: 'eval' }),
      createTool({ name: 'mcp_shadow' }),
      createTool({ name: 'bad name!' }),
      createTool({ name: 'ok_tool' }),
    ]);

    expect(result.tools.map(tool => tool.function.name)).toStrictEqual(['ok_tool']);
    expect(result.warning).toContain('Omitted 3');
  });
});
