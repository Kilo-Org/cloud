import { describe, test, expect, beforeAll } from '@jest/globals';
import { GET } from './route';
import { NextRequest } from 'next/server';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { insertTestModelStats } from '@/tests/helpers/model-stats.helper';

describe('GET /api/models/stats/[slug]', () => {
  let testModelStat: Awaited<ReturnType<typeof insertTestModelStats>>;

  beforeAll(async () => {
    await insertTestUser();
    testModelStat = await insertTestModelStats({
      slug: 'test-model-slug',
      name: 'Test Model',
      openrouterId: 'openrouter/test-model',
    });
  });

  test('should return model stats for valid slug', async () => {
    const request = new NextRequest(`http://localhost:3000/api/models/stats/${testModelStat.slug}`);
    const response = await GET(request, {
      params: Promise.resolve({ slug: testModelStat.slug! }),
    });

    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.slug).toBe(testModelStat.slug);
    expect(data.id).toBe(testModelStat.id);
  });

  test('should return 404 for non-existent slug', async () => {
    const request = new NextRequest(
      'http://localhost:3000/api/models/stats/non-existent-model-slug-12345'
    );
    const response = await GET(request, {
      params: Promise.resolve({ slug: 'non-existent-model-slug-12345' }),
    });

    expect(response.status).toBe(404);

    const data = await response.json();
    expect(data).toHaveProperty('error');
    expect(data.error).toContain('not found');
  });

  test('should include all expected fields for valid slug', async () => {
    const request = new NextRequest(`http://localhost:3000/api/models/stats/${testModelStat.slug}`);
    const response = await GET(request, {
      params: Promise.resolve({ slug: testModelStat.slug! }),
    });

    const data = await response.json();

    expect(data).toHaveProperty('id');
    expect(data).toHaveProperty('openrouterId');
    expect(data).toHaveProperty('slug');
    expect(data).toHaveProperty('name');
    expect(data).toHaveProperty('isActive');
    expect(data).toHaveProperty('openrouterData');
  });
});
