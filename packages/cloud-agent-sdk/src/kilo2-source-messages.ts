import type { Part, SessionSnapshot } from './types';
import { projectKilo2ShellNotification } from './kilo2-shell-notification';
import {
  kilo2FileContentSchema,
  kilo2PartId,
  type Kilo2Message,
  type Kilo2Session,
} from '@kilocode/session-ingest-contracts';
type ProjectedKilo2Message = SessionSnapshot['messages'][number];

export type Kilo2ContentLayout = { positions: Map<string, number>; next: number };

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

/** Authoritative native attachment positions, never lookalike tool input/metadata. */
export function readKilo2FileReferences(message: Kilo2Message): Kilo2FileReference[] {
  const result: Kilo2FileReference[] = [];
  if (message.type === 'user' || message.type === 'synthetic') {
    for (const [fileIndex, file] of (message.files ?? []).entries()) {
      if (typeof file.data === 'string' || typeof file.uri !== 'string') continue;
      result.push({
        id: kilo2PartId(message.id, fileIndex + 1),
        uri: file.uri,
        mime: file.mime,
        fileIndex,
      });
    }
  }
  const offset = message.type === 'compaction' ? 1 : 0;
  for (const [contentIndex, part] of (message.content ?? []).entries()) {
    if (
      part.type !== 'tool' ||
      !part.state ||
      (part.state.status !== 'completed' && part.state.status !== 'error')
    )
      continue;
    for (const [fileIndex, content] of (part.state.content ?? []).entries()) {
      const file = kilo2FileContentSchema.safeParse(content);
      if (!file.success) continue;
      result.push({
        id: kilo2ToolFileId(message.id, contentIndex + offset, fileIndex),
        uri: file.data.uri,
        mime: file.data.mime,
        fileIndex,
        contentIndex,
      });
    }
  }
  return result;
}

export function hasUnresolvedKilo2Assets(
  message: Kilo2Message,
  assetURLs?: Readonly<Record<string, string>>
): boolean {
  return readKilo2FileReferences(message).some(
    file =>
      assetURLs?.[kilo2AssetKey(file.id, file.uri, file.mime)] === undefined &&
      !/^(data:|https?:\/\/)/.test(file.uri)
  );
}

/**
 * Content positions of one native message, keyed `kind:ordinal`. Text and reasoning
 * events report a per-kind ordinal; the position orders the part in the message.
 */
export function readKilo2ContentLayout(message: Kilo2Message): Kilo2ContentLayout {
  const offset = message.type === 'compaction' ? 1 : 0;
  const ordinals = new Map<string, number>();
  const positions = new Map<string, number>();
  for (const [index, item] of (message.content ?? []).entries()) {
    const ordinal = ordinals.get(item.type) ?? 0;
    ordinals.set(item.type, ordinal + 1);
    positions.set(`${item.type}:${ordinal}`, index + offset);
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
    if (/^(data:|https?:\/\/)/.test(uri)) return uri;
    throw Object.assign(new Error(`Native attachment ${id} requires authorized asset resolution`), {
      code: 'native_asset_unresolved',
    });
  };
  let parentID = '';
  for (const nativeMessage of messages) {
    const message = projectKilo2ShellNotification(nativeMessage);
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
          ...(message.files ?? []).map((file, index): Part => {
            const id = kilo2PartId(message.id, index + 1);
            const uri =
              typeof file.data === 'string'
                ? file.source.type === 'uri' && /^(data:|https?:\/\/)/.test(file.source.uri)
                  ? file.source.uri
                  : `data:${file.mime};base64,${file.data}`
                : typeof file.uri === 'string'
                  ? file.uri
                  : '';
            return {
              ...base,
              id,
              messageID: message.id,
              type: 'file',
              mime: file.mime,
              url: fileURL(id, uri, file.mime),
              ...(file.name === undefined ? {} : { filename: file.name }),
            };
          }),
        ],
      });
      continue;
    }
    const compaction = message.type === 'compaction' && message.status === 'completed';
    if (message.type !== 'assistant' && !compaction) continue;
    const info: SessionSnapshot['messages'][number]['info'] = {
      ...base,
      role: 'assistant',
      time: {
        created: message.time.created,
        ...(compaction || message.time.completed !== undefined
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
      ...(message.error
        ? {
            error: {
              name: message.error.type === 'aborted' ? 'MessageAbortedError' : 'UnknownError',
              data: { message: message.error.message },
            } as const,
          }
        : {}),
    };
    const parts: Part[] = [];
    if (compaction)
      parts.push({
        id: kilo2PartId(message.id, 0),
        messageID: message.id,
        sessionID: session.id,
        type: 'text',
        text: message.summary ?? '',
      });
    const offset = compaction ? 1 : 0;
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
        const attachments: Extract<Part, { type: 'file' }>[] = [];
        if (state.status === 'completed' || state.status === 'error') {
          for (const [fileIndex, content] of (state.content ?? []).entries()) {
            const file = kilo2FileContentSchema.safeParse(content);
            if (!file.success) continue;
            const id = kilo2ToolFileId(message.id, index + offset, fileIndex);
            attachments.push({
              ...base,
              id,
              messageID: message.id,
              type: 'file',
              mime: file.data.mime,
              url: fileURL(id, file.data.uri, file.data.mime),
              ...(file.data.name === undefined ? {} : { filename: file.data.name }),
            });
          }
        }
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
