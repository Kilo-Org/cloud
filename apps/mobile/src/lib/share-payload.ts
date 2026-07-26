import * as Crypto from 'expo-crypto';
import { cacheDirectory, copyAsync } from 'expo-file-system/legacy';
import { type ShareIntent } from 'expo-share-intent';

import { type AgentAttachmentCandidate } from '@/lib/agent-attachments/use-agent-attachment-upload';

export type ShareId = string;

export type SharePayload = {
  text: string;
  files: AgentAttachmentCandidate[];
};

/** Mirrors PROMPT_INPUT_MAX_CHARS in new-session-prompt.tsx (module-local; composer clamps again). */
export const SHARE_TEXT_MAX_CHARS = 4000;

export const SHARE_PAYLOAD_MAX_ENTRIES = 5;

type ShareIntentLike = Pick<ShareIntent, 'text' | 'webUrl' | 'meta' | 'files'>;

type CopyToCache = (args: { from: string; fileName: string }) => Promise<string>;

const payloads = new Map<ShareId, SharePayload>();
const insertionOrder: ShareId[] = [];

function evictOldestIfNeeded(): void {
  while (payloads.size > SHARE_PAYLOAD_MAX_ENTRIES && insertionOrder.length > 0) {
    const oldest = insertionOrder.shift();
    if (oldest !== undefined) {
      payloads.delete(oldest);
    }
  }
}

/** Adds an entry and returns its id. Evicts oldest beyond SHARE_PAYLOAD_MAX_ENTRIES. */
export function putSharePayload(payload: SharePayload): ShareId {
  const id = Crypto.randomUUID();
  payloads.set(id, payload);
  insertionOrder.push(id);
  evictOldestIfNeeded();
  return id;
}

/** Read-and-delete. Null if `id` is unknown or already consumed. */
export function takeSharePayload(id: ShareId): SharePayload | null {
  const payload = payloads.get(id) ?? null;
  if (payload === null) {
    return null;
  }
  payloads.delete(id);
  const index = insertionOrder.indexOf(id);
  if (index !== -1) {
    insertionOrder.splice(index, 1);
  }
  return payload;
}

/** Read-only, for the gate's own preview. */
export function peekSharePayload(id: ShareId): SharePayload | null {
  return payloads.get(id) ?? null;
}

/** Id-scoped abandonment. Never clears another id's entry. */
export function clearSharePayload(id: ShareId): void {
  if (!payloads.has(id)) {
    return;
  }
  payloads.delete(id);
  const index = insertionOrder.indexOf(id);
  if (index !== -1) {
    insertionOrder.splice(index, 1);
  }
}

/** Test-only: wipe the module store between cases. */
export function __resetSharePayloadStoreForTests(): void {
  payloads.clear();
  insertionOrder.length = 0;
}

export function composeShareText(shareIntent: ShareIntentLike): string {
  let base = (shareIntent.text ?? '').trim();
  if (base === '' && shareIntent.webUrl) {
    base = shareIntent.webUrl;
  }
  const title = shareIntent.meta?.title?.trim();
  if (title && base !== '' && !base.includes(title)) {
    base = `${title}\n${base}`;
  }
  if (base.length > SHARE_TEXT_MAX_CHARS) {
    return base.slice(0, SHARE_TEXT_MAX_CHARS);
  }
  return base;
}

async function defaultCopyToCache(args: { from: string; fileName: string }): Promise<string> {
  const root = cacheDirectory;
  if (!root) {
    throw new Error('cacheDirectory is unavailable');
  }
  const safeName = args.fileName.replaceAll(/[/\\]/g, '_') || 'shared-file';
  const destination = `${root}share-${Crypto.randomUUID()}-${safeName}`;
  await copyAsync({ from: args.from, to: destination });
  return destination;
}

export async function normalizeShareIntent(
  shareIntent: ShareIntentLike,
  copyToCache: CopyToCache = defaultCopyToCache
): Promise<SharePayload> {
  const text = composeShareText(shareIntent);
  const files = await Promise.all(
    (shareIntent.files ?? []).map(async file => {
      const name = file.fileName || 'shared-file';
      const uri = await copyToCache({ from: file.path, fileName: name });
      const candidate: AgentAttachmentCandidate = { name, uri };
      if (file.mimeType) {
        candidate.mimeType = file.mimeType;
      }
      if (file.size != null) {
        candidate.size = file.size;
      }
      return candidate;
    })
  );

  return { text, files };
}
