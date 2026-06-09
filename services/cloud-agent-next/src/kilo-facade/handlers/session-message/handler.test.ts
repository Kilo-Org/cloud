import { describe, expect, it, vi } from 'vitest';

vi.mock('../../session-proxy.js', () => ({
  buildWrapperKiloProxyUrl: (params: {
    wrapperPort: number;
    kiloRelativePath: string;
    search: string;
  }) =>
    `http://localhost:${params.wrapperPort}/kilo-proxy${params.kiloRelativePath}${params.search}`,
  resolveLiveWrapperTarget: vi.fn(),
}));

import type { Env } from '../../../types.js';
import type { KiloSdkStoredMessage } from '../../../session-ingest-binding.js';
import type { OwnedRootHandlerContext } from '../../contracts.js';
import { publicCloudAgentDirectory } from '../../public-sdk-projection.js';
import { handleSessionMessage } from './handler.js';

const kiloSessionId = 'ses_12345678901234567890123456';
const messageId = 'msg_exact_01';
const storedMessage: KiloSdkStoredMessage = {
  info: {
    id: messageId,
    sessionID: kiloSessionId,
    role: 'assistant',
    time: { created: 100 },
    parentID: 'msg_parent_01',
    modelID: 'model',
    providerID: 'provider',
    mode: 'build',
    agent: 'build',
    path: { cwd: '/private/workspace', root: '/private/workspace' },
    cost: 0,
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
  },
  parts: [
    {
      id: 'prt_exact_01',
      sessionID: kiloSessionId,
      messageID: messageId,
      type: 'file',
      mime: 'text/plain',
      url: 'file:///private/workspace/secret.txt',
      source: {
        type: 'file',
        text: { value: 'secret.txt', start: 0, end: 10 },
        path: '/private/workspace/secret.txt',
      },
    },
  ],
};

function makeContext(params?: {
  url?: string;
  persisted?: unknown;
  liveResponse?: Response;
}): OwnedRootHandlerContext {
  const getCloudAgentRootSessionMessage = vi.fn(async () =>
    params?.persisted === undefined
      ? {
          kiloSessionId,
          cloudAgentSessionId: 'agent_root',
          message: { kind: 'value', message: storedMessage },
        }
      : params.persisted
  );
  const liveWrapper = params?.liveResponse
    ? {
        port: 4096,
        sandbox: { containerFetch: vi.fn(async () => params.liveResponse) },
      }
    : null;
  const request = new Request(
    params?.url ?? `https://example.test/kilo/session/${kiloSessionId}/message/${messageId}`
  );
  const url = new URL(request.url);
  return {
    request,
    url,
    kiloPath: url.pathname.slice('/kilo'.length),
    env: { SESSION_INGEST: { getCloudAgentRootSessionMessage } } as unknown as Env,
    userId: 'usr_owner',
    encodedKiloSessionId: kiloSessionId,
    kiloSessionId,
    cloudAgentSessionId: 'agent_root',
    deps: { resolveLiveWrapper: vi.fn(async () => liveWrapper as never) },
  };
}

