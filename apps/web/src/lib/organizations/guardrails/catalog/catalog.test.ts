import { adaptKiloMarketplaceYaml } from './kilo-marketplace';
import { adaptMcpRegistryList } from './mcp-registry';

const KILO_YAML = `
items:
  - id: apify
    name: Apify
    description: Actors
    author: Apify
    url: https://apify.com
    content:
      - name: Local
        content: |
          {
            "command": "npx",
            "args": ["-y", "@apify/actors-mcp-server"],
            "env": { "APIFY_TOKEN": "{{APIFY_TOKEN}}" }
          }
      - name: Remote
        content: |
          {
            "type": "streamable-http",
            "url": "https://mcp.apify.com/"
          }
      - name: Remote duplicate
        content: |
          {
            "type": "sse",
            "url": "https://mcp.apify.com"
          }
  - id: mixed
    name: Mixed
    description: Mixed variants
    content:
      - name: Docker
        content: |
          { "command": "docker", "args": ["run", "-i", "--rm", "mcp/brave-search"] }
      - name: Path
        content: |
          { "command": "{{INSTALL_DIR}}/server", "args": [] }
      - name: Tenant
        content: |
          { "type": "streamable-http", "url": "https://{{TENANT}}.example.com/mcp" }
      - name: uvx
        content: |
          { "command": "uvx", "args": ["pkg==1.2.3"] }
      - name: local form
        content: |
          { "type": "local", "command": ["npx", "-y", "pkg-two"] }
  - name: missing id
`;

describe('adaptKiloMarketplaceYaml', () => {
  const items = adaptKiloMarketplaceYaml(KILO_YAML);

  it('skips malformed items', () => {
    expect(items.map(item => item.sourceId)).toEqual(['apify', 'mixed']);
  });

  it('normalizes eligible variants and dedupes by identity', () => {
    const apify = items[0];
    expect(apify.variants).toEqual([
      {
        eligible: true,
        label: 'Local',
        identityKey: 'npm:@apify/actors-mcp-server',
        target: { kind: 'package', ecosystem: 'npm', identifier: '@apify/actors-mcp-server' },
        versionHint: null,
      },
      {
        eligible: true,
        label: 'Remote',
        identityKey: 'remote:https://mcp.apify.com',
        target: { kind: 'remote', url: 'https://mcp.apify.com' },
        versionHint: null,
      },
    ]);
  });

  it('marks unsupported variants ineligible with a reason', () => {
    const [docker, path, tenant, uvx, localForm] = items[1].variants;
    expect(docker).toMatchObject({ eligible: false, label: 'Docker' });
    expect(path).toMatchObject({ eligible: false, label: 'Path' });
    expect(tenant).toMatchObject({ eligible: false, label: 'Tenant' });
    expect(uvx).toMatchObject({
      eligible: true,
      identityKey: 'pypi:pkg',
      versionHint: '1.2.3',
    });
    expect(localForm).toMatchObject({ eligible: true, identityKey: 'npm:pkg-two' });
  });

  it('rejects a file with the wrong shape', () => {
    expect(() => adaptKiloMarketplaceYaml('foo: bar')).toThrow();
  });
});

describe('adaptMcpRegistryList', () => {
  const page = adaptMcpRegistryList({
    servers: [
      {
        server: {
          name: 'io.example/server',
          title: 'Example',
          description: 'An example',
          repository: { url: 'https://github.com/example/server' },
          remotes: [{ type: 'streamable-http', url: 'https://sh.example.com/mcp' }],
          packages: [
            {
              registryType: 'npm',
              identifier: '@example/server',
              version: '1.2.0',
              transport: { type: 'stdio' },
            },
            {
              registryType: 'pypi',
              identifier: 'example-server',
              version: '1.2.0',
              transport: { type: 'stdio' },
            },
            { registryType: 'oci', identifier: 'ghcr.io/example/server:1.2.0' },
            { registryType: 'npm', identifier: 'http-pkg', transport: { type: 'streamable-http' } },
          ],
        },
        _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active' } },
      },
      {
        server: { name: 'io.example/old', remotes: [] },
        _meta: { 'io.modelcontextprotocol.registry/official': { status: 'deprecated' } },
      },
      {
        server: {
          name: 'io.example/templated',
          remotes: [{ type: 'sse', url: 'https://{t}.example.com' }],
        },
      },
      { nonsense: true },
    ],
    metadata: { nextCursor: 'io.example/templated:1.0.0' },
  });

  it('keeps active servers and drops malformed or inactive entries', () => {
    expect(page.items.map(item => item.sourceId)).toEqual([
      'io.example/server',
      'io.example/templated',
    ]);
    expect(page.nextCursor).toBe('io.example/templated:1.0.0');
  });

  it('maps remotes and npm/pypi packages, and flags the rest', () => {
    const [remote, npm, pypi, oci, httpPackage] = page.items[0].variants;
    expect(remote).toMatchObject({
      eligible: true,
      identityKey: 'remote:https://sh.example.com/mcp',
    });
    expect(npm).toMatchObject({
      eligible: true,
      identityKey: 'npm:@example/server',
      versionHint: '1.2.0',
    });
    expect(pypi).toMatchObject({ eligible: true, identityKey: 'pypi:example-server' });
    expect(oci).toMatchObject({ eligible: false });
    expect(httpPackage).toMatchObject({ eligible: false });
    expect(page.items[0].name).toBe('Example');
    expect(page.items[0].homepageUrl).toBe('https://github.com/example/server');
  });

  it('flags templated remote URLs', () => {
    expect(page.items[1].variants[0]).toMatchObject({ eligible: false });
  });
});
