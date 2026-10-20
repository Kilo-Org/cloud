import {
  normalizeMissingPartText,
  normalizeMissingPatchFiles,
  stripPartContentIfFile,
} from './part-utils';
import type { ChatEvent } from './normalizer';
import type { SessionStorage } from './storage/types';
import { MAX_REMOVAL_VERSIONS, storageVersions } from './storage/versions';
import type { UserMessage, TextPart, Part } from '@kilocode/app-shared/opencode';

type ChatProcessor = {
  process(event: ChatEvent): boolean;
  /**
   * Materialize a synthetic user message from a `cloud.message.queued` server
   * event, unless an authoritative message with the same id already exists.
   * The synthetic message is overwritten when the wrapper later emits the
   * real `message.updated` payload for the same id.
   */
  synthesizeQueuedUserMessage(input: {
    messageId: string;
    sessionId: string;
    content: string | undefined;
  }): void;
};

function acceptVersion(sessionStorage: SessionStorage, event: ChatEvent): boolean {
  const info = event.type === 'message.updated' ? event.info : undefined;
  const part = event.type === 'message.part.updated' ? event.part : undefined;
  const sessionId =
    info?.sessionID ?? part?.sessionID ?? ('sessionId' in event ? event.sessionId : '');
  const messageId = info?.id ?? part?.messageID ?? ('messageId' in event ? event.messageId : '');
  const partId = part?.id ?? ('partId' in event ? event.partId : undefined);
  const messageKey = `${sessionId}\u0000${messageId}`;
  const key = partId === undefined ? messageKey : `${messageKey}\u0000${partId}`;
  let versions = storageVersions.get(sessionStorage);
  if (!versions && !event.version) return true;
  if (!versions) {
    versions = {
      rows: new Map(),
      messages: new Map(),
      removals: new Map(),
      removalFloors: new Map(),
    };
    storageVersions.set(sessionStorage, versions);
  }
  const previous = versions.rows.get(key);
  const removedMessage = versions.rows.get(messageKey);
  const version = event.version;
  const floors = versions.removalFloors.get(sessionId);
  if (!version) return previous === undefined && !removedMessage?.removed && !floors;
  // Evicted tombstones conservatively fence older pages, not newer history reloads.
  if (
    !previous &&
    floors &&
    (version.cursor <= (floors.get(version.sourceId) ?? -1) ||
      (version.eventId === undefined && !floors.has(version.sourceId)))
  ) {
    return false;
  }

  const current =
    event.type === 'message.removed'
      ? (versions.messages.get(messageKey) ?? previous?.version)
      : previous?.version;
  if (current) {
    if (current.sourceId === version.sourceId) {
      if (version.cursor < current.cursor) return false;
      const rowPresent =
        partId === undefined
          ? sessionStorage.getMessageInfo(messageId) !== undefined
          : sessionStorage.getParts(messageId).some(value => value.id === partId);
      if (version.cursor === current.cursor && (previous?.removed || rowPresent)) return false;
    } else if (current.eventId !== undefined && version.eventId === undefined) {
      return false;
    }
  }
  if (partId !== undefined && removedMessage?.removed) {
    if (
      removedMessage.version.sourceId !== version.sourceId ||
      version.cursor <= removedMessage.version.cursor
    )
      return false;
  }
  const row = {
    version,
    removed: event.type === 'message.removed' || event.type === 'message.part.removed',
    messageId,
    sessionId,
  };
  versions.rows.set(key, row);
  versions.removals.delete(key);
  if (row.removed) {
    versions.removals.set(key, row);
    if (versions.removals.size > MAX_REMOVAL_VERSIONS) {
      const oldest = versions.removals.entries().next().value;
      if (oldest) {
        const [oldKey, oldRow] = oldest;
        versions.removals.delete(oldKey);
        versions.rows.delete(oldKey);
        const oldMessageKey = `${oldRow.sessionId}\u0000${oldRow.messageId}`;
        if (
          ![...versions.rows.keys()].some(
            rowKey => rowKey === oldMessageKey || rowKey.startsWith(`${oldMessageKey}\u0000`)
          )
        ) {
          versions.messages.delete(oldMessageKey);
        }
        let sourceFloors = versions.removalFloors.get(oldRow.sessionId);
        if (!sourceFloors) {
          sourceFloors = new Map();
          versions.removalFloors.set(oldRow.sessionId, sourceFloors);
        }
        sourceFloors.set(
          oldRow.version.sourceId,
          Math.max(sourceFloors.get(oldRow.version.sourceId) ?? 0, oldRow.version.cursor)
        );
      }
    }
  }
  const latest = versions.messages.get(messageKey);
  if (!latest || latest.sourceId !== version.sourceId || latest.cursor < version.cursor) {
    versions.messages.set(messageKey, version);
  }
  return true;
}

type ChatProcessorOptions = {
  /**
   * Optional sink for tool attachment bytes, called just before the chat
   * processor strips completed tool part attachment data URLs for storage.
   *
   * - Images (any tool): emitted unchanged.
   * - Non-images: emitted only when `part.tool === 'send_file'`.
   *
   * The callback receives the raw data URL exactly once per processor pass;
   * consumers use it to persist bytes outside the in-memory store (e.g.
   * mobile's file-system cache). Web never passes it, so web behaviour is
   * unchanged. Sink failures are caught and must not interrupt processing.
   */
  onToolAttachment?:
    | ((partId: string, attachment: { mime: string; filename?: string; dataUrl: string }) => void)
    | undefined;
  /**
   * Optional sink for top-level file part URLs, called just before the chat
   * processor strips a file part's `url` and `source.text` for storage.
   * Receives the raw URL exactly once per processor pass; consumers use it to
   * preview the file later (e.g. mobile). Web never passes it, so web
   * behaviour is unchanged. Sink failures are caught and must not interrupt
   * processing.
   */
  onFilePart?:
    | ((partId: string, file: { mime: string; filename?: string; url: string }) => void)
    | undefined;
};

