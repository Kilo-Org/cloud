import { storage } from '#imports';
import { z } from 'zod';

const draftStorageKey = 'local:kiloAgentDrafts';
const draftsSchema = z.record(z.string(), z.string());

let storedDrafts: Record<string, string> = {};
let isHydrated = false;
const localWrites = new Map<string, string | undefined>();

const getDraftSnapshot = (): Record<string, string> => {
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
    const parsed = draftsSchema.safeParse(await storage.getItem(draftStorageKey));
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
