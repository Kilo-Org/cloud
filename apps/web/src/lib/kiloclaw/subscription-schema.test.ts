import { beforeEach, describe, expect, it } from '@jest/globals';
import { cleanupDbForTest, db, sql } from '@/lib/drizzle';

describe('KiloClaw subscription schema', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
  });

  it('requires raw SQL subscription inserts to set kiloclaw_price_version explicitly', async () => {
    await db.execute(sql`
      INSERT INTO kilocode_users (
        id,
        google_user_email,
        google_user_name,
        google_user_image_url,
        stripe_customer_id
      ) VALUES (
        'price-version-required-user',
        'price-version-required@example.com',
        'Price Version Required',
        'https://example.com/avatar.png',
        'cus_price_version_required'
      )
    `);

    await expect(
      db.execute(sql`
        INSERT INTO kiloclaw_subscriptions (
          user_id,
          plan,
          status
        ) VALUES (
          'price-version-required-user',
          'trial',
          'trialing'
        )
      `)
    ).rejects.toMatchObject({
      cause: expect.objectContaining({
        code: '23502',
        column: 'kiloclaw_price_version',
      }),
    });
  });

  it('rejects unknown raw SQL kiloclaw_price_version values', async () => {
    await db.execute(sql`
      INSERT INTO kilocode_users (
        id,
        google_user_email,
        google_user_name,
        google_user_image_url,
        stripe_customer_id
      ) VALUES (
        'price-version-invalid-user',
        'price-version-invalid@example.com',
        'Price Version Invalid',
        'https://example.com/avatar.png',
        'cus_price_version_invalid'
      )
    `);

    let caught: unknown;
    try {
      await db.execute(sql`
        INSERT INTO kiloclaw_subscriptions (
          user_id,
          kiloclaw_price_version,
          plan,
          status
        ) VALUES (
          'price-version-invalid-user',
          '2026_05_10',
          'trial',
          'trialing'
        )
      `);
    } catch (error) {
      caught = error;
    }

    const cause = (caught as { cause?: { code?: string; constraint?: string } }).cause;
    expect(cause?.code).toBe('23514');
    expect(cause?.constraint).toBe('kiloclaw_subscriptions_price_version_check');
  });
});
