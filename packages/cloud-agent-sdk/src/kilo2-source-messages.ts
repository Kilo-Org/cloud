import type { Part, SessionSnapshot, TextPart } from './types';
import { projectKilo2Notification } from './kilo2-notification';
import {
  kilo2FileContentSchema,
  kilo2PartId,
  type Kilo2Message,
  type Kilo2Session,
} from '@kilocode/session-ingest-contracts';
export type ProjectedKilo2Message = SessionSnapshot['messages'][number];

export function isCompactionSummaryPart(
  part: Part
): part is TextPart & { metadata: { compactionSummary: true } } {
  return part.type === 'text' && part.metadata?.['compactionSummary'] === true;
}

/** Inline bytes are the only URI a display may build without authorization. */
function isInlineDataUri(uri: string): boolean {
  return uri.startsWith('data:');
}

export type Kilo2ContentLayout = { positions: Map<string, number>; next: number };

/** The only spelling of a native content-layout key. */
export function kilo2ContentLayoutKey(kind: string, ordinal: number): string {
  return `${kind}:${ordinal}`;
}

export type Kilo2ProjectionOptions = {
  /** Authorized bytes, keyed by kilo2AssetKey; never credential-bearing URLs. */
  assetURLs?: Readonly<Record<string, string>> | undefined;
};

/** Stable identity for a file returned inside one native tool content part. */
export function kilo2ToolFileId(
  messageID: string,
  contentIndex: number,
  fileIndex: number
): string {
  return `${kilo2PartId(messageID, contentIndex)}_file_${fileIndex}`;
}

/**
 * Recovers the native content position from a display part id built by `kilo2PartId`
 * (or `kilo2ToolFileId`); the single decoder for that format.
 */
export function kilo2PartPosition(messageId: string, partId: string): number | undefined {
  const prefix = `${messageId}_`;
  if (!partId.startsWith(prefix)) return undefined;
  const suffix = partId.slice(prefix.length);
  // Tool-result files are derivative attachments of a native content position.
  if (!/^\d{6}(?:_file_\d+)?$/.test(suffix)) return undefined;
  return Number(suffix.slice(0, 6));
}

/** Display id of the file attachment at `fileIndex` of a user/synthetic message. */
export function kilo2MessageFileId(messageID: string, fileIndex: number): string {
  return kilo2PartId(messageID, fileIndex + 1);
}

/** Bind resolved bytes to both display identity and the exact native reference. */
export function kilo2AssetKey(fileID: string, uri: string, mime: string): string {
  return JSON.stringify([fileID, uri, mime]);
}

export type Kilo2FileReference = {
  id: string;
  uri: string;
  mime: string;
  fileIndex: number;
  contentIndex?: number;
};

/**
 * A compaction message reserves content position 0 for its marker, so its native
 * content starts at 1. Every id and layout derived from native content reads this.
 */
export function nativeContentOffset(message: Kilo2Message): 0 | 1 {
  return message.type === 'compaction' ? 1 : 0;
}

type Kilo2NativeContent = NonNullable<Kilo2Message['content']>[number];

/** The fields of one native tool-result file that display needs. */
type Kilo2ToolFile = { uri: string; mime: string; name: string | undefined };

/**
 * The files one native tool content part yields for display. Only a settled call
 * (`completed`/`error`) carries results, and content that does not parse as a file is
 * not an attachment.
 */
function kilo2ToolContentFiles(
  part: Kilo2NativeContent
): { fileIndex: number; file: Kilo2ToolFile }[] {
  if (
    part.type !== 'tool' ||
    !part.state ||
    (part.state.status !== 'completed' && part.state.status !== 'error')
  )
    return [];
  const files: { fileIndex: number; file: Kilo2ToolFile }[] = [];
  for (const [fileIndex, content] of (part.state.content ?? []).entries()) {
    const file = kilo2FileContentSchema.safeParse(content);
    if (!file.success) continue;
    files.push({
      fileIndex,
      file: { uri: file.data.uri, mime: file.data.mime, name: file.data.name },
    });
  }
  return files;
}

