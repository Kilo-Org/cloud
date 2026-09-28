import { describe, expect, it } from 'vitest';

import { normalizeRemoteMcpUrl } from './remote-mcp-url';

describe('normalizeRemoteMcpUrl', () => {
  it('trims whitespace and drops a trailing slash', () => {
    expect(normalizeRemoteMcpUrl(' https://remote.example/mcp/ ')).toBe(
      'https://remote.example/mcp'
    );
  });

  it('rejects a non-http protocol', () => {
    expect(() => normalizeRemoteMcpUrl('ftp://remote.example/mcp')).toThrow(
      'Remote MCP URL must use HTTPS unless it points to localhost.'
    );
  });

  it('rejects garbage', () => {
    expect(() => normalizeRemoteMcpUrl('not a url')).toThrow('Remote MCP URL must be a valid URL.');
  });

  it('allows plain HTTP only on localhost', () => {
    expect(normalizeRemoteMcpUrl('http://localhost:8787/mcp')).toBe('http://localhost:8787/mcp');
    expect(normalizeRemoteMcpUrl('http://127.0.0.1:8787/mcp')).toBe('http://127.0.0.1:8787/mcp');
    expect(() => normalizeRemoteMcpUrl('http://remote.example/mcp')).toThrow(
      'Remote MCP URL must use HTTPS unless it points to localhost.'
    );
  });

  it('rejects credentials and fragments', () => {
    expect(() => normalizeRemoteMcpUrl('https://token@remote.example/mcp')).toThrow(
      'Remote MCP URL must not include credentials.'
    );
    expect(() => normalizeRemoteMcpUrl('https://remote.example/mcp#tools')).toThrow(
      'Remote MCP URL must not include a fragment.'
    );
    expect(() => normalizeRemoteMcpUrl('https://remote.example/mcp#')).toThrow(
      'Remote MCP URL must not include a fragment.'
    );
  });

  it('preserves a query string while normalizing the path', () => {
    expect(normalizeRemoteMcpUrl('https://remote.example/mcp/?base=/')).toBe(
      'https://remote.example/mcp?base=/'
    );
  });
});
