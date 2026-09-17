// Headless runtime for the `StartAgent` action.
//
// `start-agent.ts` is shared with the in-app creators, so its own module graph
// must stay free of native code. Everything the action path resolves for
// itself — the stored model preference, the model catalogue, the last
// worked-in repository, the signed-in user, and the persisted safe-retry
// outbox — lives here and is loaded lazily from `startAgent`, so the in-app
// hooks never pull expo-secure-store, expo-constants or the encrypted
// SQLCipher outbox into their React tree (the same lazy-import rule as
// `session-attention.ts`).

import * as Crypto from 'expo-crypto';

import { detectRepositoryPlatform } from '@/components/agents/new-session-repository-state';
import { formatGitUrlProject } from '@/components/agents/session-list-helpers';
import { type ParsedActionRepository } from '@/lib/app-actions/app-action-contract';
import { readStoredValue } from '@/lib/auth/secure-store-value';
import { getAuthTokenForRequest } from '@/lib/auth/token-owner';
import { API_BASE_URL } from '@/lib/config';
import {
  type ModelOption,
  OpenRouterModelsResponseSchema,
  toModelOptions,
} from '@/lib/hooks/use-available-models';
import {
  listOutboxRows,
  type OutboxRow,
  removeOutboxRow as removeStoredOutboxRow,
  writeOutboxRow,
} from '@/lib/persist/mutation-outbox';
import { AGENT_MODEL_PREFERENCE_KEY } from '@/lib/storage-keys';
import { trpcClient } from '@/lib/trpc';

/** How far back the "most recent repository" lookup searches, in days. */
const RECENT_REPOSITORY_DAYS = 30;

/**
 * The headless runtime `start-agent.ts` loads lazily: the pieces of a
 * `StartAgent` run that need a device — secure storage, the encrypted outbox,
 * the authenticated HTTP catalogue. Declared here so the action module can
 * type its own `deps` without a static import of this file's native graph.
 */
export type StartAgentRuntime = {
  mostRecentRepository: () => Promise<ParsedActionRepository | null>;
  storedModelPreferenceRaw: () => Promise<string | null>;
  modelCatalog: () => Promise<ModelOption[] | null>;
  currentUserId: () => Promise<string | null>;
  getKey: (fingerprint: string) => string;
  rotateKey: () => void;
  createOutbox: (userId: string) => StartAgentOutbox;
};

/**
 * The persisted safe-retry outbox as `prepareAgentSession` needs it. Same
 * shape as `useMutationOutbox`'s key/reuse/remove surface; the reads are
 * scoped to the signed-in user this runtime was created for.
 */
export type StartAgentOutbox = {
  /**
   * Reads the user's stored rows. `false` means the read failed: the caller
   * must refuse instead of minting a key over a row whose POST the server may
   * already have accepted.
   */
  whenLoaded: () => Promise<boolean>;
  getStoredOperationKey: (fingerprint: string) => string | null;
  writeSafeRetry: (row: {
    operationKey: string;
    fingerprint: string;
    input: unknown;
  }) => Promise<void>;
  removeOutboxRow: (fingerprint: string) => Promise<void>;
};

// ── Operation key ─────────────────────────────────────────────────────

/**
 * In-process hoisted key, mirroring `useHoistedOperationKey`: one key per
 * intent fingerprint, kept across a retryable failure so a second action run
 * in the same process replays the same key. The persisted safe-retry row is
 * what carries the key across launches.
 */
const intentKeys = new Map<string, string>();

export function getKey(fingerprint: string): string {
  const stored = intentKeys.get(fingerprint);
  if (stored !== undefined) {
    return stored;
  }
  const key = Crypto.randomUUID();
  intentKeys.set(fingerprint, key);
  return key;
}

/** Ends the current intent, so the next submit mints a fresh key. */
export function rotateKey(): void {
  intentKeys.clear();
}

// ── Identity ──────────────────────────────────────────────────────────

/** The signed-in user's id, or null when the response carries none. */
export async function currentUserId(): Promise<string | null> {
  const me = await trpcClient.user.getMe.query();
  return me.id;
}

// ── Model ─────────────────────────────────────────────────────────────

