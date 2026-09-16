import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { areThreadsBlocking, type SCMContext } from './town-scm';
import { TownConfigSchema } from '../../types';

const THREADS = [
  {
    isResolved: false,
    comments: { nodes: [{ body: 'LGTM', author: { login: 'reviewer' } }] },
  },
];

function makeCtx(config: Record<string, unknown>) {
  const aiRun = vi.fn();
  const ctx = {
    env: {
      AI: { run: aiRun },
      GASTOWN_AE: undefined,
      KILO_API_URL: 'https://api.test',
    },
    townId: 'town-1',
    getTownConfig: async () => TownConfigSchema.parse({ town_id: 'town-1', ...config }),
  } as unknown as SCMContext;
  return { ctx, aiRun };
}

describe('areThreadsBlocking', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('uses the Kilo gateway when the configured model is direct BYOK', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: '{"blocking": false}' } }] }), {
        status: 200,
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const { ctx, aiRun } = makeCtx({
      default_model: 'neuralwatt/glm-5.2-short',
      kilocode_token: 'kilo-token',
    });

    expect(await areThreadsBlocking(ctx, THREADS)).toBe(false);
    expect(aiRun).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.test/api/openrouter/chat/completions');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer kilo-token');
    expect(init.headers['X-KiloCode-Feature']).toBe('gastown');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('neuralwatt/glm-5.2-short');
    // Reasoning must be disabled or the model can spend the token budget on a
    // thinking trace and return no JSON content.
    expect(body.reasoning).toEqual({ enabled: false, effort: 'none' });
  });

  it('prefers the refinery role model over the town default', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: '{"blocking": false}' } }] }), {
        status: 200,
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const { ctx } = makeCtx({
      default_model: 'anthropic/claude-sonnet-4.6',
      role_models: { refinery: 'zai-coding/glm-4.7' },
      kilocode_token: 'kilo-token',
    });

    expect(await areThreadsBlocking(ctx, THREADS)).toBe(false);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe('zai-coding/glm-4.7');
  });

  it('sends the organization header for org towns', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: '{"blocking": false}' } }] }), {
        status: 200,
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const { ctx } = makeCtx({
      default_model: 'neuralwatt/glm-5.2-short',
      kilocode_token: 'kilo-token',
      organization_id: 'org-1',
    });

    await areThreadsBlocking(ctx, THREADS);
    expect(fetchMock.mock.calls[0][1].headers['X-KiloCode-OrganizationId']).toBe('org-1');
  });

  it('falls back to Workers AI when the configured model is not direct BYOK', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { ctx, aiRun } = makeCtx({
      default_model: 'anthropic/claude-sonnet-4.6',
      kilocode_token: 'kilo-token',
    });
    aiRun.mockResolvedValue({ response: '{"blocking": false}' });

    expect(await areThreadsBlocking(ctx, THREADS)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(aiRun).toHaveBeenCalledWith('@cf/google/gemma-4-26b-a4b-it', expect.anything());
  });

  it('uses Workers AI when a managed refinery model overrides a BYOK default', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { ctx, aiRun } = makeCtx({
      default_model: 'neuralwatt/glm-5.2-short',
      role_models: { refinery: 'anthropic/claude-sonnet-4.6' },
      kilocode_token: 'kilo-token',
    });
    aiRun.mockResolvedValue({ response: '{"blocking": false}' });

    expect(await areThreadsBlocking(ctx, THREADS)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(aiRun).toHaveBeenCalled();
  });

  it('falls back to Workers AI when no Kilo token is configured', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { ctx, aiRun } = makeCtx({ default_model: 'neuralwatt/glm-5.2-short' });
    aiRun.mockResolvedValue({ response: '{"blocking": false}' });

    expect(await areThreadsBlocking(ctx, THREADS)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(aiRun).toHaveBeenCalled();
  });

  it('blocks without falling back to Workers AI when the gateway rejects the call', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('payment required', { status: 402 }));
    vi.stubGlobal('fetch', fetchMock);

    const { ctx, aiRun } = makeCtx({
      default_model: 'neuralwatt/glm-5.2-short',
      kilocode_token: 'kilo-token',
    });

    expect(await areThreadsBlocking(ctx, THREADS)).toBe(true);
    expect(aiRun).not.toHaveBeenCalled();
  });

  it('blocks without falling back when the gateway request throws', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);

    const { ctx, aiRun } = makeCtx({
      default_model: 'neuralwatt/glm-5.2-short',
      kilocode_token: 'kilo-token',
    });

    expect(await areThreadsBlocking(ctx, THREADS)).toBe(true);
    expect(aiRun).not.toHaveBeenCalled();
  });

  it('blocks when the gateway response has no usable text', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ choices: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const { ctx, aiRun } = makeCtx({
      default_model: 'neuralwatt/glm-5.2-short',
      kilocode_token: 'kilo-token',
    });

    expect(await areThreadsBlocking(ctx, THREADS)).toBe(true);
    expect(aiRun).not.toHaveBeenCalled();
  });
});
