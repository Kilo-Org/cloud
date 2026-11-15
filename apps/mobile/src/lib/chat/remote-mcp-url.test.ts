import { describe, expect, it } from 'vitest';

import { normalizeRemoteMcpUrl, sameRemoteMcpEndpoint } from './remote-mcp-url';

describe('normalizeRemoteMcpUrl', () => {
  it('trims whitespace and drops a trailing slash', () => {
    expect(normalizeRemoteMcpUrl(' https://remote.example/mcp/ ')).toBe(
      'https://remote.example/mcp'
    );
  });

  it('lowercases the host', () => {
    expect(normalizeRemoteMcpUrl('https://Remote.Example/mcp/')).toBe('https://remote.example/mcp');
  });

  it('drops a default port', () => {
    expect(normalizeRemoteMcpUrl('https://remote.example:443/mcp')).toBe(
      'https://remote.example/mcp'
    );
    expect(normalizeRemoteMcpUrl('http://localhost:80/mcp')).toBe('http://localhost/mcp');
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

  it('drops the trailing slash of a root path', () => {
    expect(normalizeRemoteMcpUrl('https://remote.example/')).toBe('https://remote.example');
    expect(normalizeRemoteMcpUrl('https://remote.example///')).toBe('https://remote.example');
    expect(normalizeRemoteMcpUrl('http://localhost:8787/')).toBe('http://localhost:8787');
  });

  it('normalizes both spellings of a root path with a query to one value', () => {
    expect(normalizeRemoteMcpUrl('https://remote.example/?base=/')).toBe(
      normalizeRemoteMcpUrl('https://remote.example?base=/')
    );
    expect(normalizeRemoteMcpUrl('https://remote.example/?base=/')).toBe(
      'https://remote.example?base=/'
    );
  });
});

describe('sameRemoteMcpEndpoint', () => {
  it('matches two spellings of one endpoint', () => {
    expect(
      sameRemoteMcpEndpoint('https://remote.example/mcp/', 'https://Remote.Example:443/mcp')
    ).toBe(true);
  });

  it('separates endpoints by path, port and query', () => {
    const saved = 'https://remote.example/mcp';

    expect(sameRemoteMcpEndpoint(saved, 'https://remote.example/other')).toBe(false);
    expect(sameRemoteMcpEndpoint(saved, 'https://remote.example:8443/mcp')).toBe(false);
    expect(sameRemoteMcpEndpoint(saved, 'https://remote.example/mcp?base=/')).toBe(false);
  });
});