describe('handleSessionMessage', () => {
  it('uses a valid warm exact response first and projects public message paths', async () => {
    const context = makeContext({ liveResponse: Response.json(storedMessage) });

    const response = await handleSessionMessage(context, messageId);

    expect(response.status).toBe(200);
    const body = (await response.json()) as KiloSdkStoredMessage;
    expect(body.info).toMatchObject({
      id: messageId,
      path: {
        cwd: publicCloudAgentDirectory(kiloSessionId),
        root: publicCloudAgentDirectory(kiloSessionId),
      },
    });
    expect(body.parts[0]).toMatchObject({
      url: '',
      source: { path: publicCloudAgentDirectory(kiloSessionId) },
    });
    expect(context.env.SESSION_INGEST.getCloudAgentRootSessionMessage).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'non-JSON content type',
      response: () =>
        new Response(JSON.stringify(storedMessage), { headers: { 'content-type': 'text/plain' } }),
    },
    {
      name: 'malformed JSON',
      response: () => new Response('{', { headers: { 'content-type': 'application/json' } }),
    },
    {
      name: 'oversized declared content length',
      response: () =>
        new Response(JSON.stringify(storedMessage), {
          headers: {
            'content-type': 'application/json',
            'content-length': String(8 * 1024 * 1024 + 1),
          },
        }),
    },
    {
      name: 'oversized streamed body',
      response: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1));
              controller.close();
            },
          }),
          { headers: { 'content-type': 'application/json' } }
        ),
    },
  ])(
    'maps a live $name response to stable invalid-upstream',
    async ({ response: liveResponse }) => {
      const context = makeContext({ liveResponse: liveResponse() });

      const response = await handleSessionMessage(context, messageId);

      expect(response.status).toBe(502);
      await expect(response.json()).resolves.toMatchObject({
        error: 'KILO_UPSTREAM_RESPONSE_INVALID',
      });
      expect(context.env.SESSION_INGEST.getCloudAgentRootSessionMessage).not.toHaveBeenCalled();
    }
  );

  it('rejects warm responses for another message instead of accepting a nearby result', async () => {
    const context = makeContext({
      liveResponse: Response.json({
        ...storedMessage,
        info: { ...storedMessage.info, id: 'msg_other_02' },
      }),
    });

    const response = await handleSessionMessage(context, messageId);

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: 'KILO_UPSTREAM_RESPONSE_INVALID',
    });
    expect(context.env.SESSION_INGEST.getCloudAgentRootSessionMessage).not.toHaveBeenCalled();
  });

  it('falls back cold and distinguishes exact not-found from owned-root missing', async () => {
    const exactMissing = makeContext({
      persisted: {
        kiloSessionId,
        cloudAgentSessionId: 'agent_root',
        message: { kind: 'not_found' },
      },
    });
    const rootMissing = makeContext({ persisted: null });

    const exactMissingResponse = await handleSessionMessage(exactMissing, messageId);
    const rootMissingResponse = await handleSessionMessage(rootMissing, messageId);

    expect(exactMissingResponse.status).toBe(404);
    await expect(exactMissingResponse.json()).resolves.toMatchObject({
      error: 'KILO_MESSAGE_NOT_FOUND',
    });
    expect(rootMissingResponse.status).toBe(404);
    await expect(rootMissingResponse.json()).resolves.toMatchObject({
      error: 'KILO_SESSION_NOT_FOUND',
    });
  });

  it('validates the persisted message belongs to the selected root and requested ID', async () => {
    const wrongMapping = makeContext({
      persisted: {
        kiloSessionId,
        cloudAgentSessionId: 'agent_other_root',
        message: { kind: 'value', message: storedMessage },
      },
    });
    const wrongRoot = makeContext({
      persisted: {
        kiloSessionId,
        cloudAgentSessionId: 'agent_root',
        message: {
          kind: 'value',
          message: {
            ...storedMessage,
            info: { ...storedMessage.info, sessionID: 'ses_abcdefghijklmnopqrstuvwxyz' },
          },
        },
      },
    });
    const wrongMessage = makeContext({
      persisted: {
        kiloSessionId,
        cloudAgentSessionId: 'agent_root',
        message: {
          kind: 'value',
          message: { ...storedMessage, info: { ...storedMessage.info, id: 'msg_other_02' } },
        },
      },
    });

    for (const context of [wrongMapping, wrongRoot, wrongMessage]) {
      const response = await handleSessionMessage(context, messageId);
      expect(response.status).toBe(502);
      await expect(response.json()).resolves.toMatchObject({
        error: 'KILO_UPSTREAM_RESPONSE_INVALID',
      });
    }
  });

  it('returns exact not-found for invalid message IDs before accessing the selected root', async () => {
    const context = makeContext();

    const response = await handleSessionMessage(context, 'not-a-message');

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: 'KILO_MESSAGE_NOT_FOUND' });
    expect(context.deps?.resolveLiveWrapper).not.toHaveBeenCalled();
    expect(context.env.SESSION_INGEST.getCloudAgentRootSessionMessage).not.toHaveBeenCalled();
  });

  it('maps persisted too_large and invalid_data outcomes', async () => {
    const tooLarge = makeContext({
      persisted: {
        kiloSessionId,
        cloudAgentSessionId: 'agent_root',
        message: { kind: 'too_large', maximumBytes: 8 * 1024 * 1024, phase: 'page_parts' },
      },
    });
    const invalid = makeContext({
      persisted: {
        kiloSessionId,
        cloudAgentSessionId: 'agent_root',
        message: { kind: 'invalid_data' },
      },
    });

    const tooLargeResponse = await handleSessionMessage(tooLarge, messageId);
    expect(tooLargeResponse.status).toBe(413);
    await expect(tooLargeResponse.json()).resolves.toMatchObject({
      error: 'KILO_TRANSCRIPT_TOO_LARGE',
    });
    const invalidResponse = await handleSessionMessage(invalid, messageId);
    expect(invalidResponse.status).toBe(502);
    await expect(invalidResponse.json()).resolves.toMatchObject({
      error: 'KILO_UPSTREAM_RESPONSE_INVALID',
    });
  });

  it('returns invalid-upstream instead of throwing for malformed discriminated parts', async () => {
    const context = makeContext({
      liveResponse: Response.json({
        ...storedMessage,
        parts: [
          {
            id: 'prt_malformed_01',
            sessionID: kiloSessionId,
            messageID: messageId,
            type: 'tool',
            state: { status: 'unknown' },
          },
        ],
      }),
    });

    const response = await handleSessionMessage(context, messageId);

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: 'KILO_UPSTREAM_RESPONSE_INVALID',
    });
  });

  it('matches owned-root selector validation and maps persisted read failures', async () => {
    const selected = makeContext({
      url: `https://example.test/kilo/session/${kiloSessionId}/message/${messageId}?directory=${encodeURIComponent(publicCloudAgentDirectory(kiloSessionId))}`,
      persisted: {
        kiloSessionId,
        cloudAgentSessionId: 'agent_root',
        message: { kind: 'retryable_failure', phase: 'page_parts' },
      },
    });
    const retryableResponse = await handleSessionMessage(selected, messageId);
    expect(retryableResponse.status).toBe(503);
    expect(retryableResponse.headers.get('Retry-After')).toBe('1');

    const unsupported = makeContext({
      url: `https://example.test/kilo/session/${kiloSessionId}/message/${messageId}?directory=/tmp/private`,
    });
    const unsupportedResponse = await handleSessionMessage(unsupported, messageId);
    expect(unsupportedResponse.status).toBe(400);
    expect(unsupported.env.SESSION_INGEST.getCloudAgentRootSessionMessage).not.toHaveBeenCalled();
  });
});
