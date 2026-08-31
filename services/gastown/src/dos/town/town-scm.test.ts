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
    expect(JSON.parse(init.body).model).toBe('neuralwatt/glm-5.2-short');
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
});
