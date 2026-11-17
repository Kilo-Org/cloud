import type { Part } from '@kilocode/app-shared/opencode';
import type { MessageInfo, ReadonlyPart } from '../types';

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
  upsertPart(messageId: string, part: Part, eventTime?: number, authoritative?: boolean): void;
  /**
   * Append one streamed chunk to a text part, seeding the part when it is not
   * stored yet.
   *
   * An implementation may coalesce: it need not apply the chunk or publish it
   * to `parts:{messageId}` subscribers before this call returns, as long as
   * `getParts` returns the deltas it has already accepted.
   */
  applyPartDelta(messageId: string, partId: string, field: string, delta: string): void;
  deletePart(messageId: string, partId: string): void;
  getParts(messageId: string): readonly ReadonlyPart[];
  /**
   * Look up one stored part by id inside the message. Reading several parts in
   * one pass is `getParts`; this call must never clone part content — an
   * implementation goes through `getParts` when it cannot answer cheaper.
   * Seeing the deltas `applyPartDelta` already accepted is required, matching
   * `getParts`. The returned view aliases storage, including nested values
   * inside the part: copy a field before writing it elsewhere.
   */
  getPart(messageId: string, partId: string): ReadonlyPart | undefined;
  /**
   * Ids of the message's stored parts in storage order, without rebuilding the
   * `getParts` snapshot. Bring-your-own iteration: wrap it in your own
   * dedicated lookup when you need the part itself. Same visibility of already
   * accepted deltas as `getParts`; the array is a copy, safe to iterate while
   * storage mutates.
   */
  getPartIds(messageId: string): readonly string[];

  // Granular subscriptions. Channels: "messageIds", "message:{id}",
  // "parts:{messageId}" (`SessionSubscriptionKey`).
  subscribe(key: SessionSubscriptionKey, callback: () => void): () => void;

  // Bulk operations
  clear(): void;

  // Delete a message and all its parts
  deleteMessage(messageId: string): void;
};

/** Channel of a granular storage subscription. */
type SessionSubscriptionKey = 'messageIds' | `message:${string}` | `parts:${string}`;

/**
 * Storage mutation — the output of the reducer.
 * Applied to storage to update state.
 */
type StorageMutation =
  | { type: 'upsert_message'; info: MessageInfo }
  | { type: 'upsert_part'; messageId: string; part: Part; eventTime?: number | undefined }
  | { type: 'apply_delta'; messageId: string; partId: string; field: string; delta: string }
  | { type: 'delete_part'; messageId: string; partId: string }
  | { type: 'delete_message'; messageId: string };

export type { SessionStorage, SessionSubscriptionKey, StorageMutation };
