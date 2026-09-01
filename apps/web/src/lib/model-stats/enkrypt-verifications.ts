import 'server-only';

import { createCachedFetch } from '@/lib/cached-fetch';
import { ENKRYPT_PUBLICATION_ENABLED } from '@/lib/config.server';
import { db } from '@/lib/drizzle';
import { enkrypt_sync_state } from '@kilocode/db/schema';
import { EnkryptVerificationSchema, type EnkryptVerifications } from '@kilocode/db/schema-types';
import { eq } from 'drizzle-orm';
import * as z from 'zod';

const VerificationEntriesSchema = z.record(z.string(), z.unknown());

async function loadEnkryptVerifications(): Promise<EnkryptVerifications> {
  const [row] = await db
    .select({ verified_models: enkrypt_sync_state.verified_models })
    .from(enkrypt_sync_state)
    .where(eq(enkrypt_sync_state.job_name, 'enkrypt'));
  const entries = VerificationEntriesSchema.safeParse(row?.verified_models);
  if (!entries.success) return {};
  return Object.fromEntries(
    Object.entries(entries.data).flatMap(([id, value]) => {
      const result = EnkryptVerificationSchema.safeParse(value);
      return id && result.success ? [[id, result.data]] : [];
    })
  );
}

const getCachedEnkryptVerifications = createCachedFetch(
  loadEnkryptVerifications,
  5 * 60 * 1000,
  {}
);
let pending: Promise<EnkryptVerifications> | undefined;

export async function getEnkryptVerifications(): Promise<EnkryptVerifications> {
  if (!ENKRYPT_PUBLICATION_ENABLED) return {};
  pending ??= getCachedEnkryptVerifications().finally(() => {
    pending = undefined;
  });
  return pending;
}
