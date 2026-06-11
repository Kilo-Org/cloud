import { api } from './api';

const ROUTES = ['/slug-mapping/qdpl-worker', '/quick-deploy-slug-mapping/qdpl-worker'];
const BANNER_PATH = '/app-builder-banner/qdpl-worker';

class MemoryKv {
  private readonly values = new Map<string, string>();
  private readonly failures: Set<string>;
  private readonly afterDelete?: (key: string, kv: MemoryKv) => void;
  readonly operations: string[] = [];

  constructor(
    initial?: Record<string, string>,
    failures?: string[],
    afterDelete?: (key: string, kv: MemoryKv) => void
  ) {
    for (const [key, value] of Object.entries(initial ?? {})) {
      this.values.set(key, value);
    }
    this.failures = new Set(failures);
    this.afterDelete = afterDelete;
  }

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    const operation = `put:${key}`;
    this.operations.push(operation);
    this.failOnce(operation);
    this.values.set(key, value);
    this.failOnce(`after:${operation}`);
  }

  async delete(key: string): Promise<void> {
    const operation = `delete:${key}`;
    this.operations.push(operation);
    this.failOnce(operation);
    this.values.delete(key);
    this.afterDelete?.(key, this);
    this.failOnce(`after:${operation}`);
  }

  set(key: string, value: string): void {
    this.values.set(key, value);
  }

  snapshot(): Record<string, string> {
    return Object.fromEntries(this.values);
  }

  private failOnce(operation: string): void {
    if (this.failures.delete(operation)) {
      throw new Error(`Injected KV failure: ${operation}`);
    }
  }
}

function createEnv(deployKv: MemoryKv) {
  return {
    BACKEND_AUTH_TOKEN: 'dispatcher-token',
    DEPLOY_KV: deployKv,
  } as never;
}

