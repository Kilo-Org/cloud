import { afterEach, describe, expect, test } from '@jest/globals';
import { ai_gateway_config } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { eq } from 'drizzle-orm';
import { isExperimentalByokEnabled } from './experimental-byok';

const enabledOrganizationId = '00000000-0000-4000-8000-000000000001';
const otherOrganizationId = '00000000-0000-4000-8000-000000000002';

describe('isExperimentalByokEnabled', () => {
  afterEach(async () => {
    await db.delete(ai_gateway_config).where(eq(ai_gateway_config.id, 1));
  });

  test('is unavailable when the gateway configuration does not exist', async () => {
    await expect(isExperimentalByokEnabled(enabledOrganizationId)).resolves.toBe(false);
  });

  test('is available only to organizations listed for the feature', async () => {
    await db.insert(ai_gateway_config).values({
      config: { organization_features: { experimental_byok: [enabledOrganizationId] } },
    });

    await expect(isExperimentalByokEnabled(enabledOrganizationId)).resolves.toBe(true);
    await expect(isExperimentalByokEnabled(enabledOrganizationId.toUpperCase())).resolves.toBe(
      true
    );
    await expect(isExperimentalByokEnabled(otherOrganizationId)).resolves.toBe(false);
    await expect(isExperimentalByokEnabled(undefined)).resolves.toBe(false);
  });
});
