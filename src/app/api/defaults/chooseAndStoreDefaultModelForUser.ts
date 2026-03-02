import type { User } from '@kilocode/db/schema';
import { kilocode_users } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { eq } from 'drizzle-orm';
import { DEFAULT_MODEL_CHOICES } from '@/lib/models';
import crypto from 'crypto';

export async function chooseAndStoreDefaultModelForUser(user: User) {
  const defaultModel =
    user.default_model ?? DEFAULT_MODEL_CHOICES[crypto.randomInt(DEFAULT_MODEL_CHOICES.length)];
  if (!user.default_model) {
    await db
      .update(kilocode_users)
      .set({ default_model: defaultModel })
      .where(eq(kilocode_users.id, user.id))
      .execute();
  }
  return defaultModel;
}
