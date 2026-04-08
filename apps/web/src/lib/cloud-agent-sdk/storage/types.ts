import type { Part } from '@/types/opencode.gen';
import type { MessageInfo } from '../types';

/**
 * Storage for a single cloud agent session.
 * One instance per session — no sessionId params needed.
 */
type SessionStorage = {
  // Messages (sorted by ID — IDs are time-sortable ascending)
  upsertMessage(info: MessageInfo): void;
  getMessageIds(): string[];
  getMessageInfo(messageId: string): MessageInfo | undefined;

  // Parts (sorted by ID within their message)
  upsertPart(messageId: string, part: Part): void;
  applyPartDelta(messageId: string, partId: string, field: string, delta: string): void;
  deletePart(messageId: string, partId: string): void;
  getParts(messageId: string): readonly Part[];

  // Granular subscriptions
  // Keys: "messageIds", "message:{id}", "parts:{messageId}"
  subscribe(key: string, callback: () => void): () => void;

  // Bulk operations
  clear(): void;

  // Delete a message and all its parts
  deleteMessage(messageId: string): void;
};

/**
 * Storage mutation — the output of the reducer.
 * Applied to storage to update state.
 */
type StorageMutation =
  | { type: 'upsert_message'; info: MessageInfo }
  | { type: 'upsert_part'; messageId: string; part: Part }
  | { type: 'apply_delta'; messageId: string; partId: string; field: string; delta: string }
  | { type: 'delete_part'; messageId: string; partId: string }
  | { type: 'delete_message'; messageId: string };

export type { SessionStorage, StorageMutation };