/** Authoritative native attachment positions, never lookalike tool input/metadata. */
export function readKilo2FileReferences(message: Kilo2Message): Kilo2FileReference[] {
  const result: Kilo2FileReference[] = [];
  if (message.type === 'user' || message.type === 'synthetic') {
    for (const [fileIndex, file] of (message.files ?? []).entries()) {
      // Empty bytes are absent bytes, so such a file is still a reference position.
      // A file with inline bytes is not: `readKilo2Messages` renders those bytes
      // directly, so no authorization — and no reference — is needed for them.
      const hasBytes = typeof file.data === 'string' && file.data !== '';
      if (hasBytes || typeof file.uri !== 'string') continue;
      result.push({
        id: kilo2MessageFileId(message.id, fileIndex),
        uri: file.uri,
        mime: file.mime,
        fileIndex,
      });
    }
  }
  const offset = nativeContentOffset(message);
  for (const [contentIndex, part] of (message.content ?? []).entries()) {
    for (const { fileIndex, file } of kilo2ToolContentFiles(part)) {
      result.push({
        id: kilo2ToolFileId(message.id, contentIndex + offset, fileIndex),
        uri: file.uri,
        mime: file.mime,
        fileIndex,
        contentIndex,
      });
    }
  }
  return result;
}

/**
 * The recovery queue: references a later snapshot can still authorize, so recovery
 * keeps waiting on them. Only `media:` and workspace-relative references qualify —
 * inline bytes already display, and an absolute remote reference never receives a
 * mapping, so recovery must never chase either.
 */
export function hasUnresolvedKilo2Assets(
  message: Kilo2Message,
  assetURLs?: Readonly<Record<string, string>>
): boolean {
  return readKilo2FileReferences(message).some(
    file =>
      assetURLs?.[kilo2AssetKey(file.id, file.uri, file.mime)] === undefined &&
      !isInlineDataUri(file.uri) &&
      !/^https?:\/\//.test(file.uri)
  );
}

/**
 * The rendering gate for the current context: this reference has no authorized entry
 * and no inline bytes, so it has no display with the authorization available now. It
 * is not a claim of permanence — a later snapshot still authorizes an unmapped
 * `media:` reference. Contrast `hasUnresolvedKilo2Assets`, the recovery queue: every
 * reference in that queue is also undisplayable, while this set additionally holds
 * references no authorization can ever bind (absolute `http(s)` references).
 */
export function hasUndisplayableKilo2Assets(
  message: Kilo2Message,
  assetURLs?: Readonly<Record<string, string>>
): boolean {
  return readKilo2FileReferences(message).some(
    file =>
      assetURLs?.[kilo2AssetKey(file.id, file.uri, file.mime)] === undefined &&
      !isInlineDataUri(file.uri)
  );
}

/**
 * Content positions of one native message, keyed `kind:ordinal`. Text and reasoning
 * events report a per-kind ordinal; the position orders the part in the message.
 */
export function readKilo2ContentLayout(message: Kilo2Message): Kilo2ContentLayout {
  const offset = nativeContentOffset(message);
  const ordinals = new Map<string, number>();
  const positions = new Map<string, number>();
  for (const [index, item] of (message.content ?? []).entries()) {
    const ordinal = ordinals.get(item.type) ?? 0;
    ordinals.set(item.type, ordinal + 1);
    positions.set(kilo2ContentLayoutKey(item.type, ordinal), index + offset);
  }
  return { positions, next: (message.content?.length ?? 0) + offset };
}

