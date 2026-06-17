import { describe, expect, it, vi } from 'vitest';
import { destroyDeciderCliContainer, runDeciderCaseViaCli, warmUpCliContainer } from './cli-runner';

const benchCase = {
  id: 'case-1',
  taskType: 'implementation',
  subtaskType: 'feature_development',
  systemPrompt: 'system',
  userPrompt: 'user',
  check: { kind: 'exact', value: 'ok' },
} as const;

function createEnv(fetch: ReturnType<typeof vi.fn>) {
  const idFromName = vi.fn((name: string) => `id:${name}`);
  const get = vi.fn(() => ({ fetch }));
  return { env: { BENCH_RUNNER: { idFromName, get } } as unknown as Env, fetch };
}

async function readJsonBody(request: Request) {
  return JSON.parse(await request.clone().text()) as Record<string, unknown>;
}

describe('runDeciderCaseViaCli', () => {
  it('passes orgId through to the container run request when provided', async () => {
    const fetch = vi.fn(async (_request: Request) =>
      Response.json({
        exitCode: 0,
        durationMs: 10,
        stdoutLines: [],
        stderrTail: '',
      })
    );
    const { env } = createEnv(fetch);

    await runDeciderCaseViaCli(env, {
      instanceName: 'run:model:0',
      model: 'vendor/model',
      benchCase,
      kiloToken: 'kilo-user-token',
      kiloApiUrl: 'http://host.docker.internal:3000',
      orgId: 'org-123',
    });

    const request = fetch.mock.calls[0]?.[0];
    expect(request).toBeInstanceOf(Request);
    await expect(readJsonBody(request)).resolves.toMatchObject({
      model: 'vendor/model',
      kiloToken: 'kilo-user-token',
      kiloApiUrl: 'http://host.docker.internal:3000',
      orgId: 'org-123',
    });
  });
});

describe('warmUpCliContainer', () => {
  it('passes orgId through to the container warmup request when provided', async () => {
    const fetch = vi.fn(async (_request: Request) =>
      Response.json({ exitCode: 0, durationMs: 10 })
    );
    const { env } = createEnv(fetch);

    await warmUpCliContainer(env, {
      instanceName: 'run:model:0',
      model: 'vendor/model',
      kiloToken: 'kilo-user-token',
      kiloApiUrl: 'http://host.docker.internal:3000',
      orgId: 'org-123',
    });

    const request = fetch.mock.calls[0]?.[0];
    expect(request).toBeInstanceOf(Request);
    await expect(readJsonBody(request)).resolves.toMatchObject({
      model: 'vendor/model',
      kiloToken: 'kilo-user-token',
      orgId: 'org-123',
    });
  });
});

describe('destroyDeciderCliContainer', () => {
  it('calls the container admin destroy endpoint for the instance name', async () => {
    const fetch = vi.fn(async () => new Response('destroyed', { status: 200 }));
    const idFromName = vi.fn((name: string) => `id:${name}`);
    const get = vi.fn(() => ({ fetch }));
    const env = { BENCH_RUNNER: { idFromName, get } } as unknown as Env;

    await destroyDeciderCliContainer(env, { instanceName: 'run:model:2' });

    expect(idFromName).toHaveBeenCalledWith('run:model:2');
    expect(get).toHaveBeenCalledWith('id:run:model:2');
    expect(fetch).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        url: 'http://container/admin/destroy',
      })
    );
  });

  it('throws when the container destroy endpoint fails', async () => {
    const fetch = vi.fn(async () => new Response('nope', { status: 500 }));
    const env = {
      BENCH_RUNNER: {
        idFromName: (name: string) => `id:${name}`,
        get: () => ({ fetch }),
      },
    } as unknown as Env;

    await expect(destroyDeciderCliContainer(env, { instanceName: 'run:model:2' })).rejects.toThrow(
      'container /admin/destroy failed: HTTP 500 nope'
    );
  });
});
