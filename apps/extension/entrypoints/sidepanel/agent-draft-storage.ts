import { storage } from '#imports';
import { z } from 'zod';

const draftStorageKey = 'local:kiloAgentDrafts';
const draftsSchema = z.record(z.string(), z.string());

let storedDrafts: Record<string, string> = {};
let isHydrated = false;
let hydrateGeneration = 0;
const localWrites = new Map<string, string | undefined>();

const getDraftSnapshot = () => {
  const snapshot = { ...storedDrafts };

  for (const [conversationId, text] of localWrites) {
    if (text === undefined) {
      delete snapshot[conversationId];
    } else {
      snapshot[conversationId] = text;
    }
  }

  return snapshot;
};

const writeDrafts = (): Promise<void> => storage.setItem(draftStorageKey, getDraftSnapshot());

export const hydrateStoredDrafts = async (): Promise<Record<string, string>> => {
  if (!isHydrated) {
    const generation = hydrateGeneration;
    const parsed = draftsSchema.safeParse(await storage.getItem(draftStorageKey));

    // A sign-out cleared the drafts while this read was in flight: its reset wins, so the map it removed must not be restored.
    if (generation !== hydrateGeneration) {
      return {};
    }

    storedDrafts = parsed.success ? parsed.data : {};
    isHydrated = true;
  }

  const snapshot = getDraftSnapshot();

  if (localWrites.size > 0) {
    await writeDrafts();
  }

  return snapshot;
};

export const persistDraft = (conversationId: string, text: string): void => {
  localWrites.set(conversationId, text === '' ? undefined : text);

  if (isHydrated) {
    void writeDrafts();
  }
};

/*
 * Drop every draft, in memory and on disk. Sign-out calls this because
 * conversation ids are deterministic (conversation-1, ...): leaving the module
 * state in place would hand the next account's panel the previous user's
 * unsent message text on its first hydrate.
 */
export const clearStoredDrafts = async (): Promise<void> => {
  hydrateGeneration += 1;
  storedDrafts = {};
  localWrites.clear();
  // The empty state is authoritative; a hydrate must not read the old map back.
  isHydrated = true;

  try {
    await storage.removeItem(draftStorageKey);
  } catch {
    // The in-memory reset above already keeps the drafts from crossing accounts.
  }
};