/** Project native v2 messages once, for both Cloud history and live observation. */
export function readKilo2Messages(
  session: Kilo2Session,
  messages: Kilo2Message[],
  options: Kilo2ProjectionOptions = {}
): ProjectedKilo2Message[] {
  const result: ProjectedKilo2Message[] = [];
  const fileURL = (id: string, uri: string, mime: string): string => {
    const resolved = options.assetURLs?.[kilo2AssetKey(id, uri, mime)];
    if (resolved !== undefined) return resolved;
    if (isInlineDataUri(uri)) return uri;
    throw Object.assign(new Error(`Native attachment ${id} requires authorized asset resolution`), {
      code: 'native_asset_unresolved',
    });
  };
  let parentID = '';
  for (const nativeMessage of messages) {
    const message = projectKilo2Notification(nativeMessage);
    const base = { id: message.id, sessionID: session.id };
    const model = message.model ?? session.model;
    const agent = message.agent ?? session.agent ?? 'build';
    if (message.type === 'user' || message.type === 'synthetic') {
      parentID = message.id;
      result.push({
        info: {
          ...base,
          role: 'user',
          time: message.time,
          agent,
          model: { providerID: model?.providerID ?? 'kilo', modelID: model?.id ?? '' },
          ...(model?.variant === undefined ? {} : { variant: model.variant }),
        },
        parts: [
          {
            ...base,
            id: kilo2PartId(message.id, 0),
            messageID: message.id,
            type: 'text',
            text: message.text ?? '',
            ...(message.type === 'synthetic' ? { synthetic: true } : {}),
          },
          ...(message.files ?? []).flatMap((file, index): Part[] => {
            const id = kilo2MessageFileId(message.id, index);
            // Empty bytes are absent bytes: a `data:` url of nothing would be a
            // zero-byte file. Bytes win; then an inline source uri; then a reference
            // the authorization gate may still accept; otherwise emit no part.
            // This diverges from `readKilo2FileReferences` on purpose: that enumerator
            // lists only references that need authorization, so a file with inline
            // bytes is no reference there, while this projection still renders it.
            const uri =
              typeof file.data === 'string' && file.data !== ''
                ? `data:${file.mime};base64,${file.data}`
                : file.source.type === 'uri' && isInlineDataUri(file.source.uri)
                  ? file.source.uri
                  : typeof file.uri === 'string'
                    ? file.uri
                    : undefined;
            if (uri === undefined) return [];
            // A reference without authorization keeps the projector's throwing contract;
            // empty bytes are the one absent case, and they emit no part rather than a
            // zero-byte one. Every call site gates the message before it reaches here.
            const url =
              file.data === ''
                ? isInlineDataUri(uri)
                  ? uri
                  : (options.assetURLs?.[kilo2AssetKey(id, uri, file.mime)] ?? undefined)
                : fileURL(id, uri, file.mime);
            if (url === undefined) return [];
            return [
              {
                ...base,
                id,
                messageID: message.id,
                type: 'file',
                mime: file.mime,
                url,
                ...(file.name === undefined ? {} : { filename: file.name }),
              },
            ];
          }),
        ],
      });
      continue;
    }
    const compaction = message.type === 'compaction';
    if (message.type !== 'assistant' && !compaction) continue;
    const compactionEnded =
      compaction && (message.status === 'completed' || message.status === 'failed');
    const error =
      message.error ??
      (compaction && message.status === 'failed'
        ? { type: 'unknown', message: 'Context compaction failed' }
        : undefined);
    const info: SessionSnapshot['messages'][number]['info'] = {
      ...base,
      role: 'assistant',
      time: {
        created: message.time.created,
        ...(compactionEnded || message.time.completed !== undefined
          ? { completed: message.time.completed ?? message.time.created }
          : {}),
      },
      parentID,
      agent,
      mode: agent,
      modelID: model?.id ?? '',
      providerID: model?.providerID ?? 'kilo',
      ...(model?.variant === undefined ? {} : { variant: model.variant }),
      path: { cwd: session.location.directory, root: session.location.directory },
      cost: message.cost ?? 0,
      tokens: message.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      ...(message.finish ? { finish: message.finish } : {}),
      ...(compaction ? { summary: true } : {}),
      // A stopped turn is an interruption, not a failure, as v1 reports it.
      ...(error
        ? {
            error: {
              name: error.type === 'aborted' ? 'MessageAbortedError' : 'UnknownError',
              data: { message: error.message },
            } as const,
          }
        : {}),
    };
    const parts: Part[] = [];
    if (compaction) {
      parts.push({
        id: kilo2PartId(message.id, 0),
        messageID: message.id,
        sessionID: session.id,
        type: 'compaction',
        auto: message['reason'] === 'auto',
      });
      // The summary is outside native content; do not shift streamed content IDs.
      // Use the same completion signal as the transcript's completed state.
      if (info.time.completed !== undefined && !error && message.summary?.trim())
        parts.push({
          id: `${kilo2PartId(message.id, 0)}_summary`,
          messageID: message.id,
          sessionID: session.id,
          type: 'text',
          text: message.summary,
          metadata: { compactionSummary: true },
        });
    }
    const offset = nativeContentOffset(message);
    for (const [index, item] of (message.content ?? []).entries()) {
      const identity = {
        id: kilo2PartId(message.id, index + offset),
        messageID: message.id,
        sessionID: session.id,
      };
      if (item.type === 'text') parts.push({ ...identity, type: 'text', text: item.text ?? '' });
      else if (item.type === 'reasoning')
        parts.push({
          ...identity,
          type: 'reasoning',
          text: item.text ?? '',
          time: {
            start: item.time?.created ?? message.time.created,
            ...(item.time?.completed === undefined ? {} : { end: item.time.completed }),
          },
        });
      else if (item.type === 'tool' && item.id && item.name && item.state) {
        const state = item.state;
        const start = item.time?.ran ?? item.time?.created ?? message.time.created;
        const nativeInput = typeof state.input === 'string' ? {} : state.input;
        const nativeMetadata = state.metadata ?? {};
        // The shared task card uses v1 field names. Keep these aliases in the
        // display model so native messages remain intact for history and replay.
        const input =
          item.name === 'subagent' && typeof nativeInput['agent'] === 'string'
            ? { ...nativeInput, subagent_type: nativeInput['agent'] }
            : nativeInput;
        const metadata =
          item.name === 'subagent' && typeof nativeMetadata['sessionID'] === 'string'
            ? { ...nativeMetadata, sessionId: nativeMetadata['sessionID'] }
            : nativeMetadata;
        const tool = {
          ...identity,
          type: 'tool' as const,
          callID: item.id,
          tool: item.name === 'shell' ? 'bash' : item.name === 'subagent' ? 'task' : item.name,
        };
        const attachments = kilo2ToolContentFiles(item).map(({ fileIndex, file }) => {
          const id = kilo2ToolFileId(message.id, index + offset, fileIndex);
          return {
            ...base,
            id,
            messageID: message.id,
            type: 'file' as const,
            mime: file.mime,
            url: fileURL(id, file.uri, file.mime),
            ...(file.name === undefined ? {} : { filename: file.name }),
          };
        });
        if (state.status === 'streaming')
          parts.push({
            ...tool,
            state: {
              status: 'pending',
              input,
              raw: typeof state.input === 'string' ? state.input : '',
            },
          });
        else if (state.status === 'running')
          parts.push({ ...tool, state: { status: 'running', input, metadata, time: { start } } });
        else if (state.status === 'completed')
          parts.push({
            ...tool,
            // A Cloud preview marks its shortened native entry; keep the marker on
            // the display part so the complete call can be read on expansion.
            ...(item['cloudDetail'] === undefined ? {} : { cloudDetail: item['cloudDetail'] }),
            state: {
              status: 'completed',
              input,
              metadata,
              title: item.name,
              output: (state.content ?? [])
                .flatMap(part => (part.text === undefined ? [] : [part.text]))
                .join('\n'),
              time: { start, end: item.time?.completed ?? start },
            },
          });
        else
          parts.push({
            ...tool,
            state: {
              status: 'error',
              input,
              metadata,
              error: state.error?.message ?? 'Tool failed',
              time: { start, end: item.time?.completed ?? start },
            },
          });
        // One display authority for native files: specialized tool cards need
        // not handle attachments, and ordinary FileParts avoid duplicate images.
        parts.push(...attachments);
      }
    }
    result.push({ info, parts });
  }
  return result;
}

/**
 * Project one native message for display, with the guard both the live reader and the
 * history page need: a message that can never display returns nothing, and a projection
 * failure degrades this message instead of failing the surrounding batch or page.
 */
export function projectKilo2Message(
  session: Kilo2Session,
  message: Kilo2Message,
  parentID?: string
): ProjectedKilo2Message | undefined {
  if (hasUndisplayableKilo2Assets(message)) return undefined;
  let display: ProjectedKilo2Message | undefined;
  try {
    display = readKilo2Messages(session, [message])[0];
  } catch (error) {
    console.error(`[ConversationSource] Native message ${message.id} projection failed:`, error);
  }
  if (display?.info.role === 'assistant' && parentID !== undefined)
    display.info.parentID = parentID;
  return display;
}
