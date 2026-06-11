import { HtmlDeployDispatcherClient } from '../html-deploy/dispatcher-client';

type FetchCall = {
  request: Request;
};

function createDispatcher(responseStatus = 200): {
  dispatcher: Fetcher;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  return {
    dispatcher: {
      async fetch(input: RequestInfo | URL): Promise<Response> {
        const request = input instanceof Request ? input : new Request(input);
        calls.push({ request });
        return new Response(null, { status: responseStatus });
      },
      connect() {
        throw new Error('Unexpected dispatcher socket connection');
      },
    },
    calls,
  };
}

describe('HTML deployment dispatcher client', () => {
  it('sets mappings through the canonical dispatcher route', async () => {
    const { dispatcher, calls } = createDispatcher();
    const client = new HtmlDeployDispatcherClient(dispatcher, 'dispatcher-token', 'd.kiloapps.io');

    await expect(client.setSlugMapping('qdpl-worker/name', 'bright-fern-4821')).resolves.toBe(true);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.request.url).toBe('https://d.kiloapps.io/api/slug-mapping/qdpl-worker%2Fname');
    expect(calls[0]?.request.method).toBe('PUT');
    expect(calls[0]?.request.headers.get('Authorization')).toBe('Bearer dispatcher-token');
    expect(await calls[0]?.request.json()).toEqual({ slug: 'bright-fern-4821' });
  });

  it('returns false when a mapping slug is already claimed', async () => {
    const { dispatcher } = createDispatcher(409);
    const client = new HtmlDeployDispatcherClient(dispatcher, 'dispatcher-token', 'd.kiloapps.io');

    await expect(client.setSlugMapping('qdpl-worker', 'bright-fern-4821')).resolves.toBe(false);
  });

  it('deletes mappings through the canonical dispatcher route', async () => {
    const { dispatcher, calls } = createDispatcher();
    const client = new HtmlDeployDispatcherClient(dispatcher, 'dispatcher-token', 'd.kiloapps.io');

    await client.deleteSlugMapping('qdpl-worker/name');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.request.url).toBe('https://d.kiloapps.io/api/slug-mapping/qdpl-worker%2Fname');
    expect(calls[0]?.request.method).toBe('DELETE');
    expect(calls[0]?.request.headers.get('Authorization')).toBe('Bearer dispatcher-token');
  });

  it('fails mapping when the deployed dispatcher does not expose the canonical route', async () => {
    const { dispatcher } = createDispatcher(404);
    const client = new HtmlDeployDispatcherClient(dispatcher, 'dispatcher-token', 'd.kiloapps.io');

    await expect(client.setSlugMapping('qdpl-worker', 'bright-fern-4821')).rejects.toThrow(
      'Failed to set slug mapping: 404'
    );
  });

  it('enables app builder banners through the dispatcher route', async () => {
    const { dispatcher, calls } = createDispatcher();
    const client = new HtmlDeployDispatcherClient(dispatcher, 'dispatcher-token', 'd.kiloapps.io');

    await expect(client.enableBanner('qdpl-worker/name')).resolves.toBeUndefined();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.request.url).toBe(
      'https://d.kiloapps.io/api/app-builder-banner/qdpl-worker%2Fname'
    );
    expect(calls[0]?.request.method).toBe('PUT');
    expect(calls[0]?.request.headers.get('Authorization')).toBe('Bearer dispatcher-token');
  });

  it('disables app builder banners through the dispatcher route', async () => {
    const { dispatcher, calls } = createDispatcher();
    const client = new HtmlDeployDispatcherClient(dispatcher, 'dispatcher-token', 'd.kiloapps.io');

    await expect(client.disableBanner('qdpl-worker/name')).resolves.toBeUndefined();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.request.url).toBe(
      'https://d.kiloapps.io/api/app-builder-banner/qdpl-worker%2Fname'
    );
    expect(calls[0]?.request.method).toBe('DELETE');
    expect(calls[0]?.request.headers.get('Authorization')).toBe('Bearer dispatcher-token');
  });

  it('fails when enabling an app builder banner fails', async () => {
    const { dispatcher } = createDispatcher(503);
    const client = new HtmlDeployDispatcherClient(dispatcher, 'dispatcher-token', 'd.kiloapps.io');

    await expect(client.enableBanner('qdpl-worker')).rejects.toThrow(
      'Failed to enable app builder banner: 503'
    );
  });

  it('fails when disabling an app builder banner fails', async () => {
    const { dispatcher } = createDispatcher(503);
    const client = new HtmlDeployDispatcherClient(dispatcher, 'dispatcher-token', 'd.kiloapps.io');

    await expect(client.disableBanner('qdpl-worker')).rejects.toThrow(
      'Failed to disable app builder banner: 503'
    );
  });
});
