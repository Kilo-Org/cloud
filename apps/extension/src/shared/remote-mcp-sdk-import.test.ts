import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { describe, expect, it } from 'vitest';

describe('remote MCP SDK imports', () => {
  it('loads browser-facing MCP client modules', () => {
    expect(Client).toBeTypeOf('function');
    expect(StreamableHTTPClientTransport).toBeTypeOf('function');
  });
});
