import { describe, expect, it } from 'bun:test';
import { kilo2MessageSchema, kilo2SessionSchema } from './kilo2-api.js';
import { kilo2PartId, projectKilo2Messages } from './kilo2-messages.js';
import { runtimeHarness, kilo2RuntimeEnvironment } from './runtime-harness.js';
import { readKilo2Sse } from './kilo2-event-feed.js';
import {
  prepareIngestFrame,
  slimPersistedKilocodeEvent,
} from '../../../src/shared/ingest-frame.js';
import { z } from 'zod';

describe('Kilo v2 Cloud projection', () => {
  it('keeps user identity, tool output, text ordinals, model, and usage in one projection', () => {
    const session = kilo2SessionSchema.parse({
      id: 'ses_local',
      location: { directory: '/workspace' },
      time: { created: 1, updated: 2 },
    });
    const messages = [
      { id: 'msg_user', type: 'user', text: 'remember amber', time: { created: 1 } },
      {
        id: 'msg_assistant',
        type: 'assistant',
        agent: 'code',
        model: { providerID: 'kilo', id: 'local' },
        content: [
          { type: 'text', text: 'before' },
          {
            type: 'tool',
            id: 'call_1',
            name: 'shell',
            time: { created: 2, ran: 3, completed: 4 },
            state: {
              status: 'completed',
              input: { command: 'printf amber' },
              content: [{ type: 'text', text: 'amber' }],
            },
          },
          { type: 'text', text: 'after' },
        ],
        cost: 0.02,
        tokens: { input: 3, output: 4, reasoning: 0, cache: { read: 1, write: 0 } },
        time: { created: 2, completed: 5 },
        finish: 'stop',
      },
    ].map(value => kilo2MessageSchema.parse(value));
    const result = projectKilo2Messages(session, messages);
    expect(result[0].info.id).toBe('msg_user');
    expect(result[1].info).toMatchObject({
      parentID: 'msg_user',
      role: 'assistant',
      cost: 0.02,
      modelID: 'local',
    });
    expect(result[1].parts[2].id).toBe(kilo2PartId('msg_assistant', 'text', 1));
    expect(result[1].parts[1]).toMatchObject({
      tool: 'bash',
      callID: 'call_1',
      state: { status: 'completed', output: 'amber' },
    });
  });

  it('selects v1 by default and rejects unknown harnesses and untrusted binary paths', () => {
    expect(runtimeHarness({}).kind).toBe('kilo');
    expect(runtimeHarness({ KILO_RUNTIME_HARNESS: 'kilo2' }).cli).toBe('kilo2');
    expect(() => runtimeHarness({ KILO_RUNTIME_HARNESS: 'unknown' })).toThrow();
    expect(() =>
      runtimeHarness({ KILO_RUNTIME_HARNESS: 'kilo2', KILO_RUNTIME_CLI_PATH: '/tmp/untrusted' })
    ).toThrow();
  });

  it('retains native replay data and attachments through Cloud event persistence', () => {
    const session = kilo2SessionSchema.parse({
      id: 'ses_local',
      location: { directory: '/workspace' },
      time: { created: 1, updated: 2 },
    });
    const native = kilo2MessageSchema.parse({
      id: 'msg_native',
      type: 'assistant',
      agent: 'code',
      model: { id: 'local', providerID: 'kilo' },
      native: { providerCheckpoint: 'retained' },
      content: [
        { type: 'reasoning', text: 'reasoning', native: { signature: 'local-test-signature' } },
      ],
      time: { created: 1, completed: 2 },
    });
    const projected = projectKilo2Messages(session, [native])[0];
    const frame = prepareIngestFrame({
      streamEventType: 'kilocode',
      timestamp: new Date(0).toISOString(),
      data: { type: 'message.updated', properties: { info: projected.info } },
    });
    expect(frame.kind).toBe('send');
    if (frame.kind !== 'send') throw new Error('Expected an intact native message');
    const persisted = slimPersistedKilocodeEvent(JSON.parse(frame.serialized).data);
    const restored = z
      .object({ properties: z.object({ info: z.object({ kilo2: kilo2MessageSchema }) }) })
      .parse(persisted);
    expect(restored.properties.info.kilo2).toEqual(native);
    const attachment = kilo2MessageSchema.parse({
      id: 'msg_file',
      type: 'user',
      time: { created: 1 },
      text: 'Read the file',
      files: [
        { data: 'aGVsbG8=', mime: 'text/plain', source: { type: 'inline' }, name: 'hello.txt' },
      ],
    });
    expect(projectKilo2Messages(session, [attachment])[0].parts[1]).toMatchObject({
      type: 'file',
      mime: 'text/plain',
      url: 'data:text/plain;base64,aGVsbG8=',
    });
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
