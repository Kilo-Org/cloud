import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function repoFile(path: string): string {
  return readFileSync(join(process.cwd(), '..', '..', path), 'utf8');
}

describe('KiloClaw price rollout configuration examples', () => {
  it('distinguishes legacy recognized Stripe price IDs from current checkout price IDs', () => {
    const examples = [
      repoFile('.env.local.example'),
      repoFile('apps/web/.env.development.local.example'),
    ];

    for (const envExample of examples) {
      expect(envExample).toContain(
        'STRIPE_KILOCLAW_2026_03_19_STANDARD_INTRO_PRICE_ID=price_test_kiloclaw_2026_03_19_standard_intro'
      );
      expect(envExample).toContain(
        'STRIPE_KILOCLAW_2026_03_19_STANDARD_PRICE_ID=price_test_kiloclaw_2026_03_19_standard'
      );
      expect(envExample).toContain(
        'STRIPE_KILOCLAW_2026_03_19_COMMIT_PRICE_ID=price_test_kiloclaw_2026_03_19_commit'
      );
      expect(envExample).toContain(
        'STRIPE_KILOCLAW_2026_05_10_STANDARD_PRICE_ID=price_test_kiloclaw_2026_05_10_standard'
      );
      expect(envExample).toContain(
        'STRIPE_KILOCLAW_2026_05_10_COMMIT_PRICE_ID=price_test_kiloclaw_2026_05_10_commit'
      );
      expect(envExample).not.toContain('STRIPE_KILOCLAW_STANDARD_FIRST_MONTH_COUPON_ID');
      expect(envExample).not.toContain('STRIPE_KILOCLAW_2026_05_10_STANDARD_INTRO_PRICE_ID');
    }
  });

  it('removes stale coupon and current intro requirements from committed test config', () => {
    const webTestEnv = repoFile('apps/web/.env.test');

    expect(webTestEnv).toContain(
      'STRIPE_KILOCLAW_2026_05_10_STANDARD_PRICE_ID=price_test_kiloclaw_2026_05_10_standard'
    );
    expect(webTestEnv).toContain(
      'STRIPE_KILOCLAW_2026_05_10_COMMIT_PRICE_ID=price_test_kiloclaw_2026_05_10_commit'
    );
    expect(webTestEnv).not.toContain('STRIPE_KILOCLAW_STANDARD_FIRST_MONTH_COUPON_ID');
    expect(webTestEnv).not.toContain('STRIPE_KILOCLAW_2026_05_10_STANDARD_INTRO_PRICE_ID');
  });

  it('exposes required Stripe recognition and repair price IDs to the KiloClaw billing Worker', () => {
    const workerDevVars = repoFile('services/kiloclaw-billing/.dev.vars.example');
    const workerWranglerConfig = repoFile('services/kiloclaw-billing/wrangler.jsonc');

    for (const config of [workerDevVars, workerWranglerConfig]) {
      expect(config).toContain('STRIPE_KILOCLAW_2026_03_19_STANDARD_INTRO_PRICE_ID');
      expect(config).toContain('STRIPE_KILOCLAW_2026_03_19_STANDARD_PRICE_ID');
      expect(config).toContain('STRIPE_KILOCLAW_2026_03_19_COMMIT_PRICE_ID');
      expect(config).toContain('STRIPE_KILOCLAW_2026_05_10_STANDARD_PRICE_ID');
      expect(config).toContain('STRIPE_KILOCLAW_2026_05_10_COMMIT_PRICE_ID');
      expect(config).not.toContain('STRIPE_KILOCLAW_STANDARD_FIRST_MONTH_COUPON_ID');
      expect(config).not.toContain('STRIPE_KILOCLAW_2026_05_10_STANDARD_INTRO_PRICE_ID');
    }
  });
});