function hasTextField(part: { text?: string } | unknown): part is { text: string } {
  return typeof part === 'object' && part !== null && 'text' in part;
}

function isSyntheticPart(part: unknown): boolean {
  return (
    typeof part === 'object' && part !== null && 'synthetic' in part && part.synthetic === true
  );
}

function emitToolAttachmentsBeforeStrip(
  part: Part,
  onToolAttachment: NonNullable<ChatProcessorOptions['onToolAttachment']>
): void {
  if (part.type !== 'tool') return;
  const toolPart = part;
  if (toolPart.state.status !== 'completed' || !toolPart.state.attachments) return;

  for (const attachment of toolPart.state.attachments) {
    const isImage = attachment.mime.startsWith('image/');
    if (!isImage && toolPart.tool !== 'send_file') continue;
    if (attachment.url === '') continue;
    try {
      onToolAttachment(toolPart.id, {
        mime: attachment.mime,
        ...(attachment.filename ? { filename: attachment.filename } : {}),
        dataUrl: attachment.url,
      });
    } catch {
      // Sink failures must not break chat processing.
    }
  }
}

function emitFilePartBeforeStrip(
  part: Part,
  onFilePart: NonNullable<ChatProcessorOptions['onFilePart']>
): void {
  if (part.type !== 'file') return;
  if (part.url === '') return;
  try {
    onFilePart(part.id, {
      mime: part.mime,
      ...(part.filename ? { filename: part.filename } : {}),
      url: part.url,
    });
  } catch {
    // Sink failures must not break chat processing.
  }
}

function createChatProcessor(
  sessionStorage: SessionStorage,
  options?: ChatProcessorOptions
): ChatProcessor {
  return {
    process(event) {
      if (!acceptVersion(sessionStorage, event)) return false;
      switch (event.type) {
        case 'message.updated':
          sessionStorage.upsertMessage(event.info);
          break;
        case 'message.part.updated': {
          // Normalize BEFORE the strip/guard logic: the wire can omit `text` on
          // text/reasoning parts (KILO-APP-99) and `files` on patch parts
          // (KILO-APP-BZ), and the empty-text guard below must also see
          // textless updates so they cannot clobber already streamed text.
          // Identity-preserving for everything else.
          const normalized = normalizeMissingPatchFiles(normalizeMissingPartText(event.part));
          const textOmitted =
            event.textOmitted === true ||
            ((event.part.type === 'text' || event.part.type === 'reasoning') &&
              typeof event.part.text !== 'string');
          if (options?.onToolAttachment) {
            emitToolAttachmentsBeforeStrip(normalized, options.onToolAttachment);
          }
          if (options?.onFilePart) {
            emitFilePartBeforeStrip(normalized, options.onFilePart);
          }
          let stripped = stripPartContentIfFile(normalized);
          if (
            (!event.version || textOmitted) &&
            hasTextField(stripped) &&
            stripped.text === '' &&
            !isSyntheticPart(stripped)
          ) {
            const existingParts = sessionStorage.getParts(stripped.messageID);
            const existing = existingParts.find(p => p.id === stripped.id);
            if (existing && hasTextField(existing) && existing.text.length > 0) {
              if (!event.version) break;
              stripped = { ...stripped, text: existing.text };
            }
          }
          sessionStorage.upsertPart(
            stripped.messageID,
            stripped,
            event.time,
            event.version !== undefined
          );
          break;
        }
        case 'message.part.delta':
          sessionStorage.applyPartDelta(event.messageId, event.partId, event.field, event.delta);
          break;
        case 'message.part.removed':
          sessionStorage.deletePart(event.messageId, event.partId);
          break;
        // The CLI drops messages it no longer serves (compaction scaffolding,
        // reverted turns). Keep the local store in step with the durable
        // transcript so a removed message cannot keep supplying state — e.g. a
        // context reading — that a reopened session no longer has.
        case 'message.removed':
          sessionStorage.deleteMessage(event.messageId);
          break;
      }
      return true;
    },

    synthesizeQueuedUserMessage({ messageId, sessionId, content }) {
      // Empty or missing content can't form a renderable user message; wait for
      // the authoritative `message.updated` payload from the wrapper instead.
      if (!content) return;
      if (sessionStorage.getMessageInfo(messageId)) return;

      // Same unconfirmed marker as the optimistic send-time row: the
      // authoritative `message.updated` for this id replaces the info (role and
      // synthetic flag) and its non-synthetic parts drop this placeholder part
      // (`upsertPartDroppingStaleSyntheticParts`), so a confirmed record wins
      // the role and the parts.
      const syntheticMessage: UserMessage = {
        id: messageId,
        sessionID: sessionId,
        role: 'user',
        time: { created: Date.now() },
        agent: '',
        model: { providerID: '', modelID: '' },
        synthetic: true,
      };
      sessionStorage.upsertMessage(syntheticMessage);

      const syntheticPart: TextPart = {
        id: `${messageId}-text`,
        sessionID: sessionId,
        messageID: messageId,
        type: 'text',
        text: content,
        synthetic: true,
      };
      sessionStorage.upsertPart(messageId, syntheticPart);
    },
  };
}

export { createChatProcessor };
export type { ChatProcessor, ChatProcessorOptions };
