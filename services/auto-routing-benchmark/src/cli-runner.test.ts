import { describe, expect, it, vi } from 'vitest';
import { destroyDeciderCliContainer } from './cli-runner';

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
