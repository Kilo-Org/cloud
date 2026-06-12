import { GET } from './route';

describe('GET /api/marketing-tags/impact', () => {
  const originalImpactUttId = process.env.NEXT_PUBLIC_IMPACT_UTT_ID;

  afterEach(() => {
    if (originalImpactUttId === undefined) {
      delete process.env.NEXT_PUBLIC_IMPACT_UTT_ID;
    } else {
      process.env.NEXT_PUBLIC_IMPACT_UTT_ID = originalImpactUttId;
    }
  });

  it('returns the Impact UTT bootstrap script when the public UTT id is configured', async () => {
    process.env.NEXT_PUBLIC_IMPACT_UTT_ID = 'A-KILO-PASS-UTT';

    const response = GET();

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/javascript; charset=utf-8');
    const script = await response.text();
    expect(script).toContain('utt.impactcdn.com');
    expect(script).toContain('A-KILO-PASS-UTT');
  });

  it('does not serve an Impact UTT script when the public UTT id is unconfigured', () => {
    delete process.env.NEXT_PUBLIC_IMPACT_UTT_ID;

    const response = GET();

    expect(response.status).toBe(404);
  });
});
