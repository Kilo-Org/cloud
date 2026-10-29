import {
  mcpIdentityKey,
  normalizeMinVersion,
  normalizePackageIdentifier,
  normalizeRemoteMcpUrl,
} from './mcp-identity';

describe('normalizeRemoteMcpUrl', () => {
  it.each([
    ['https://MCP.Example.com/mcp/', 'https://mcp.example.com/mcp'],
    ['https://mcp.example.com', 'https://mcp.example.com'],
    ['https://mcp.example.com:443/a/b?token=1#frag', 'https://mcp.example.com/a/b'],
    ['https://mcp.example.com:8443/mcp', 'https://mcp.example.com:8443/mcp'],
    ['  https://mcp.example.com/sse  ', 'https://mcp.example.com/sse'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeRemoteMcpUrl(input)).toEqual({ ok: true, value: expected });
  });

  it.each([
    'http://mcp.example.com/mcp',
    'https://user:pass@mcp.example.com/mcp',
    'https://{tenant}.example.com/mcp',
    'not a url',
    'ftp://example.com',
  ])('rejects %s', input => {
    expect(normalizeRemoteMcpUrl(input).ok).toBe(false);
  });
});

describe('normalizePackageIdentifier', () => {
  it('accepts scoped and unscoped npm names', () => {
    expect(normalizePackageIdentifier('npm', '@scope/pkg')).toEqual({
      ok: true,
      value: '@scope/pkg',
    });
    expect(normalizePackageIdentifier('npm', 'pkg-name').ok).toBe(true);
  });

  it.each(['', 'git+https://github.com/a/b', '../local', 'a b', '@scope', 'pkg@1.0.0'])(
    'rejects npm name %s',
    input => {
      expect(normalizePackageIdentifier('npm', input).ok).toBe(false);
    }
  );

  it('accepts PyPI names and rejects specifiers and paths', () => {
    expect(normalizePackageIdentifier('pypi', 'awslabs.amazon-keyspaces-mcp-server').ok).toBe(true);
    expect(normalizePackageIdentifier('pypi', 'pkg==1.0').ok).toBe(false);
    expect(normalizePackageIdentifier('pypi', 'git+https://x/y').ok).toBe(false);
    expect(normalizePackageIdentifier('pypi', './dir').ok).toBe(false);
  });
});

describe('normalizeMinVersion', () => {
  it('treats blank as no minimum', () => {
    expect(normalizeMinVersion('  ')).toEqual({ ok: true, value: null });
    expect(normalizeMinVersion(null)).toEqual({ ok: true, value: null });
  });

  it('accepts versions and rejects ranges', () => {
    expect(normalizeMinVersion('1.2.3')).toEqual({ ok: true, value: '1.2.3' });
    expect(normalizeMinVersion('2.0.0-rc.1').ok).toBe(true);
    expect(normalizeMinVersion('^1.2.3').ok).toBe(false);
    expect(normalizeMinVersion('>=1.0').ok).toBe(false);
    expect(normalizeMinVersion('latest').ok).toBe(false);
  });
});

describe('mcpIdentityKey', () => {
  it('keys remotes by normalized URL', () => {
    expect(mcpIdentityKey({ kind: 'remote', url: 'https://mcp.example.com/mcp' })).toBe(
      'remote:https://mcp.example.com/mcp'
    );
  });

  it('lowercases npm names', () => {
    expect(mcpIdentityKey({ kind: 'package', ecosystem: 'npm', identifier: '@Scope/Pkg' })).toBe(
      'npm:@scope/pkg'
    );
  });

  it('applies PEP 503 normalization to PyPI names', () => {
    const dotted = mcpIdentityKey({
      kind: 'package',
      ecosystem: 'pypi',
      identifier: 'Foo.Bar_baz',
    });
    const dashed = mcpIdentityKey({
      kind: 'package',
      ecosystem: 'pypi',
      identifier: 'foo-bar-baz',
    });
    expect(dotted).toBe('pypi:foo-bar-baz');
    expect(dashed).toBe(dotted);
  });
});
