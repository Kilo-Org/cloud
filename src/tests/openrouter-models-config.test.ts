import { test, expect, describe } from '@jest/globals';
import { chooseAndStoreDefaultModelForUser } from '@/app/api/defaults/chooseAndStoreDefaultModelForUser';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { db } from '@/lib/drizzle';
import { kilocode_users } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { DEFAULT_MODEL_CHOICES, preferredModels } from '@/lib/models';

function validateDefaultModelInPreferred(): void {
  for (const defaultModel of DEFAULT_MODEL_CHOICES) {
    if (!preferredModels.includes(defaultModel)) {
      throw new Error(`Default model '${defaultModel}' is not in preferred models list`);
    }
  }
}

describe('OpenRouter Models Config', () => {
  test('validateDefaultModelInPreferred should not throw when default model is in preferred models', () => {
    expect(() => validateDefaultModelInPreferred()).not.toThrow();
  });

  test('preferred models should contain expected models', () => {
    const expectedModels = [
      'google/gemini-3.1-pro-preview',
      'google/gemini-3.1-pro-preview',
      'anthropic/claude-sonnet-4.6',
      'openai/gpt-5.2',
    ];

    expectedModels.forEach(model => {
      expect(preferredModels).toContain(model);
    });
  });

  test('chooseAndStoreDefaultModelForUser with non-null user should set its default model', async () => {
    const user = await insertTestUser();

    const chosenDefaultModel = await chooseAndStoreDefaultModelForUser(user);
    const storedDefaultModel = await db
      .select({ defaultModel: kilocode_users.default_model })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, user.id))
      .execute();

    expect(DEFAULT_MODEL_CHOICES).toContain(chosenDefaultModel);
    expect(DEFAULT_MODEL_CHOICES).toContain(storedDefaultModel[0].defaultModel);
  });
});