function authorizedRequest(path: string, init?: RequestInit): Request {
  return new Request(`https://d.kiloapps.io${path}`, {
    ...init,
    headers: {
      Authorization: 'Bearer dispatcher-token',
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });
}

function putRequest(path: string, slug: string): Request {
  return authorizedRequest(path, {
    method: 'PUT',
    body: JSON.stringify({ slug }),
  });
}

describe.each(ROUTES)('dispatcher slug mapping API route %s', path => {
  it('writes mappings in both directions on authenticated PUT', async () => {
    const deployKv = new MemoryKv();

    const response = await api.fetch(putRequest(path, 'bright-fern-4821'), createEnv(deployKv));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true });
    expect(deployKv.operations).toEqual([
      'put:worker2slug:qdpl-worker',
      'put:slug2worker:bright-fern-4821',
    ]);
    await expect(deployKv.get('slug2worker:bright-fern-4821')).resolves.toBe('qdpl-worker');
    await expect(deployKv.get('worker2slug:qdpl-worker')).resolves.toBe('bright-fern-4821');
  });

  it('returns 409 without changing mappings when another worker owns the slug', async () => {
    const deployKv = new MemoryKv({
      'slug2worker:bright-fern-4821': 'qdpl-existing',
      'worker2slug:qdpl-existing': 'bright-fern-4821',
    });

    const response = await api.fetch(putRequest(path, 'bright-fern-4821'), createEnv(deployKv));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: 'This subdomain is already taken' });
    await expect(deployKv.get('slug2worker:bright-fern-4821')).resolves.toBe('qdpl-existing');
    await expect(deployKv.get('worker2slug:qdpl-existing')).resolves.toBe('bright-fern-4821');
    await expect(deployKv.get('worker2slug:qdpl-worker')).resolves.toBeNull();
  });

  it('removes the old forward mapping during remap when the worker still owns it', async () => {
    const deployKv = new MemoryKv({
      'slug2worker:old-meadow-0001': 'qdpl-worker',
      'worker2slug:qdpl-worker': 'old-meadow-0001',
    });

    const response = await api.fetch(putRequest(path, 'new-meadow-0002'), createEnv(deployKv));

    expect(response.status).toBe(200);
    expect(deployKv.operations).toEqual([
      'put:slug2worker:new-meadow-0002',
      'delete:slug2worker:old-meadow-0001',
      'put:worker2slug:qdpl-worker',
    ]);
    await expect(deployKv.get('slug2worker:old-meadow-0001')).resolves.toBeNull();
    await expect(deployKv.get('slug2worker:new-meadow-0002')).resolves.toBe('qdpl-worker');
    await expect(deployKv.get('worker2slug:qdpl-worker')).resolves.toBe('new-meadow-0002');
  });

  it('does not leave a fresh alias unreachable by worker-keyed DELETE when reverse PUT fails', async () => {
    const deployKv = new MemoryKv(undefined, ['after:put:worker2slug:qdpl-worker']);

    const failedResponse = await api.fetch(
      putRequest(path, 'bright-fern-4821'),
      createEnv(deployKv)
    );
    expect(failedResponse.status).toBe(500);

    const deleteResponse = await api.fetch(
      authorizedRequest(path, { method: 'DELETE' }),
      createEnv(deployKv)
    );

    expect(deleteResponse.status).toBe(200);
    expect(deployKv.snapshot()).toEqual({});
  });

  it('preserves a pre-existing same-worker alias when fresh mapping fails', async () => {
    const deployKv = new MemoryKv({ 'slug2worker:bright-fern-4821': 'qdpl-worker' }, [
      'after:put:slug2worker:bright-fern-4821',
    ]);

    const failedResponse = await api.fetch(
      putRequest(path, 'bright-fern-4821'),
      createEnv(deployKv)
    );

    expect(failedResponse.status).toBe(500);
    expect(deployKv.snapshot()).toEqual({
      'slug2worker:bright-fern-4821': 'qdpl-worker',
      'worker2slug:qdpl-worker': 'bright-fern-4821',
    });
  });

  it('retains a reverse cleanup handle when fresh forward compensation fails', async () => {
    const deployKv = new MemoryKv(undefined, [
      'after:put:slug2worker:bright-fern-4821',
      'delete:slug2worker:bright-fern-4821',
    ]);

    const failedResponse = await api.fetch(
      putRequest(path, 'bright-fern-4821'),
      createEnv(deployKv)
    );

    expect(failedResponse.status).toBe(500);
    expect(deployKv.snapshot()).toEqual({
      'slug2worker:bright-fern-4821': 'qdpl-worker',
      'worker2slug:qdpl-worker': 'bright-fern-4821',
    });

    const deleteResponse = await api.fetch(
      authorizedRequest(path, { method: 'DELETE' }),
      createEnv(deployKv)
    );

    expect(deleteResponse.status).toBe(200);
    expect(deployKv.snapshot()).toEqual({});
  });

  it.each([
    'put:slug2worker:new-meadow-0002',
    'delete:slug2worker:old-meadow-0001',
    'after:delete:slug2worker:old-meadow-0001',
    'put:worker2slug:qdpl-worker',
    'after:put:worker2slug:qdpl-worker',
  ])(
    'restores reciprocal state and converges after retry when remap mutation %s fails once',
    async failedOperation => {
      const deployKv = new MemoryKv(
        {
          'slug2worker:old-meadow-0001': 'qdpl-worker',
          'worker2slug:qdpl-worker': 'old-meadow-0001',
        },
        [failedOperation]
      );

      const failedResponse = await api.fetch(
        putRequest(path, 'new-meadow-0002'),
        createEnv(deployKv)
      );
      expect(failedResponse.status).toBe(500);
      expect(deployKv.snapshot()).toEqual({
        'slug2worker:old-meadow-0001': 'qdpl-worker',
        'worker2slug:qdpl-worker': 'old-meadow-0001',
      });

      const retryResponse = await api.fetch(
        putRequest(path, 'new-meadow-0002'),
        createEnv(deployKv)
      );

      expect(retryResponse.status).toBe(200);
      expect(deployKv.snapshot()).toEqual({
        'slug2worker:new-meadow-0002': 'qdpl-worker',
        'worker2slug:qdpl-worker': 'new-meadow-0002',
      });
    }
  );

  it('attempts independent remap compensation after removing the new alias fails', async () => {
    const deployKv = new MemoryKv(
      {
        'slug2worker:old-meadow-0001': 'qdpl-worker',
        'worker2slug:qdpl-worker': 'old-meadow-0001',
      },
      ['after:put:worker2slug:qdpl-worker', 'delete:slug2worker:new-meadow-0002']
    );

    const failedResponse = await api.fetch(
      putRequest(path, 'new-meadow-0002'),
      createEnv(deployKv)
    );

    expect(failedResponse.status).toBe(500);
    expect(deployKv.snapshot()).toEqual({
      'slug2worker:old-meadow-0001': 'qdpl-worker',
      'slug2worker:new-meadow-0002': 'qdpl-worker',
      'worker2slug:qdpl-worker': 'old-meadow-0001',
    });
  });

  it('preserves a pre-existing same-worker alias when remap compensation restores the old mapping', async () => {
    const deployKv = new MemoryKv(
      {
        'slug2worker:old-meadow-0001': 'qdpl-worker',
        'slug2worker:new-meadow-0002': 'qdpl-worker',
        'worker2slug:qdpl-worker': 'old-meadow-0001',
      },
      ['after:put:worker2slug:qdpl-worker']
    );

    const failedResponse = await api.fetch(
      putRequest(path, 'new-meadow-0002'),
      createEnv(deployKv)
    );

    expect(failedResponse.status).toBe(500);
    expect(deployKv.snapshot()).toEqual({
      'slug2worker:old-meadow-0001': 'qdpl-worker',
      'slug2worker:new-meadow-0002': 'qdpl-worker',
      'worker2slug:qdpl-worker': 'old-meadow-0001',
    });
  });

  it('preserves another worker forward claim during remap', async () => {
    const deployKv = new MemoryKv({
      'slug2worker:old-meadow-0001': 'qdpl-later-owner',
      'worker2slug:qdpl-worker': 'old-meadow-0001',
    });

    const response = await api.fetch(putRequest(path, 'new-meadow-0002'), createEnv(deployKv));

    expect(response.status).toBe(200);
    await expect(deployKv.get('slug2worker:old-meadow-0001')).resolves.toBe('qdpl-later-owner');
    await expect(deployKv.get('slug2worker:new-meadow-0002')).resolves.toBe('qdpl-worker');
    await expect(deployKv.get('worker2slug:qdpl-worker')).resolves.toBe('new-meadow-0002');
  });

  it('rejects unauthenticated DELETE without changing mappings', async () => {
    const deployKv = new MemoryKv({
      'slug2worker:bright-fern-4821': 'qdpl-worker',
      'worker2slug:qdpl-worker': 'bright-fern-4821',
    });

    const response = await api.fetch(
      new Request(`https://d.kiloapps.io${path}`, { method: 'DELETE' }),
      createEnv(deployKv)
    );

    expect(response.status).toBe(401);
    await expect(deployKv.get('slug2worker:bright-fern-4821')).resolves.toBe('qdpl-worker');
    await expect(deployKv.get('worker2slug:qdpl-worker')).resolves.toBe('bright-fern-4821');
  });

  it('removes mappings in both directions on authenticated DELETE', async () => {
    const deployKv = new MemoryKv({
      'slug2worker:bright-fern-4821': 'qdpl-worker',
      'worker2slug:qdpl-worker': 'bright-fern-4821',
    });

    const response = await api.fetch(
      authorizedRequest(path, { method: 'DELETE' }),
      createEnv(deployKv)
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true });
    await expect(deployKv.get('slug2worker:bright-fern-4821')).resolves.toBeNull();
    await expect(deployKv.get('worker2slug:qdpl-worker')).resolves.toBeNull();
  });

  it('preserves another worker forward claim during DELETE', async () => {
    const deployKv = new MemoryKv({
      'slug2worker:bright-fern-4821': 'qdpl-later-owner',
      'worker2slug:qdpl-worker': 'bright-fern-4821',
    });

    const response = await api.fetch(
      authorizedRequest(path, { method: 'DELETE' }),
      createEnv(deployKv)
    );

    expect(response.status).toBe(200);
    await expect(deployKv.get('slug2worker:bright-fern-4821')).resolves.toBe('qdpl-later-owner');
    await expect(deployKv.get('worker2slug:qdpl-worker')).resolves.toBeNull();
  });

  it('preserves a concurrent reverse remap during DELETE', async () => {
    const deployKv = new MemoryKv(
      {
        'slug2worker:bright-fern-4821': 'qdpl-worker',
        'worker2slug:qdpl-worker': 'bright-fern-4821',
      },
      undefined,
      (key, kv) => {
        if (key === 'slug2worker:bright-fern-4821') {
          kv.set('worker2slug:qdpl-worker', 'new-meadow-0002');
        }
      }
    );

    const response = await api.fetch(
      authorizedRequest(path, { method: 'DELETE' }),
      createEnv(deployKv)
    );

    expect(response.status).toBe(200);
    await expect(deployKv.get('slug2worker:bright-fern-4821')).resolves.toBeNull();
    await expect(deployKv.get('worker2slug:qdpl-worker')).resolves.toBe('new-meadow-0002');
  });

  it.each([
    'delete:slug2worker:bright-fern-4821',
    'after:delete:slug2worker:bright-fern-4821',
    'delete:worker2slug:qdpl-worker',
    'after:delete:worker2slug:qdpl-worker',
  ])('converges after retry when DELETE mutation %s fails once', async failedOperation => {
    const deployKv = new MemoryKv(
      {
        'slug2worker:bright-fern-4821': 'qdpl-worker',
        'worker2slug:qdpl-worker': 'bright-fern-4821',
      },
      [failedOperation]
    );

    const failedResponse = await api.fetch(
      authorizedRequest(path, { method: 'DELETE' }),
      createEnv(deployKv)
    );
    expect(failedResponse.status).toBe(500);

    const retryResponse = await api.fetch(
      authorizedRequest(path, { method: 'DELETE' }),
      createEnv(deployKv)
    );

    expect(retryResponse.status).toBe(200);
    expect(deployKv.snapshot()).toEqual({});
  });
});