/**
 * The raw persisted model preference, or null when nothing is stored (or the
 * read failed — a missing preference only costs the model fallback, never the
 * start).
 *
 * The read goes through the app's cross-platform entry point for a plain
 * SecureStore read (`secure-store-value.ts`), which the other headless callers
 * use too: `expo-secure-store` exists on iOS and Android alike, so one
 * implementation serves both and this path keeps no per-platform storage
 * branch.
 */
export async function storedModelPreferenceRaw(): Promise<string | null> {
  try {
    return await readStoredValue(AGENT_MODEL_PREFERENCE_KEY);
  } catch {
    return null;
  }
}

/**
 * The model catalogue in the same shape the in-app picker reads, or null when
 * it could not be loaded. Personal scope: an OS-surface run carries no
 * organization, so the personal catalogue is the one the form would show.
 */
export async function modelCatalog(): Promise<ModelOption[] | null> {
  try {
    const token = await getAuthTokenForRequest();
    const response = await fetch(`${API_BASE_URL}/api/openrouter/models`, {
      headers: {
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    if (!response.ok) {
      return null;
    }
    return toModelOptions(OpenRouterModelsResponseSchema.parse(await response.json()));
  } catch {
    return null;
  }
}

// ── Repository ────────────────────────────────────────────────────────

/**
 * The repository of the most recent session, resolved the way the picker
 * resolves its "Recently used" section: a host that is not a known provider
 * is skipped, and a Bitbucket row reports `unsupported` because the create
 * call needs workspace/repository uuids the recent-session row does not
 * carry. Null means there is no usable recent repository.
 */
export async function mostRecentRepository(): Promise<ParsedActionRepository | null> {
  const { repositories } = await trpcClient.cliSessionsV2.recentRepositories.query({
    updatedSince: updatedSinceIso(RECENT_REPOSITORY_DAYS),
  });
  for (const recent of repositories) {
    const parsed = repositoryFromGitUrl(recent.gitUrl);
    if (parsed !== null) {
      return parsed;
    }
  }
  return null;
}

/**
 * The action repository one recent session's git URL names, or null when the
 * row is unusable: a host that is not a known provider is skipped, and a
 * Bitbucket row reports `unsupported` (with the project path, so the refusal
 * can name it) because the create call needs the workspace and repository
 * uuids the recent-session row does not carry.
 */
function repositoryFromGitUrl(gitUrl: string): ParsedActionRepository | null {
  const platform = detectRepositoryPlatform(gitUrl);
  if (platform === undefined) {
    return null;
  }
  if (platform === 'bitbucket') {
    return { kind: 'unsupported', fullName: formatGitUrlProject(gitUrl) };
  }
  const fullName = formatGitUrlProject(gitUrl);
  if (fullName.split('/').filter(Boolean).length < 2) {
    return null;
  }
  return { kind: platform, fullName };
}

/** The start of `days` ago as an ISO timestamp, the recents query's bound. */
function updatedSinceIso(days: number): string {
  const since = new Date();
  since.setDate(since.getDate() - days);
  since.setHours(0, 0, 0, 0);
  return since.toISOString();
}

// ── Safe-retry outbox ─────────────────────────────────────────────────

/**
 * The persisted safe-retry outbox for one user, read once per intent. Mirrors
 * `useMutationOutbox`: a stored row's key is never replaced by a fresh one.
 */
export function createOutbox(userId: string): StartAgentOutbox {
  let rows: OutboxRow[] | null = null;

  return {
    async whenLoaded(): Promise<boolean> {
      rows = await listOutboxRows(userId);
      return rows !== null;
    },
    getStoredOperationKey(fingerprint: string): string | null {
      return storedKeyFor(rows, fingerprint);
    },
    async writeSafeRetry(row): Promise<void> {
      const operationKey = storedKeyFor(rows, row.fingerprint) ?? row.operationKey;
      await writeOutboxRow(userId, { ...row, operationKey, taxonomy: 'safe-retry' });
    },
    async removeOutboxRow(fingerprint): Promise<void> {
      await removeStoredOutboxRow(userId, fingerprint);
    },
  };
}

/** The stored safe-retry key for one fingerprint, or null. */
function storedKeyFor(rows: OutboxRow[] | null, fingerprint: string): string | null {
  const row = rows?.find(
    candidate => candidate.fingerprint === fingerprint && candidate.taxonomy === 'safe-retry'
  );
  return row?.operationKey ?? null;
}
