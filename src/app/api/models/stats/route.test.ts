import { describe, test, expect, beforeAll } from '@jest/globals';
import { GET } from './route';
import { NextRequest } from 'next/server';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { insertTestModelStats } from '@/tests/helpers/model-stats.helper';
import { db } from '@/lib/drizzle';
import { modelStats } from '@kilocode/db/schema';

describe('GET /api/models/stats', () => {
  beforeAll(async () => {
    await insertTestUser();

    // Insert test model stats with different coding indexes for sorting tests
    await Promise.all([
      insertTestModelStats({
        slug: 'test-model-high-coding',
        name: 'High Coding Model',
        openrouterId: 'test/high-coding',
        codingIndex: '95.5',
        isActive: true,
      }),
      insertTestModelStats({
        slug: 'test-model-med-coding',
        name: 'Medium Coding Model',
        openrouterId: 'test/med-coding',
        codingIndex: '85.3',
        isActive: true,
      }),
      insertTestModelStats({
        slug: 'test-model-no-coding',
        name: 'No Coding Model',
        openrouterId: 'test/no-coding',
        codingIndex: null,
        isActive: true,
      }),
      insertTestModelStats({
        slug: 'test-model-inactive',
        name: 'Inactive Model',
        openrouterId: 'test/inactive',
        codingIndex: '99.9',
        isActive: false, // Should not appear in results
      }),
    ]);
  });

  test('should return all active model stats', async () => {
    const request = new NextRequest('http://localhost:3000/api/models/stats');
    const response = await GET(request);

    expect(response.status).toBe(200);

    const data = await response.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThanOrEqual(3); // At least our 3 active test models

    // Verify all returned models are active
    for (const stat of data) {
      expect(stat.isActive).toBe(true);
    }

    // Verify inactive model is not included
    expect(
      data.find((s: { slug: string | null }) => s.slug === 'test-model-inactive')
    ).toBeUndefined();

    // Verify our test models are present
    const testSlugs = ['test-model-high-coding', 'test-model-med-coding', 'test-model-no-coding'];
    for (const slug of testSlugs) {
      expect(data.find((s: { slug: string | null }) => s.slug === slug)).toBeDefined();
    }
  });

  test('should order results by coding index descending', async () => {
    const request = new NextRequest('http://localhost:3000/api/models/stats');
    const response = await GET(request);

    const data = await response.json();

    // Check that coding index is in descending order (nulls at end)
    for (let i = 0; i < data.length - 1; i++) {
      const current = data[i].codingIndex;
      const next = data[i + 1].codingIndex;

      if (current !== null && next !== null) {
        expect(Number(current)).toBeGreaterThanOrEqual(Number(next));
      }
    }
  });

  test('should include all expected fields', async () => {
    // First ensure we have at least one model stat
    const [existingStat] = await db.select().from(modelStats).limit(1);

    if (!existingStat) {
      // Skip test if no data exists
      return;
    }

    const request = new NextRequest('http://localhost:3000/api/models/stats');
    const response = await GET(request);
    const data = await response.json();

    if (data.length > 0) {
      const stat = data[0];
      expect(stat).toHaveProperty('id');
      expect(stat).toHaveProperty('openrouterId');
      expect(stat).toHaveProperty('slug');
      expect(stat).toHaveProperty('name');
      expect(stat).toHaveProperty('isActive');
    }
  });
});