describe('dispatcher slug mapping API route auth', () => {
  it.each(ROUTES)('rejects unauthenticated PUT %s before writing KV', async path => {
    const deployKv = new MemoryKv();

    const response = await api.fetch(
      new Request(`https://d.kiloapps.io${path}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: 'bright-fern-4821' }),
      }),
      createEnv(deployKv)
    );

    expect(response.status).toBe(401);
    await expect(deployKv.get('slug2worker:bright-fern-4821')).resolves.toBeNull();
    await expect(deployKv.get('worker2slug:qdpl-worker')).resolves.toBeNull();
  });
});

describe('dispatcher app builder banner API route', () => {
  it('writes the banner key on authenticated PUT and reports it enabled', async () => {
    const deployKv = new MemoryKv();

    const putResponse = await api.fetch(
      authorizedRequest(BANNER_PATH, { method: 'PUT' }),
      createEnv(deployKv)
    );
    const getResponse = await api.fetch(authorizedRequest(BANNER_PATH), createEnv(deployKv));

    expect(putResponse.status).toBe(200);
    await expect(putResponse.json()).resolves.toEqual({ success: true });
    await expect(deployKv.get('app-builder-banner:qdpl-worker')).resolves.toBe('1');
    expect(getResponse.status).toBe(200);
    await expect(getResponse.json()).resolves.toEqual({ enabled: true });
  });

  it('removes the banner key on authenticated DELETE', async () => {
    const deployKv = new MemoryKv({ 'app-builder-banner:qdpl-worker': '1' });

    const response = await api.fetch(
      authorizedRequest(BANNER_PATH, { method: 'DELETE' }),
      createEnv(deployKv)
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true });
    await expect(deployKv.get('app-builder-banner:qdpl-worker')).resolves.toBeNull();
  });

  it('leaves the banner key untouched when deleting a slug mapping', async () => {
    const deployKv = new MemoryKv({
      'app-builder-banner:qdpl-worker': '1',
      'slug2worker:bright-fern-4821': 'qdpl-worker',
      'worker2slug:qdpl-worker': 'bright-fern-4821',
    });

    const response = await api.fetch(
      authorizedRequest('/slug-mapping/qdpl-worker', { method: 'DELETE' }),
      createEnv(deployKv)
    );

    expect(response.status).toBe(200);
    await expect(deployKv.get('app-builder-banner:qdpl-worker')).resolves.toBe('1');
  });

  it.each(['PUT', 'DELETE'])('rejects unauthenticated %s before mutating KV', async method => {
    const deployKv = new MemoryKv({ 'app-builder-banner:qdpl-worker': '1' });

    const response = await api.fetch(
      new Request(`https://d.kiloapps.io${BANNER_PATH}`, { method }),
      createEnv(deployKv)
    );

    expect(response.status).toBe(401);
    expect(deployKv.operations).toEqual([]);
    await expect(deployKv.get('app-builder-banner:qdpl-worker')).resolves.toBe('1');
  });
});
