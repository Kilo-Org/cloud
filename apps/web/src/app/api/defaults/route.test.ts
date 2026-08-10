import { GET, revalidate } from './route';
import { KILO_AUTO_BALANCED_MODEL, KILO_AUTO_FREE_MODEL } from '@/lib/ai-gateway/auto-model';

describe('GET /api/defaults', () => {
  it('exports revalidate interval', () => {
    expect(revalidate).toBe(3600);
  });

  it('returns default models', async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({
      defaultModel: KILO_AUTO_BALANCED_MODEL.id,
      defaultFreeModel: KILO_AUTO_FREE_MODEL.id,
    });
  });
});
