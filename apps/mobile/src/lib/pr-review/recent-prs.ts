import * as SecureStore from 'expo-secure-store';
import { z } from 'zod';

import {
  gitlabInstanceOrigin,
  type ProviderPrPlatform,
  type ProviderPrRef,
} from '@kilocode/app-shared/provider-review';

import { deleteAccountMetadata, writeAccountMetadata } from '@/lib/auth/account-metadata-write';
import { PR_REVIEW_RECENTS_KEY } from '@/lib/storage-keys';

export type RecentPr = {
  owner: string;
  repo: string;
  number: number;
  title: string;
  lastOpenedAt: number;
  /**
   * Outcome of the most recent load attempt. `'failed'` marks an entry
   * whose last open did not produce an authorized payload; `'ok'` (or a
   * missing field on a legacy stored entry) marks a successful load.
   */
  lastResult?: 'ok' | 'failed';
  /**
   * The provider this entry belongs to. Entries stored before the
   * multi-provider recents (s7) carry no platform and read as `'github'` —
   * they were only ever written by the GitHub backfill.
   */
  platform?: ProviderPrPlatform;
  /**
   * GitLab only: the origin of the instance the entry was opened on.
   * Identity/recents only — the server re-derives the authoritative
   * instance (s2), so a stale hint never redirects, it only keeps one row
   * per instance.
   */
  instanceHint?: string;
};

const recentPrSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  number: z.number(),
  title: z.string(),
  lastOpenedAt: z.number(),
  lastResult: z.enum(['ok', 'failed']).optional(),
  platform: z.enum(['github', 'gitlab', 'bitbucket']).optional(),
  instanceHint: z.string().optional(),
});

const RECENT_PR_LIMIT = 10;

/** The identity one recents entry is stored, keyed, removed and marked under. */
export type RecentPrRef = {
  owner: string;
  repo: string;
  number: number;
  platform?: ProviderPrPlatform;
  instanceHint?: string;
};

/**
 * The collision-free recents key: platform, the GitLab instance origin, and
 * the lowercased repository path plus number. The bare `owner/repo#number`
 * triple collided across providers — the same-named repository on GitHub,
 * GitLab and Bitbucket is three separate rows, and one GitLab project on two
 * instances is two rows. GitHub paths keep their existing case-fold so a
 * differently cased paste of the same PR still dedupes.
 */
export function recentPrKey(item: RecentPrRef): string {
  const platform = item.platform ?? 'github';
  const instance = platform === 'gitlab' ? gitlabInstanceOrigin(item.instanceHint) : '';
  return `${platform}|${instance}|${item.owner.toLowerCase()}/${item.repo.toLowerCase()}#${item.number}`;
}

/**
 * The provider ref a recents row navigates with. The entry's writers store
 * the `owner`/`repo`/`number` triple exactly as `providerPrTriple` splits
 * the provider path at its last separator, so folding it back with the
 * platform (legacy entries: GitHub) restores the ref losslessly.
 */
export function providerRefFromRecentPr(entry: RecentPrRef): ProviderPrRef {
  const platform: ProviderPrPlatform = entry.platform ?? 'github';
  if (platform === 'gitlab') {
    return {
      platform: 'gitlab',
      projectPath: `${entry.owner}/${entry.repo}`,
      mrIid: entry.number,
      ...(entry.instanceHint ? { instanceHint: entry.instanceHint } : {}),
    };
  }
  if (platform === 'bitbucket') {
    return {
      platform: 'bitbucket',
      workspace: entry.owner,
      repoSlug: entry.repo,
      prId: entry.number,
    };
  }
  return { platform: 'github', owner: entry.owner, repo: entry.repo, number: entry.number };
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
      if (!result.success) {
        return [];
      }
      // Legacy entries predate `lastResult`; read a missing field as 'ok'
      // so an installed app's existing recents survive the upgrade. A
      // missing `platform` (s7) reads as GitHub, which is the only provider
      // the pre-s7 writers could have stored.
      return [
        { ...result.data, lastResult: result.data.lastResult === 'failed' ? 'failed' : 'ok' },
      ];
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
 * list to the most recent RECENT_PR_LIMIT. This is the only writer that
 * creates an entry: the caller is the authorized backfill that writes the
 * real title on a successful load. The whole entry is replaced (no field
 * merge), so a caller writing `lastResult: 'ok'` clears a previously
 * failed entry.
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

/**
 * Removes one entry by identity. A missing key is a no-op.
 */
export async function removeRecentPr(ref: RecentPrRef): Promise<void> {
  await writeAccountMetadata(PR_REVIEW_RECENTS_KEY, async () => {
    const existingRaw = await SecureStore.getItemAsync(PR_REVIEW_RECENTS_KEY);
    const existing = parseRecents(existingRaw);
    const targetKey = recentPrKey(ref);
    const next = existing.filter(item => recentPrKey(item) !== targetKey);
    await SecureStore.setItemAsync(PR_REVIEW_RECENTS_KEY, toJsonString(next));
  });
}

/**
 * Marks an EXISTING entry as `'failed'`. It never creates an entry — a
 * missing key is a no-op. This is what keeps a never-authorized PR out
 * of recents: only a successful backfill (which writes `'ok'`) can add
 * or clear an entry.
 */
export async function markRecentPrFailed(ref: RecentPrRef): Promise<void> {
  await writeAccountMetadata(PR_REVIEW_RECENTS_KEY, async () => {
    const existingRaw = await SecureStore.getItemAsync(PR_REVIEW_RECENTS_KEY);
    const existing = parseRecents(existingRaw);
    const targetKey = recentPrKey(ref);
    // `existing` is freshly parsed (safe to mutate in place); set the marker
    // only on the matching entry and never create one.
    let found = false;
    for (const item of existing) {
      if (recentPrKey(item) === targetKey) {
        item.lastResult = 'failed';
        found = true;
      }
    }
    if (!found) {
      return;
    }
    await SecureStore.setItemAsync(PR_REVIEW_RECENTS_KEY, toJsonString(existing));
  });
}

export async function clearRecentPrs(): Promise<void> {
  await deleteAccountMetadata(PR_REVIEW_RECENTS_KEY);
}
