import { describe, expect, it } from 'vitest';

import { getGenericToolTitle } from './tool-card-utils';

describe('getGenericToolTitle', () => {
  it('uses the MCP server and tool names when the state title is blank', () => {
    expect(
      getGenericToolTitle('mcp', '', {
        server_name: 'github',
        tool_name: 'search_repositories',
      })
    ).toBe('github/search_repositories');
  });

  it('falls back to the transport tool name for incomplete MCP metadata', () => {
    expect(getGenericToolTitle('mcp', '  ', { server_name: 'github' })).toBe('mcp');
  });

  it('preserves a non-empty state title', () => {
    expect(getGenericToolTitle('mcp', ' Search repositories ', {})).toBe('Search repositories');
  });
});
