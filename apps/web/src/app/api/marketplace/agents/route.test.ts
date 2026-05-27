import type { NextRequest } from 'next/server';
import { GET } from './route';

const fetchMock = jest.fn();
const originalFetch = global.fetch;

describe('/api/marketplace/agents', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as typeof fetch;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it('passes through generated agents marketplace YAML', async () => {
    const marketplaceYaml = 'items:\n  - id: architect\n    name: Architect\n';

    fetchMock.mockResolvedValueOnce(new Response(marketplaceYaml, { status: 200 }));

    const response = await GET({} as NextRequest);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://raw.githubusercontent.com/Kilo-Org/kilo-marketplace/main/agents/marketplace.yaml'
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/x-yaml');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=3600, s-maxage=3600');
    expect(await response.text()).toBe(marketplaceYaml);
  });

  it('returns empty YAML with the upstream status when GitHub fetch fails', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(
      new Response('not found', { status: 404, statusText: 'Not Found' })
    );

    const response = await GET({} as NextRequest);

    expect(response.status).toBe(404);
    expect(response.headers.get('Content-Type')).toBe('application/x-yaml');
    expect(await response.text()).toBe('items: []\n');
  });
});
