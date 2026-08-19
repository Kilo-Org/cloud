import * as SecureStore from 'expo-secure-store';
import { z } from 'zod';

import { deleteAccountMetadata, writeAccountMetadata } from '@/lib/auth/account-metadata-write';
import { PR_REVIEW_RECENTS_KEY } from '@/lib/storage-keys';

export type RecentPr = {
  owner: string;
  repo: string;
  number: number;
  title: string;
  lastOpenedAt: number;
};

const recentPrSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  number: z.number(),
  title: z.string(),
  lastOpenedAt: z.number(),
});

const RECENT_PR_LIMIT = 10;

function recentPrKey(item: RecentPr): string {
  return `${item.owner.toLowerCase()}/${item.repo.toLowerCase()}#${item.number}`;
}

function parseRecents(raw: string | null): RecentPr[] {
  if (raw == null || raw.length === 0) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.flatMap((entry): RecentPr[] => {
      const result = recentPrSchema.safeParse(entry);
      return result.success ? [result.data] : [];
    });
  } catch {
    return [];
  }
}

function toJsonString(recents: RecentPr[]): string {
  // Stable shape — ensure order survives a round trip without any implicit
  // normalization that could drop the newest entry on a partial write.
  return JSON.stringify(recents);
}

export async function getRecentPrs(): Promise<RecentPr[]> {
  const raw = await SecureStore.getItemAsync(PR_REVIEW_RECENTS_KEY);
  return parseRecents(raw);
}

/**
 * Inserts/updates a recent PR entry, moves it to the front, and trims the
 * list to the most recent RECENT_PR_LIMIT. The title is taken from the
 * caller (which may be the user-typed URL before the PR loads, or a
 * later load-time fetch that backfills the title) — the function never
 * reads or overwrites the title from disk on its own.
 */
export async function upsertRecentPr(entry: RecentPr): Promise<void> {
  await writeAccountMetadata(PR_REVIEW_RECENTS_KEY, async () => {
    const existingRaw = await SecureStore.getItemAsync(PR_REVIEW_RECENTS_KEY);
    const existing = parseRecents(existingRaw);
    const incomingKey = recentPrKey(entry);
    const filtered = existing.filter(item => recentPrKey(item) !== incomingKey);
    const next = [entry, ...filtered].slice(0, RECENT_PR_LIMIT);
    await SecureStore.setItemAsync(PR_REVIEW_RECENTS_KEY, toJsonString(next));
  });
}

export async function clearRecentPrs(): Promise<void> {
  await deleteAccountMetadata(PR_REVIEW_RECENTS_KEY);
}
