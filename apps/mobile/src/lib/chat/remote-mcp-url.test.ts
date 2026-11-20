import { describe, expect, it } from 'vitest';

import {
  normalizeRemoteMcpUrl,
  RemoteMcpUrlError,
  type RemoteMcpUrlProblem,
  sameRemoteMcpEndpoint,
} from './remote-mcp-url';

/** The refusal with its problem, so every check names why the URL was refused. */
function problemOf(raw: string): RemoteMcpUrlProblem {
  try {
    normalizeRemoteMcpUrl(raw);
  } catch (error) {
    if (error instanceof RemoteMcpUrlError) {
      return error.problem;
    }
    throw error;
  }
  throw new Error(`expected ${raw} to be refused`);
}

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

  it('refuses with the typed error whose message is the problem tag', () => {
    // The message is the tag, never prose: the toast picks words elsewhere.
    expect(() => normalizeRemoteMcpUrl('ftp://remote.example/mcp')).toThrow(RemoteMcpUrlError);
    expect(() => normalizeRemoteMcpUrl('ftp://remote.example/mcp')).toThrow('insecureEndpoint');
    expect(problemOf('ftp://remote.example/mcp')).toBe('insecureEndpoint');
  });

  it('rejects a non-http protocol', () => {
    expect(problemOf('ftp://remote.example/mcp')).toBe('insecureEndpoint');
  });

  it('rejects garbage', () => {
    expect(problemOf('not a url')).toBe('invalidUrl');
  });

  it('allows plain HTTP only on localhost', () => {
    expect(normalizeRemoteMcpUrl('http://localhost:8787/mcp')).toBe('http://localhost:8787/mcp');
    expect(normalizeRemoteMcpUrl('http://127.0.0.1:8787/mcp')).toBe('http://127.0.0.1:8787/mcp');
    expect(problemOf('http://remote.example/mcp')).toBe('insecureEndpoint');
  });

  it('rejects credentials and fragments', () => {
    expect(problemOf('https://token@remote.example/mcp')).toBe('credentials');
    expect(problemOf('https://remote.example/mcp#tools')).toBe('fragment');
    expect(problemOf('https://remote.example/mcp#')).toBe('fragment');
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
