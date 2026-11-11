import { describe, expect, it } from 'bun:test';
import { runtimeHarness, kilo2RuntimeEnvironment } from './runtime-harness.js';
import { readKilo2Sse } from './kilo2-event-feed.js';

describe('runtime harness selection', () => {
  it('exposes legacy rule files to V2 once without replacing repository instruction configuration', () => {
    const original = {
      HOME: '/workspace-shared-home',
      KILO_CONFIG_CONTENT: JSON.stringify({
        instructions: ['AGENTS.md', '/workspace-shared-home/.kilocode/rules/*.md'],
        mcp: { fixture: { type: 'remote', url: 'http://localhost:1/mcp' } },
      }),
    };
    const result = kilo2RuntimeEnvironment(original);
    const config = JSON.parse(result.KILO_CONFIG_CONTENT);
    expect(config.instructions).toEqual([
      'AGENTS.md',
      '/workspace-shared-home/.kilocode/rules/*.md',
    ]);
    expect(config.mcp).toEqual(JSON.parse(original.KILO_CONFIG_CONTENT).mcp);
    expect(result.OPENCODE_CONFIG_CONTENT).toBe(result.KILO_CONFIG_CONTENT);
    expect(kilo2RuntimeEnvironment(result).KILO_CONFIG_CONTENT).toBe(result.KILO_CONFIG_CONTENT);
  });

  it('adds the workspace rules source when no instructions were configured', () => {
    const env = { HOME: '/shared', KILO_CONFIG_CONTENT: '{}' };
    expect(JSON.parse(kilo2RuntimeEnvironment(env).KILO_CONFIG_CONTENT).instructions).toEqual([
      '/shared/.kilocode/rules/*.md',
    ]);
    // V1 keeps its implicit rule discovery, with no second configured copy.
    expect(env.KILO_CONFIG_CONTENT).toBe('{}');
  });
  it('selects v1 by default and rejects unknown harnesses and untrusted binary paths', () => {
    expect(runtimeHarness({}).kind).toBe('kilo');
    expect(runtimeHarness({ KILO_RUNTIME_HARNESS: 'kilo2' }).cli).toBe('kilo2');
    expect(() => runtimeHarness({ KILO_RUNTIME_HARNESS: 'unknown' })).toThrow();
    expect(() =>
      runtimeHarness({ KILO_RUNTIME_HARNESS: 'kilo2', KILO_RUNTIME_CLI_PATH: '/tmp/untrusted' })
    ).toThrow();
  });

  it('retains generated Cloud permissions and selects the local gateway for v2', () => {
    const permission = { external_directory: 'allow', bash: { '*': 'allow', 'git push *': 'ask' } };
    const result = kilo2RuntimeEnvironment({
      HOME: '/isolated',
      KILO_CONFIG_CONTENT: JSON.stringify({
        permission,
        provider: { kilo: { options: { baseURL: 'http://localhost:3200/api/gateway' } } },
        indexing: { enabled: false },
      }),
    });
    expect(result.KILO_AI_GATEWAY_URL).toBe('http://localhost:3200/api/gateway');
    expect(JSON.parse(result.KILO_CONFIG_CONTENT).permission).toEqual(permission);
    expect(JSON.parse(result.KILO_CONFIG_CONTENT).indexing).toBeUndefined();
    expect(
      kilo2RuntimeEnvironment({
        KILO_CONFIG_CONTENT: JSON.stringify({
          provider: { kilo: { options: { baseURL: 'http://localhost:6300/api' } } },
        }),
      }).KILO_AI_GATEWAY_URL
    ).toBe('http://localhost:6300/api/openrouter');
  });

  it.each([
    ['http://host.docker.internal:12094', 'http://host.docker.internal:12094/api/openrouter'],
    ['http://host.docker.internal:12094/', 'http://host.docker.internal:12094/api/openrouter'],
    ['http://localhost:6300/api', 'http://localhost:6300/api/openrouter'],
    [
      'https://worker.example/prefix/api/runtime-credential-proxy/provider',
      'https://worker.example/prefix/api/runtime-credential-proxy/provider/api/openrouter',
    ],
    ['https://worker.example/api/openrouter', 'https://worker.example/api/openrouter'],
  ])(
    'routes native catalog and inference through the same scoped provider root: %s',
    (baseURL, expected) => {
      const result = kilo2RuntimeEnvironment({
        KILO_CONFIG_CONTENT: JSON.stringify({
          provider: { kilo: { options: { baseURL, kilocodeToken: 'test-runtime-handle' } } },
        }),
      });
      expect(result.KILO_AI_GATEWAY_URL).toBe(expected);
      expect(JSON.parse(result.KILO_CONFIG_CONTENT).provider.kilo.options).toEqual({
        baseURL: expected,
        kilocodeToken: 'test-runtime-handle',
      });
    }
  );

  it('preserves the projected organization through the v2 config adapter', () => {
    const result = kilo2RuntimeEnvironment({
      KILOCODE_ORGANIZATION_ID: 'org-session',
      KILO_CONFIG_CONTENT: JSON.stringify({
        provider: {
          kilo: {
            options: {
              baseURL: 'https://worker.example/api/openrouter',
              kilocodeOrganizationId: 'org-session',
            },
          },
        },
      }),
    });
    expect(result.KILOCODE_ORGANIZATION_ID).toBe('org-session');
    expect(
      JSON.parse(result.KILO_CONFIG_CONTENT).provider.kilo.options.kilocodeOrganizationId
    ).toBe('org-session');
  });

  it('keeps heartbeat comments and frames split across transport chunks', async () => {
    const chunks = [': heart', 'beat\n\nda', 'ta: {"type":"server.connected"}\n\n'];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    });
    const frames: string[] = [];
    for await (const frame of readKilo2Sse(body, new AbortController().signal)) frames.push(frame);
    expect(frames).toEqual([': heartbeat', 'data: {"type":"server.connected"}']);
  });
});
